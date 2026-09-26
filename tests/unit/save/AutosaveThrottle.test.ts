/**
 * AutosaveThrottle 测试。
 *
 * I. 覆盖重点
 *
 * 1. 两条触发条件（时间间隔、修改次数）的精确边界：恰好等于阈值/间隔时必须触发。
 * 2. 脏标记只在 `markSaved()` 时清空，保证"保存失败会重试"。
 * 3. 计数在触发后清零，避免一次失败的大写入让后续每次修改都重试整份存档。
 *
 * @module tests/unit/save/AutosaveThrottle.test
 */

import { describe, expect, it } from 'vitest';

import {
  AutosaveThrottle,
  DEFAULT_AUTOSAVE_CHANGE_THRESHOLD,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
} from '@/save/AutosaveThrottle';

/** 可手动推进的假时钟。 */
function createClock(start = 0): { readonly now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('AutosaveThrottle defaults', () => {
  it('uses 20 seconds and 64 changes by default', () => {
    const throttle = new AutosaveThrottle();

    expect(throttle.intervalMs).toBe(DEFAULT_AUTOSAVE_INTERVAL_MS);
    expect(throttle.changeThreshold).toBe(DEFAULT_AUTOSAVE_CHANGE_THRESHOLD);
    expect(throttle.dirty).toBe(false);
  });

  it('starts clean so a freshly loaded world is not saved immediately', () => {
    const clock = createClock();

    const throttle = new AutosaveThrottle({ now: clock.now, intervalMs: 1000 });

    expect(throttle.shouldTrigger()).toBe(false);
  });
});

describe('AutosaveThrottle change counting', () => {
  it('triggers exactly when the change threshold is reached', () => {
    const throttle = new AutosaveThrottle({ changeThreshold: 64 });

    expect(throttle.noteChange(63)).toBe(false);
    expect(throttle.pendingChanges).toBe(63);
    expect(throttle.noteChange(1)).toBe(true);
    // 触发后计数清零，避免连续重试整份存档。
    expect(throttle.pendingChanges).toBe(0);
    expect(throttle.noteChange(1)).toBe(false);
  });

  it('accepts batched counts', () => {
    const throttle = new AutosaveThrottle({ changeThreshold: 10 });

    expect(throttle.noteChange(10)).toBe(true);
    expect(throttle.noteChange(11)).toBe(true);
  });

  it('marks the throttle dirty on the first change', () => {
    const clock = createClock();
    const throttle = new AutosaveThrottle({ now: clock.now, intervalMs: 500 });

    throttle.noteChange(1);
    expect(throttle.dirty).toBe(true);
    expect(throttle.shouldTrigger()).toBe(false);

    clock.advance(500);
    expect(throttle.shouldTrigger()).toBe(true);
  });

  it('ignores zero, negative and non-finite counts', () => {
    const throttle = new AutosaveThrottle({ changeThreshold: 5 });

    expect(throttle.noteChange(0)).toBe(false);
    expect(throttle.noteChange(-3)).toBe(false);
    expect(throttle.noteChange(Number.NaN)).toBe(false);
    expect(throttle.dirty).toBe(false);
    expect(throttle.pendingChanges).toBe(0);
  });
});

describe('AutosaveThrottle time based triggering', () => {
  it('does not trigger before the interval elapses', () => {
    const clock = createClock(1000);
    const throttle = new AutosaveThrottle({ now: clock.now, intervalMs: 20_000 });
    throttle.noteChange(1);

    clock.advance(19_999);
    expect(throttle.shouldTrigger()).toBe(false);
  });

  it('triggers exactly at the interval boundary', () => {
    const clock = createClock(1000);
    const throttle = new AutosaveThrottle({ now: clock.now, intervalMs: 20_000 });
    throttle.noteChange(1);

    clock.advance(20_000);
    expect(throttle.shouldTrigger()).toBe(true);
  });

  it('restarts the interval after a successful save', () => {
    const clock = createClock(0);
    const throttle = new AutosaveThrottle({ now: clock.now, intervalMs: 1000 });
    throttle.noteChange(1);
    clock.advance(1500);
    expect(throttle.shouldTrigger()).toBe(true);

    throttle.markSaved();
    expect(throttle.dirty).toBe(false);
    expect(throttle.pendingChanges).toBe(0);
    expect(throttle.shouldTrigger()).toBe(false);

    clock.advance(999);
    expect(throttle.shouldTrigger()).toBe(false);
  });

  it('never reports a non-finite interval', () => {
    const throttle = new AutosaveThrottle({ intervalMs: Number.NaN, changeThreshold: Number.NaN });

    expect(throttle.intervalMs).toBeGreaterThan(0);
    expect(throttle.changeThreshold).toBeGreaterThan(0);
  });
});

describe('AutosaveThrottle reset', () => {
  it('discards pending changes without touching the last-save timestamp', () => {
    const clock = createClock(0);
    const throttle = new AutosaveThrottle({ now: clock.now, intervalMs: 1000 });
    throttle.noteChange(5);

    throttle.reset();

    expect(throttle.dirty).toBe(false);
    expect(throttle.pendingChanges).toBe(0);
    expect(throttle.lastSavedAt).toBe(0);
  });
});
