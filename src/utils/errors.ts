/**
 * Typed application errors.
 *
 * I. Why a dedicated error type
 *
 * 1. The brief requires graceful handling of a hostile environment (no WebGL,
 *    blocked storage, failed workers). A `code` makes the recovering layer able
 *    to branch on the failure without string matching on messages.
 * 2. `userMessage` is written for players, `message` for developers. Keeping
 *    both prevents the classic mistake of showing a stack trace on screen.
 *
 * @module utils/errors
 */

/** Machine readable failure categories. */
export type AppErrorCode =
  | 'WEBGL_UNAVAILABLE'
  | 'RENDERER_INIT_FAILED'
  | 'ASSET_LOAD_FAILED'
  | 'WORKER_UNAVAILABLE'
  | 'AUDIO_INIT_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'SAVE_CORRUPTED'
  | 'SAVE_VERSION_UNSUPPORTED'
  | 'WORLD_GENERATION_FAILED'
  | 'UNKNOWN';

export interface AppErrorOptions {
  /** Message shown to the player; falls back to a per-code default. */
  readonly userMessage?: string;
  /** Original error, preserved for the console and for bug reports. */
  readonly cause?: unknown;
  /** Extra context attached for debugging; never shown as the primary text. */
  readonly context?: Readonly<Record<string, unknown>>;
}

const DEFAULT_USER_MESSAGE: Readonly<Record<AppErrorCode, string>> = {
  WEBGL_UNAVAILABLE:
    '当前浏览器或显卡驱动不支持 WebGL 2，游戏无法启动。请更新浏览器，或在设置中开启硬件加速。',
  RENDERER_INIT_FAILED: '渲染器初始化失败。请刷新页面重试；若持续失败，请检查显卡驱动。',
  ASSET_LOAD_FAILED: '资源加载失败。请检查网络连接后刷新页面。',
  WORKER_UNAVAILABLE: '后台线程不可用，游戏将以较低性能运行（区块生成可能造成卡顿）。',
  AUDIO_INIT_FAILED: '音频初始化失败，游戏将静音运行。',
  STORAGE_UNAVAILABLE: '浏览器存储不可用，存档无法保存。请检查隐私模式或站点权限设置。',
  SAVE_CORRUPTED: '存档数据已损坏，无法读取。可以新建一个世界继续游戏。',
  SAVE_VERSION_UNSUPPORTED: '存档由更新版本的游戏创建，当前版本无法读取。',
  WORLD_GENERATION_FAILED: '世界生成失败。请尝试使用其他种子新建世界。',
  UNKNOWN: '发生了未预期的错误。请刷新页面重试。',
};

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly userMessage: string;
  public readonly context: Readonly<Record<string, unknown>>;

  public constructor(code: AppErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.userMessage = options.userMessage ?? DEFAULT_USER_MESSAGE[code];
    this.context = options.context ?? {};
  }
}

/**
 * Normalises anything throwable into an {@link AppError}.
 *
 * @param value - Caught value of unknown shape.
 * @param fallbackCode - Code used when `value` is not already an `AppError`.
 * @returns A guaranteed `AppError` instance.
 */
export function toAppError(value: unknown, fallbackCode: AppErrorCode = 'UNKNOWN'): AppError {
  if (value instanceof AppError) {
    return value;
  }
  if (value instanceof Error) {
    return new AppError(fallbackCode, value.message, { cause: value });
  }
  return new AppError(fallbackCode, String(value), { cause: value });
}
