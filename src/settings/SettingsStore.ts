/**
 * 玩家设置的持久化。
 *
 * I. 为什么设置用 localStorage 而世界存档用 IndexedDB
 *
 * 1. 设置是一小段 JSON（< 1 KB），需要在首帧之前同步读出以决定 FOV、画质与音量；
 *    localStorage 是同步 API，正好合适；IndexedDB 是异步的，会把启动流程变成多阶段。
 * 2. 世界存档包含成千上万条区块修改，必须走 IndexedDB（localStorage 的 5 MB 配额与
 *    字符串序列化开销都不合适）。两者职责不同，因此用不同的存储介质。
 *
 * II. 为什么必须静默降级
 *
 * 1. Safari 隐私模式、禁用了站点数据、或者被扩展拦截时，`localStorage` 的读写都会抛
 *    `SecurityError`。这不该阻止玩家进入游戏。
 * 2. 因此所有存储访问都被包住：失败时 `persistent` 变为 `false`，设置退化为"本次会话
 *    内存有效"，其余行为（订阅、钳制、默认回退）完全不变。
 *
 * III. 为什么校验用 `normalizeSettings` 而不是信任读到的 JSON
 *
 * 1. 存储里的值可以被玩家、其他标签页或扩展改写；`normalizeSettings` 逐字段钳制并回退
 *    默认值，保证 `GameSettings` 的不变量在任何时刻都成立。
 * 2. 这也是"一个坏掉的滑杆值不会重置全部设置"的原因。
 *
 * @module settings/SettingsStore
 */

import { logger as defaultLogger, type Logger } from '@/utils/logger';
import {
  applySettingsPatch,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type GameSettings,
} from './types';

/** localStorage 的最小可用面；测试可注入同形状的内存实现。 */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 设置变更监听器；收到的永远是**完整**的设置对象。 */
export type SettingsListener = (settings: GameSettings) => void;

export interface SettingsStoreOptions {
  /** 存储键；默认 `my-mc-v2:settings`。 */
  readonly storageKey?: string;
  /** 存储实现；默认 `globalThis.localStorage`。 */
  readonly storage?: SettingsStorage;
  readonly logger?: Logger;
  /** 默认值覆盖；测试用于断言"回退到默认值"的路径。 */
  readonly defaults?: GameSettings;
}

/** 默认存储键。 */
export const SETTINGS_STORAGE_KEY = 'my-mc-v2:settings';

/**
 * 解析浏览器 localStorage。
 *
 * 访问 `globalThis.localStorage` 本身就可能抛异常（隐私模式），因此必须在 try 里取值，
 * 而不是先判断 `typeof localStorage !== 'undefined'`。
 */
function resolveLocalStorage(): SettingsStorage | null {
  try {
    const scope = globalThis as { localStorage?: SettingsStorage };
    return scope.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * 设置存储。
 *
 * 生命周期：构造时读一次 → 之后由内存对象作为唯一真源（single source of truth）→
 * 每次 `update`/`reset` 写回存储并通知监听者。
 */
export class SettingsStore {
  readonly #storageKey: string;
  readonly #storage: SettingsStorage | null;
  readonly #logger: Logger;
  readonly #defaults: GameSettings;
  readonly #listeners = new Set<SettingsListener>();

  #settings: GameSettings;
  #persistent: boolean;
  #writeFailureLogged = false;

  public constructor(options: SettingsStoreOptions = {}) {
    this.#storageKey = options.storageKey ?? SETTINGS_STORAGE_KEY;
    this.#storage = options.storage ?? resolveLocalStorage();
    this.#logger = (options.logger ?? defaultLogger).child('settings');
    this.#persistent = this.#storage !== null;
    this.#defaults = normalizeSettings(options.defaults ?? DEFAULT_SETTINGS);
    this.#settings = this.#readFromStorage();
  }

  /** 当前设置的只读快照（内部对象不可变）。 */
  public get current(): GameSettings {
    return this.#settings;
  }

  /** 存储是否可用；为 `false` 时设置只在本次会话有效。 */
  public get persistent(): boolean {
    return this.#persistent;
  }

  /** 当前存储键。 */
  public get storageKey(): string {
    return this.#storageKey;
  }

  /**
   * 合并一批设置并持久化。
   *
   * I. 通知语义
   *
   * 1. 无论取值是否真的变化，`update()` 之后都会通知监听者，并且携带**完整**的新设置。
   *    这样渲染/音频系统只需要"收到通知就重新读全量"，不必自己比对差值。
   *
   * @param patch - 需要修改的字段。
   * @returns 规范化之后的新设置。
   */
  public update(patch: Partial<GameSettings>): GameSettings {
    this.#settings = applySettingsPatch(this.#settings, patch);
    this.#persist();
    this.#notify();
    return this.#settings;
  }

  /**
   * 恢复默认设置并持久化。
   *
   * @returns 默认设置。
   */
  public reset(): GameSettings {
    this.#settings = this.#readDefaults();
    this.#persist();
    this.#notify();
    return this.#settings;
  }

  /**
   * 订阅设置变更。
   *
   * @param listener - 收到完整设置对象的回调。
   * @returns 取消订阅函数（可重复调用）。
   */
  public subscribe(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /**
   * 重新从存储读取（多标签页同步、或外部修改后手动刷新）。
   *
   * @returns 重新读取后的设置；与当前一致时不触发通知。
   */
  public reload(): GameSettings {
    const next = this.#readFromStorage();
    if (!sameSettings(next, this.#settings)) {
      this.#settings = next;
      this.#notify();
    }
    return this.#settings;
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  #readDefaults(): GameSettings {
    return this.#defaults;
  }

  /** 读取 + 校验；任何失败都退回默认值并记录 warn。 */
  #readFromStorage(): GameSettings {
    const storage = this.#storage;
    if (storage === null) {
      this.#logger.warn('localStorage 不可用，设置将只在本次会话内生效');
      return this.#readDefaults();
    }

    let raw: string | null;
    try {
      raw = storage.getItem(this.#storageKey);
    } catch (error) {
      this.#persistent = false;
      this.#logger.warn('读取设置失败，将使用默认设置', error);
      return this.#readDefaults();
    }

    if (raw === null || raw === '') {
      return this.#readDefaults();
    }

    try {
      return normalizeSettings(JSON.parse(raw));
    } catch (error) {
      // 损坏的 JSON 是"可恢复"的：用默认值继续，玩家下次改设置时会覆盖它。
      this.#logger.warn('设置内容无法解析，已回退到默认设置', error);
      return this.#readDefaults();
    }
  }

  /** 写回存储；失败时降级为内存态并只记录一次 warn。 */
  #persist(): void {
    const storage = this.#storage;
    if (storage === null) {
      return;
    }
    try {
      storage.setItem(this.#storageKey, JSON.stringify(this.#settings));
      this.#persistent = true;
      return;
    } catch (error) {
      // 配额不足 / 隐私模式：降级为内存态。只报一次，避免每次调滑杆都刷屏。
      this.#persistent = false;
      if (!this.#writeFailureLogged) {
        this.#writeFailureLogged = true;
        this.#logger.warn('写入设置失败，设置将只在本次会话内生效', error);
      }
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#settings);
      } catch (error) {
        // 单个监听者出错不应影响其他监听者，更不能让 `update()` 抛出。
        this.#logger.warn('设置监听器执行失败', error);
      }
    }
  }
}

/** 逐字段比较两个设置对象。 */
function sameSettings(left: GameSettings, right: GameSettings): boolean {
  return (
    left.mouseSensitivity === right.mouseSensitivity &&
    left.fov === right.fov &&
    left.renderDistance === right.renderDistance &&
    left.masterVolume === right.masterVolume &&
    left.sfxVolume === right.sfxVolume &&
    left.ambientVolume === right.ambientVolume &&
    left.graphicsQuality === right.graphicsQuality &&
    left.shadows === right.shadows &&
    left.debugOverlay === right.debugOverlay &&
    left.viewBobbing === right.viewBobbing &&
    left.invertY === right.invertY
  );
}
