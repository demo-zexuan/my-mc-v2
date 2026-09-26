/**
 * 自动保存节流器。
 *
 * I. 为什么需要两条独立的触发条件
 *
 * 1. **按时间**（默认 20 秒）：玩家边走边挖时，存档不该只在退出时落盘；一次崩溃最多损失
 *    20 秒的进度。
 * 2. **按修改次数**（默认 64 次）：连续挖一条长隧道时，20 秒可能积累上千次方块修改，
 *    单帧内序列化上千条 edits 会造成可感知的卡顿，因此用"次数阈值"把一次大写入拆开。
 *
 * II. 为什么把节流器独立于 SaveManager
 *
 * 1. 触发条件是纯计数与时间比较，与存储无关，单独测试可以用注入的时钟精确验证边界，
 *    不必启动 IndexedDB。
 * 2. 它也避免了"保存过程中又触发保存"这类重入问题：只有 `markSaved()` 才会清掉脏标记，
 *    因此在途保存期间的触发都会被抑制。
 *
 * @module save/AutosaveThrottle
 */

/** 默认自动保存间隔，毫秒。 */
export const DEFAULT_AUTOSAVE_INTERVAL_MS = 20_000;

/** 默认"多少次方块修改后强制保存"。 */
export const DEFAULT_AUTOSAVE_CHANGE_THRESHOLD = 64;

export interface AutosaveThrottleOptions {
  /** 两次按时间触发的保存之间的最小间隔，毫秒。 */
  readonly intervalMs?: number;
  /** 累计多少次方块修改后触发一次保存。 */
  readonly changeThreshold?: number;
  /** 时钟注入；测试用假时钟验证边界。 */
  readonly now?: () => number;
}

/**
 * 把配置值收敛成"有限且为正"的数。
 *
 * `Math.max(1, Number.NaN)` 的结果是 `NaN`——NaN 会污染后续所有比较，使间隔判断永远为
 * false，自动保存静默失效。因此配置入口必须先过滤非有限值。
 */
function ensurePositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/**
 * 自动保存节流器。
 *
 * 使用方式：方块被修改时调用 {@link noteChange}；周期性调用 {@link shouldTrigger}（或直接
 * 让 `SaveManager` 的定时器调用）；保存成功后调用 {@link markSaved}。
 */
export class AutosaveThrottle {
  readonly #intervalMs: number;
  readonly #changeThreshold: number;
  readonly #now: () => number;

  #pendingChanges = 0;
  #dirty = false;
  #lastSavedAt: number;

  public constructor(options: AutosaveThrottleOptions = {}) {
    this.#intervalMs = ensurePositive(options.intervalMs, DEFAULT_AUTOSAVE_INTERVAL_MS);
    this.#changeThreshold = Math.floor(
      ensurePositive(options.changeThreshold, DEFAULT_AUTOSAVE_CHANGE_THRESHOLD),
    );
    this.#now = options.now ?? Date.now;
    this.#lastSavedAt = this.#now();
  }

  /** 距离上次保存累计的方块修改次数。 */
  public get pendingChanges(): number {
    return this.#pendingChanges;
  }

  /** 自上次保存以来是否有改动。 */
  public get dirty(): boolean {
    return this.#dirty;
  }

  /** 上一次保存（或构造）的时间戳。 */
  public get lastSavedAt(): number {
    return this.#lastSavedAt;
  }

  /** 配置的时间间隔。 */
  public get intervalMs(): number {
    return this.#intervalMs;
  }

  /** 配置的修改次数阈值。 */
  public get changeThreshold(): number {
    return this.#changeThreshold;
  }

  /**
   * 记录方块修改。
   *
   * @param count - 本次修改数量，默认 1。
   * @returns 是否达到次数阈值（调用方据此立即触发一次保存）。
   */
  public noteChange(count = 1): boolean {
    const amount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (amount <= 0) {
      return false;
    }
    this.#pendingChanges += amount;
    this.#dirty = true;
    if (this.#pendingChanges >= this.#changeThreshold) {
      // 达到阈值后清零：一次失败的大写入不应该让后续每一次修改都重试整个存档。
      this.#pendingChanges = 0;
      return true;
    }
    return false;
  }

  /** 是否满足"按时间"的触发条件。 */
  public shouldTrigger(): boolean {
    if (!this.#dirty) {
      return false;
    }
    return this.#now() - this.#lastSavedAt >= this.#intervalMs;
  }

  /** 标记一次成功保存；清空脏标记与计数。 */
  public markSaved(): void {
    this.#dirty = false;
    this.#pendingChanges = 0;
    this.#lastSavedAt = this.#now();
  }

  /** 丢弃全部待保存状态（例如玩家主动放弃存档）。 */
  public reset(): void {
    this.#dirty = false;
    this.#pendingChanges = 0;
  }
}
