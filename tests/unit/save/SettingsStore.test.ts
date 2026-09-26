/**
 * SettingsStore 测试。
 *
 * I. 为什么放在 tests/unit/save 下
 *
 * `SettingsStore` 与存档层共用同一条"持久化 + 校验 + 降级"的验证命令
 * （`vitest run tests/unit/audio tests/unit/save`），因此测试放在本目录，避免出现
 * "新增了测试目录但验证命令没覆盖"的盲区。
 *
 * II. 覆盖重点
 *
 * 1. 读取：损坏 JSON、非对象 JSON、越界字段、缺字段。
 * 2. 写入：钳制、订阅通知（必须携带完整设置）、持久化、重置。
 * 3. 降级：localStorage 抛异常（隐私模式）时如何使用内存态继续工作。
 *
 * @module tests/unit/save/SettingsStore.test
 */

import { describe, expect, it, vi } from 'vitest';

import {
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  type SettingsStorage,
} from '@/settings/SettingsStore';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, type GameSettings } from '@/settings/types';
import { Logger } from '@/utils/logger';

/** 内存版 localStorage。 */
class MemoryStorage implements SettingsStorage {
  readonly #items = new Map<string, string>();
  public reads = 0;
  public writes = 0;

  public getItem(key: string): string | null {
    this.reads += 1;
    return this.#items.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.writes += 1;
    this.#items.set(key, value);
  }

  public removeItem(key: string): void {
    this.#items.delete(key);
  }

  /** 直接读取落盘的原始字符串，供断言使用。 */
  public raw(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
}

function silentLogger(): Logger {
  return new Logger({ level: 'silent' });
}

function createStore(
  storage: SettingsStorage | null = new MemoryStorage(),
  logger: Logger = silentLogger(),
): SettingsStore {
  return new SettingsStore({
    logger,
    ...(storage === null ? {} : { storage }),
  });
}

describe('SettingsStore defaults', () => {
  it('falls back to DEFAULT_SETTINGS on a first run', () => {
    const store = createStore();

    expect(store.current).toEqual(DEFAULT_SETTINGS);
    expect(store.persistent).toBe(true);
    expect(store.storageKey).toBe(SETTINGS_STORAGE_KEY);
  });

  it('falls back to in-memory mode when localStorage is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore(null, new Logger({ level: 'warn' }));

    expect(store.persistent).toBe(false);
    expect(store.current).toEqual(DEFAULT_SETTINGS);
    // 写入不应抛异常，只是不落盘。
    expect(() => store.update({ fov: 100 })).not.toThrow();
    expect(store.current.fov).toBe(100);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('SettingsStore reading', () => {
  it('reads persisted values', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ fov: 95, invertY: true }));

    const store = createStore(storage);

    expect(store.current.fov).toBe(95);
    expect(store.current.invertY).toBe(true);
    // 未提供的字段回退默认值。
    expect(store.current.mouseSensitivity).toBe(DEFAULT_SETTINGS.mouseSensitivity);
  });

  it('clamps out-of-range values field by field', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        fov: 500,
        masterVolume: -3,
        renderDistance: 2.4,
        mouseSensitivity: 0,
        graphicsQuality: 'ultra',
        shadows: 'yes',
      }),
    );

    const store = createStore(storage);

    expect(store.current.fov).toBe(SETTINGS_LIMITS.fov.max);
    expect(store.current.masterVolume).toBe(SETTINGS_LIMITS.masterVolume.min);
    expect(store.current.renderDistance).toBe(Math.round(2.4));
    expect(store.current.mouseSensitivity).toBeGreaterThanOrEqual(
      SETTINGS_LIMITS.mouseSensitivity.min,
    );
    expect(store.current.graphicsQuality).toBe(DEFAULT_SETTINGS.graphicsQuality);
    expect(store.current.shadows).toBe(DEFAULT_SETTINGS.shadows);
  });

  it('falls back to defaults for unparsable JSON and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, '{ 这不是 JSON');

    const store = createStore(storage, new Logger({ level: 'warn' }));

    expect(store.current).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to defaults for valid JSON that is not a settings object', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify('纯字符串'));

    expect(createStore(storage).current).toEqual(DEFAULT_SETTINGS);
  });
});

describe('SettingsStore writing', () => {
  it('normalises patches and persists them', () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);

    const next = store.update({ fov: 1000, viewBobbing: false });

    expect(next.fov).toBe(SETTINGS_LIMITS.fov.max);
    expect(next.viewBobbing).toBe(false);
    expect(storage.writes).toBe(1);
    const persisted: unknown = JSON.parse(storage.raw(SETTINGS_STORAGE_KEY) ?? 'null');
    expect(persisted).toMatchObject({ fov: SETTINGS_LIMITS.fov.max, viewBobbing: false });
  });

  it('notifies subscribers with the complete settings object after update', () => {
    const store = createStore();
    const received: GameSettings[] = [];
    store.subscribe((settings) => {
      received.push(settings);
    });

    store.update({ fov: 90 });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(store.current);
    // 必须是完整对象，而不是 patch。
    expect(Object.keys(received[0] ?? {}).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(received[0]?.fov).toBe(90);
  });

  it('notifies even when the patch leaves the values unchanged', () => {
    const store = createStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.update({ fov: DEFAULT_SETTINGS.fov });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('supports unsubscribing', () => {
    const store = createStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.update({ fov: 80 });
    unsubscribe();
    unsubscribe();
    store.update({ fov: 85 });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps other subscribers alive when one throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore(new MemoryStorage(), new Logger({ level: 'warn' }));
    const healthy = vi.fn();
    store.subscribe(() => {
      throw new Error('监听器自身出错');
    });
    store.subscribe(healthy);

    expect(() => store.update({ fov: 91 })).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('resets to defaults, persists them and notifies', () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    store.update({ fov: 110, invertY: true });
    const listener = vi.fn();
    store.subscribe(listener);

    const reset = store.reset();

    expect(reset).toEqual(DEFAULT_SETTINGS);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.raw(SETTINGS_STORAGE_KEY) ?? 'null')).toEqual(DEFAULT_SETTINGS);
  });

  it('reloads settings changed by another tab', () => {
    const storage = new MemoryStorage();
    const store = createStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);

    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ fov: 61 }));
    const reloaded = store.reload();

    expect(reloaded.fov).toBe(61);
    expect(listener).toHaveBeenCalledTimes(1);

    // 没有变化时不应重复通知。
    store.reload();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('SettingsStore degradation', () => {
  it('falls back to in-memory mode when reading throws (private mode)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new MemoryStorage();
    storage.getItem = (): string | null => {
      throw new Error('SecurityError: 站点数据被禁用');
    };

    const store = createStore(storage, new Logger({ level: 'warn' }));

    expect(store.persistent).toBe(false);
    expect(store.current).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('degrades silently (once) when writing throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = new MemoryStorage();
    storage.setItem = (): void => {
      throw new Error('QuotaExceededError');
    };
    const store = createStore(storage, new Logger({ level: 'warn' }));

    expect(() => store.update({ fov: 95 })).not.toThrow();
    expect(() => store.update({ fov: 96 })).not.toThrow();

    expect(store.persistent).toBe(false);
    expect(store.current.fov).toBe(96);
    // 只告警一次，避免每次拖动滑杆都刷屏。
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
