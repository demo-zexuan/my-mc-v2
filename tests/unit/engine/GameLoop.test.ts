import { describe, expect, it } from 'vitest';

import { GameLoop, type FrameScheduler } from '@/engine/core/GameLoop';

/**
 * Controllable scheduler: the loop thinks it is talking to
 * `requestAnimationFrame`, while the test decides when frames happen.
 */
class FakeScheduler implements FrameScheduler {
  public readonly requested: number[] = [];
  public readonly cancelled: number[] = [];
  public pending: ((timestampMs: number) => void) | null = null;

  #nextHandle = 1;

  public request(callback: (timestampMs: number) => void): number {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.requested.push(handle);
    this.pending = callback;
    return handle;
  }

  public cancel(handle: number): void {
    this.cancelled.push(handle);
    this.pending = null;
  }

  /** Runs the pending callback with the given timestamp. */
  public frame(timestampMs: number): void {
    const callback = this.pending;
    if (callback === null) {
      throw new Error('no frame is pending');
    }
    callback(timestampMs);
  }
}

interface Recorded {
  readonly fixedSteps: number[];
  readonly frames: { deltaSeconds: number; interpolation: number; subSteps: number }[];
}

function createRecorder(): Recorded {
  return { fixedSteps: [], frames: [] };
}

describe('GameLoop', () => {
  it('simulates nothing on the very first frame', () => {
    const scheduler = new FakeScheduler();
    const recorded = createRecorder();
    const loop = new GameLoop(
      {
        onFixedStep: (delta) => recorded.fixedSteps.push(delta),
        onRenderFrame: (info) => recorded.frames.push(info),
      },
      { scheduler, fixedTimeStep: 1 / 60 },
    );

    loop.start();
    scheduler.frame(1000);

    expect(recorded.fixedSteps).toHaveLength(0);
    expect(recorded.frames).toHaveLength(1);
    expect(recorded.frames[0]?.deltaSeconds).toBe(0);
  });

  it('runs one fixed step for a frame matching the timestep', () => {
    const scheduler = new FakeScheduler();
    const recorded = createRecorder();
    const loop = new GameLoop(
      {
        onFixedStep: (delta) => recorded.fixedSteps.push(delta),
        onRenderFrame: (info) => recorded.frames.push(info),
      },
      { scheduler, fixedTimeStep: 1 / 60, maxSubSteps: 5 },
    );

    loop.start();
    scheduler.frame(0);
    scheduler.frame(1000 / 60);

    expect(recorded.fixedSteps).toHaveLength(1);
    expect(recorded.fixedSteps[0]).toBeCloseTo(1 / 60, 10);
    expect(recorded.frames[1]?.subSteps).toBe(1);
  });

  it('carries the remainder into the next frame instead of losing it', () => {
    const scheduler = new FakeScheduler();
    const recorded = createRecorder();
    const loop = new GameLoop(
      {
        onFixedStep: (delta) => recorded.fixedSteps.push(delta),
        onRenderFrame: (info) => recorded.frames.push(info),
      },
      { scheduler, fixedTimeStep: 1 / 60, maxSubSteps: 8 },
    );

    loop.start();
    scheduler.frame(0);
    // 2.5 steps worth of time: one step must run now, the half step next frame.
    scheduler.frame((2.5 * 1000) / 60);
    scheduler.frame((3.5 * 1000) / 60);

    expect(recorded.fixedSteps).toHaveLength(3);
  });

  it('caps catch-up work and reports the discarded backlog', () => {
    const scheduler = new FakeScheduler();
    const recorded = createRecorder();
    const loop = new GameLoop(
      {
        onFixedStep: (delta) => recorded.fixedSteps.push(delta),
        onRenderFrame: (info) => recorded.frames.push(info),
      },
      { scheduler, fixedTimeStep: 1 / 60, maxSubSteps: 3, maxFrameDeltaSeconds: 10 },
    );

    loop.start();
    scheduler.frame(0);
    // Five seconds of wall clock arrive at once. Only `maxSubSteps` slices may
    // be simulated; the rest must be dropped rather than queued forever.
    scheduler.frame(5000);

    expect(recorded.fixedSteps).toHaveLength(3);
    expect(recorded.frames[1]?.subSteps).toBe(3);
    expect(loop.metrics.fixedSteps).toBe(3);
    expect(loop.metrics.droppedSeconds).toBeCloseTo(5 - (3 * 1) / 60, 6);
  });

  it('clamps a long stall so physics never sees minutes of delta', () => {
    const scheduler = new FakeScheduler();
    const recorded = createRecorder();
    const loop = new GameLoop(
      {
        onFixedStep: (delta) => recorded.fixedSteps.push(delta),
        onRenderFrame: (info) => recorded.frames.push(info),
      },
      { scheduler, fixedTimeStep: 1 / 60, maxSubSteps: 5, maxFrameDeltaSeconds: 0.25 },
    );

    loop.start();
    scheduler.frame(0);
    // Ten minutes of wall clock in one frame.
    scheduler.frame(600_000);

    expect(recorded.frames[1]?.deltaSeconds).toBeCloseTo(0.25, 10);
    expect(recorded.fixedSteps).toHaveLength(5);
  });

  it('ignores timestamps that move backwards', () => {
    const scheduler = new FakeScheduler();
    const recorded = createRecorder();
    const loop = new GameLoop(
      {
        onFixedStep: (delta) => recorded.fixedSteps.push(delta),
        onRenderFrame: (info) => recorded.frames.push(info),
      },
      { scheduler },
    );

    loop.start();
    scheduler.frame(5_000);
    scheduler.frame(4_000);

    expect(recorded.frames[1]?.deltaSeconds).toBe(0);
    expect(recorded.fixedSteps).toHaveLength(0);
  });

  it('exposes the interpolation factor used by the renderer', () => {
    const scheduler = new FakeScheduler();
    const recorded = createRecorder();
    const loop = new GameLoop(
      {
        onFixedStep: () => {},
        onRenderFrame: (info) => recorded.frames.push(info),
      },
      { scheduler, fixedTimeStep: 1 / 60, maxSubSteps: 5 },
    );

    loop.start();
    scheduler.frame(0);
    // Half a step of time: no fixed step runs, so alpha must be ~0.5.
    scheduler.frame(1000 / 120);

    expect(recorded.frames[1]?.interpolation).toBeCloseTo(0.5, 5);
  });

  it('stops requestAnimationFrame chaining after stop()', () => {
    const scheduler = new FakeScheduler();
    const loop = new GameLoop({ onFixedStep: () => {}, onRenderFrame: () => {} }, { scheduler });

    loop.start();
    expect(loop.running).toBe(true);
    loop.stop();
    expect(loop.running).toBe(false);
    expect(scheduler.cancelled).toHaveLength(1);

    // A frame that was already queued must not restart the loop.
    const queued = scheduler.requested.length;
    loop.stop();
    expect(scheduler.requested).toHaveLength(queued);
  });

  it('rejects invalid options', () => {
    expect(
      () => new GameLoop({ onFixedStep: () => {}, onRenderFrame: () => {} }, { fixedTimeStep: 0 }),
    ).toThrow(RangeError);
    expect(
      () => new GameLoop({ onFixedStep: () => {}, onRenderFrame: () => {} }, { maxSubSteps: 0 }),
    ).toThrow(RangeError);
  });
});
