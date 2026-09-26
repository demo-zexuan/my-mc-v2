/**
 * Structured logging facade.
 *
 * I. Why a facade instead of calling `console` directly
 *
 * 1. The render loop runs at 60+ Hz; an unconditional `console.debug` inside it
 *    becomes a measurable frame-time cost. The facade allows the debug channel
 *    to be switched off in production builds without touching call sites.
 * 2. Browser automation (Playwright) asserts on console errors. Routing every
 *    message through one place makes the "no severe console error" quality gate
 *    meaningful instead of noisy.
 *
 * @module utils/logger
 */

/** Severity ordered from most to least verbose. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Prefix per level so that log lines stay greppable in the browser console. */
const LEVEL_PREFIX: Readonly<Record<Exclude<LogLevel, 'silent'>, string>> = {
  debug: '[debug]',
  info: '[info]',
  warn: '[warn]',
  error: '[error]',
};

export interface LoggerOptions {
  /** Minimum level that is actually emitted. Defaults to `info`. */
  readonly level?: LogLevel;
  /** Namespace shown between the level prefix and the message, e.g. `chunk`. */
  readonly scope?: string;
}

export class Logger {
  #minWeight: number;
  #scope: string;

  public constructor(options: LoggerOptions = {}) {
    this.#minWeight = LEVEL_WEIGHT[options.level ?? 'info'];
    this.#scope = options.scope ?? '';
  }

  /** Returns a new logger sharing the level but carrying a nested scope. */
  public child(scope: string): Logger {
    const next = new Logger({ scope: this.#scope === '' ? scope : `${this.#scope}:${scope}` });
    next.#minWeight = this.#minWeight;
    return next;
  }

  /** Changes the threshold in place; used by the settings screen. */
  public setLevel(level: LogLevel): void {
    this.#minWeight = LEVEL_WEIGHT[level];
  }

  public debug(message: string, ...details: readonly unknown[]): void {
    this.#emit('debug', message, details);
  }

  public info(message: string, ...details: readonly unknown[]): void {
    this.#emit('info', message, details);
  }

  public warn(message: string, ...details: readonly unknown[]): void {
    this.#emit('warn', message, details);
  }

  public error(message: string, ...details: readonly unknown[]): void {
    this.#emit('error', message, details);
  }

  #emit(level: Exclude<LogLevel, 'silent'>, message: string, details: readonly unknown[]): void {
    if (LEVEL_WEIGHT[level] < this.#minWeight) {
      return;
    }
    const label =
      this.#scope === '' ? LEVEL_PREFIX[level] : `${LEVEL_PREFIX[level]}[${this.#scope}]`;
    const line = `${label} ${message}`;

    // I. Route to the matching console method.
    // 1. `warn`/`error` survive the ESLint console allowance in this file.
    // 2. `debug`/`info` are allowed here because this module *is* the single
    //    sanctioned console boundary of the application.
    /* eslint-disable no-console */
    if (level === 'error') {
      console.error(line, ...details);
    } else if (level === 'warn') {
      console.warn(line, ...details);
    } else if (level === 'debug') {
      console.debug(line, ...details);
    } else {
      console.info(line, ...details);
    }
    /* eslint-enable no-console */
  }
}

/**
 * Application-wide logger.
 *
 * A single shared instance is intentional: log configuration must be applied
 * once from the boot sequence. Game systems should still prefer
 * `logger.child('chunk')` so that the origin of a message is obvious.
 */
export const logger = new Logger({ level: import.meta.env.DEV ? 'debug' : 'info' });
