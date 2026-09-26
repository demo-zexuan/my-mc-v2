import { describe, expect, it } from 'vitest';

import { FrameStats } from '@/engine/core/FrameStats';

describe('FrameStats', () => {
  it('reports zeroes before the first sample', () => {
    const stats = new FrameStats();
    const snapshot = stats.snapshot();

    expect(snapshot.fps).toBe(0);
    expect(snapshot.frameTimeMs).toBe(0);
    expect(snapshot.sampleCount).toBe(0);
  });

  it('seeds the moving average with the first sample instead of ramping up', () => {
    const stats = new FrameStats({ smoothing: 0.1, windowSize: 10 });
    stats.record(16.7);

    // A naive EMA starting at zero would report ~1.7 ms / 600 FPS here.
    expect(stats.snapshot().frameTimeMs).toBeCloseTo(16.7, 5);
    expect(stats.snapshot().fps).toBeCloseTo(1000 / 16.7, 5);
  });

  it('tracks the windowed minimum and maximum', () => {
    const stats = new FrameStats({ smoothing: 0.5, windowSize: 4 });
    for (const value of [10, 20, 30, 40]) {
      stats.record(value);
    }

    const snapshot = stats.snapshot();
    expect(snapshot.minFrameTimeMs).toBe(10);
    expect(snapshot.maxFrameTimeMs).toBe(40);
    expect(snapshot.averageFrameTimeMs).toBeCloseTo(25, 5);
  });

  it('keeps a bounded memory footprint regardless of frame count', () => {
    const stats = new FrameStats({ windowSize: 8 });
    for (let i = 0; i < 10_000; i += 1) {
      stats.record(i % 20);
    }

    const snapshot = stats.snapshot();
    expect(snapshot.sampleCount).toBe(10_000);
    // Only the last eight samples (12..19) may influence the window.
    expect(snapshot.minFrameTimeMs).toBeGreaterThanOrEqual(12);
    expect(snapshot.maxFrameTimeMs).toBeLessThanOrEqual(19);
  });

  it('treats non-finite and negative deltas as zero', () => {
    const stats = new FrameStats();
    stats.record(Number.NaN);
    stats.record(-5);
    stats.record(Number.POSITIVE_INFINITY);

    expect(stats.snapshot().maxFrameTimeMs).toBe(0);
  });

  it('validates the smoothing factor', () => {
    expect(() => new FrameStats({ smoothing: 0 })).toThrow(RangeError);
    expect(() => new FrameStats({ smoothing: 1.5 })).toThrow(RangeError);
  });

  it('resets every counter', () => {
    const stats = new FrameStats();
    stats.record(16);
    stats.reset();

    expect(stats.snapshot().sampleCount).toBe(0);
    expect(stats.snapshot().frameTimeMs).toBe(0);
  });
});
