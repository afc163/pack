

import chalk from 'chalk';
import * as readline from 'readline';
import stripAnsi from 'strip-ansi';
import { inspect } from 'util';
import { removeSuffix } from '../../util/misc.js';
import BaseReporter, { ReporterOptions } from '../base-reporter.js';
import { FormatKeys, Formatter } from '../format.js';
import { Package, ReporterSetSpinner, ReporterSpinner, ReporterSpinnerSet, Trees } from '../types.js';
import { getFormattedOutput, recurseTree, sortTrees } from './helpers/tree-helper.js';
import Progress from './progress-bar.js';
import Spinner from './spinner-progress.js';
import { clearLine } from './util.js';


const AUDIT_COL_WIDTHS = [15, 62];

const auditSeverityColors = {
  info: chalk.bold,
  low: chalk.bold,
  moderate: chalk.yellow,
  high: chalk.red,
  critical: chalk.bgRed,
};

type Row = Array<string>;

// fixes bold on windows
if (process.platform === 'win32' && !(process.env.TERM && /^xterm/i.test(process.env.TERM))) {
  // @ts-ignore
  chalk.bold._styles[0].close += '\u001b[m';
}

export default class ConsoleReporter extends BaseReporter {

  _lastCategorySize: number;
  _progressBar?: Progress;
  _spinners: Set<Spinner>;

  constructor(opts: ReporterOptions) {
    super(opts);

    this._lastCategorySize = 0;
    this._spinners = new Set();
    this.format = chalk as any as Formatter;
    this.format.stripColor = stripAnsi;
    this.isSilent = !!opts.isSilent;
  }

  _prependEmoji(msg: string, emoji?: string): string {
    if (this.emoji && emoji && this.isTTY) {
      msg = `${emoji}  ${msg}`;
    }
    return msg;
  }

  _logCategory(category: string, color: FormatKeys, msg: string) {
    this._lastCategorySize = category.length;
    this._log(`${this.format[color](category)} ${msg}`);
  }

  _verbose(msg: string) {
    this._logCategory('verbose', 'grey', `${process.uptime()} ${msg}`);
  }

  _verboseInspect(obj: any) {
    this.inspect(obj);
  }

  close() {
    for (const spinner of this._spinners) {
      spinner.stop();
    }
    this._spinners.clear();
    this.stopProgress();
    super.close();
  }

  table(head: Array<string>, body: Array<Row>) {
    //
    head = head.map((field: string): string => this.format.underline(field));

    //
    const rows = [head].concat(body);

    // get column widths
    const cols: Array<number> = [];
    for (let i = 0; i < head.length; i++) {
      const widths = rows.map((row: Row): number => this.format.stripColor(row[i]).length);
      cols[i] = Math.max(...widths);
    }

    //
    const builtRows = rows.map((row: Row): string => {
      for (let i = 0; i < row.length; i++) {
        const field = row[i];
        const padding = cols[i] - this.format.stripColor(field).length;

        row[i] = field + ' '.repeat(padding);
      }
      return row.join(' ');
    });

    this.log(builtRows.join('\n'));
  }

  step(current: number, total: number, msg: string, emoji?: string) {
    msg = this._prependEmoji(msg, emoji);

    if (msg.endsWith('?')) {
      msg = `${removeSuffix(msg, '?')}...?`;
    } else {
      msg += '...';
    }
    this.log(`${this.format.dim(`[${current}/${total}]`)} ${msg}`);
  }

  inspect(value: any) {
    if (typeof value !== 'number' && typeof value !== 'string') {
      value = inspect(value, {
        breakLength: 0,
        colors: this.isTTY,
        depth: null,
        maxArrayLength: null,
      });
    }

    this.log(String(value), {force: true});
  }

  list(key: string, items: Array<string>, hints?: Object) {
    const gutterWidth = (this._lastCategorySize || 2) - 1;

    if (hints) {
      for (const item of items) {
        this._log(`${' '.repeat(gutterWidth)}- ${this.format.bold(item)}`);
        this._log(`  ${' '.repeat(gutterWidth)} ${hints[item]}`);
      }
    } else {
      for (const item of items) {
        this._log(`${' '.repeat(gutterWidth)}- ${item}`);
      }
    }
  }

  header(pkg: Package) {
    this.log(this.format.bold(`${pkg.name} v${pkg.version}`));
  }

  footer(showPeakMemory?: boolean) {
    this.stopProgress();

    const totalTime = (this.getTotalTime() / 1000).toFixed(2);
    let msg = `Done in ${totalTime}s.`;
    if (showPeakMemory) {
      const peakMemory = (this.peakMemory / 1024 / 1024).toFixed(2);
      msg += ` Peak memory usage ${peakMemory}MB.`;
    }
    this.log(this._prependEmoji(msg, '✨'));
  }

  log(msg: string, {force = false}: {force?: boolean} = {}) {
    this._lastCategorySize = 0;
    this._log(msg, {force});
  }

  _log(msg: string, {force = false}: {force?: boolean} = {}) {
    if (this.isSilent && !force) {
      return;
    }
    clearLine(this.stdout);
    this.stdout.write(`${msg}\n`);
  }

  success(msg: string) {
    this._logCategory('success', 'green', msg);
  }

  error(msg: string) {
    clearLine(this.stderr);
    this.stderr.write(`${this.format.red('error')} ${msg}\n`);
  }

  info(msg: string) {
    this._logCategory('info', 'blue', msg);
  }

  command(command: string) {
    this.log(this.format.dim(`$ ${command}`));
  }

  warn(msg: string) {
    clearLine(this.stderr);
    this.stderr.write(`${this.format.yellow('warning')} ${msg}\n`);
  }

  // handles basic tree output to console
  tree(key: string, trees: Trees, {force = false}: {force?: boolean} = {}) {
    this.stopProgress();
    //
    if (this.isSilent && !force) {
      return;
    }
    const output = ({name, children, hint, color}, titlePrefix, childrenPrefix) => {
      const formatter = this.format;
      const out = getFormattedOutput({
        prefix: titlePrefix,
        hint,
        color,
        name,
        formatter,
      });
      this.stdout.write(out);

      if (children && children.length) {
        recurseTree(sortTrees(children), childrenPrefix, output);
      }
    };
    recurseTree(sortTrees(trees), '', output);
  }

  activitySet(total: number, workers: number): ReporterSpinnerSet {
    if (!this.isTTY || this.noProgress) {
      return super.activitySet(total, workers);
    }

    const spinners: Array<ReporterSetSpinner> = [];
    const reporterSpinners = this._spinners;

    for (let i = 1; i < workers; i++) {
      this.log('');
    }

    for (let i = 0; i < workers; i++) {
      const spinner = new Spinner(this.stderr, i);
      reporterSpinners.add(spinner);
      spinner.start();

      let prefix: string | null = null;
      let current = 0;
      const updatePrefix = () => {
        spinner.setPrefix(`${this.format.dim(`[${current === 0 ? '-' : current}/${total}]`)} `);
      };
      const clear = () => {
        prefix = null;
        current = 0;
        updatePrefix();
        spinner.setText('waiting...');
      };
      clear();

      spinners.unshift({
        clear,

        setPrefix(_current: number, _prefix: string) {
          current = _current;
          prefix = _prefix;
          spinner.setText(prefix);
          updatePrefix();
        },

        tick(msg: string) {
          if (prefix) {
            msg = `${prefix}: ${msg}`;
          }
          spinner.setText(msg);
        },

        end() {
          spinner.stop();
          reporterSpinners.delete(spinner);
        },
      });
    }

    return {
      spinners,
      end: () => {
        for (const spinner of spinners) {
          spinner.end();
        }
        readline.moveCursor(this.stdout, 0, -workers + 1);
      },
    };
  }

  activity(): ReporterSpinner {
    if (!this.isTTY) {
      return {
        tick() {},
        end() {},
      };
    }
    const reporterSpinners = this._spinners;

    const spinner = new Spinner(this.stderr);
    spinner.start();

    reporterSpinners.add(spinner);

    return {
      tick(name: string) {
        spinner.setText(name);
      },

      end() {
        spinner.stop();
        reporterSpinners.delete(spinner);
      },
    };
  }


  progress(count: number): () => void {
    if (this.noProgress || count <= 0) {
      return function() {
        // noop
      };
    }

    if (!this.isTTY) {
      return function() {
        // TODO what should the behaviour here be? we could buffer progress messages maybe
      };
    }

    // Clear any potentially old progress bars
    this.stopProgress();

    const bar = (this._progressBar = new Progress(count, this.stderr, (progress: Progress) => {
      if (progress === this._progressBar) {
        this._progressBar = null;
      }
    }));

    bar.render();

    return function() {
      bar.tick();
    };
  }

  stopProgress() {
    if (this._progressBar) {
      this._progressBar.stop();
    }
  }
}
