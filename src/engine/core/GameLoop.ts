/**
 * Deterministic fixed-timestep game loop.
 *
 * I. Why a fixed timestep instead of "delta seconds everywhere"
 *
 * 1. Voxel collision is resolved by stepping the player AABB through the world.
 *    Variable deltas make the result depend on frame rate: a 15 ms frame and a
 *    60 ms frame can resolve a wall in different orders, which shows up as
 *    players clipping through corners only on slow machines.
 * 2. Fixed steps keep physics reproducible, so integration tests can assert
 *    exact positions after a known number of steps.
 *
 * II. The classic accumulator is used, with two guards
 *
 * 1. `maxSubSteps` prevents the "spiral of death": after a long stall (tab in
 *    the background, shader compilation) the loop drops time instead of trying
 *    to simulate hundreds of catch-up steps. Dropped time is counted so the
 *    debug overlay can report that the machine cannot keep up.
 * 2. `interpolation` is exposed to the render callback so that rendering can
 *    smoothly interpolate between the previous and the current physics state
 *    even though the simulation itself is stepped discretely.
 *
 * @module engine/core/GameLoop
 */

/** Indirection over `requestAnimationFrame`, which keeps the loop testable. */
export interface FrameScheduler {
  request(callback: (timestampMs: number) => void): number;
  cancel(handle: number): void;
}

/** Scheduler backed by the browser's animation frame queue. */
export const browserFrameScheduler: FrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/** Per-frame information handed to the render callback. */
export interface RenderFrameInfo {
  /** Wall-clock seconds since the previous rendered frame (already clamped). */
  readonly deltaSeconds: number;
  /** Seconds since the loop started. */
  readonly elapsedSeconds: number;
  /** Blend factor in `[0, 1)` for interpolating simulation state. */
  readonly interpolation: number;
  /** Number of fixed steps executed during this frame. */
  readonly subSteps: number;
}

export interface GameLoopCallbacks {
  /** Called zero or more times per frame with a constant delta. */
  onFixedStep(deltaSeconds: number): void;
  /** Called exactly once per animation frame, after the fixed steps ran. */
  onRenderFrame(info: RenderFrameInfo): void;
}

export interface GameLoopOptions {
  /** Duration of one simulation step in seconds. Defaults to 1/60. */
  readonly fixedTimeStep?: number;
  /** Upper bound on catch-up steps per frame; prevents the spiral of death. */
  readonly maxSubSteps?: number;
  /**
   * Longest frame delta that is still simulated, in seconds. Anything longer is
   * treated as a stall and discarded. Defaults to 0.25 (4 FPS).
   */
  readonly maxFrameDeltaSeconds?: number;
  /** Injectable frame queue; the default uses `requestAnimationFrame`. */
  readonly scheduler?: FrameScheduler;
}

/** Immutable snapshot of loop counters, surfaced to the debug overlay. */
export interface GameLoopMetrics {
  readonly frames: number;
  readonly fixedSteps: number;
  readonly droppedSeconds: number;
  readonly running: boolean;
}

export class GameLoop {
  readonly #callbacks: GameLoopCallbacks;
  readonly #scheduler: FrameScheduler;
  readonly #fixedTimeStep: number;
  readonly #maxSubSteps: number;
  readonly #maxFrameDeltaSeconds: number;

  #handle: number | null = null;
  #lastTimestampMs: number | null = null;
  #accumulator = 0;
  #elapsedSeconds = 0;
  #frames = 0;
  #fixedSteps = 0;
  #droppedSeconds = 0;

  public constructor(callbacks: GameLoopCallbacks, options: GameLoopOptions = {}) {
    this.#callbacks = callbacks;
    this.#scheduler = options.scheduler ?? browserFrameScheduler;
    this.#fixedTimeStep = options.fixedTimeStep ?? 1 / 60;
    this.#maxSubSteps = options.maxSubSteps ?? 5;
    this.#maxFrameDeltaSeconds = options.maxFrameDeltaSeconds ?? 0.25;

    if (this.#fixedTimeStep <= 0) {
      throw new RangeError('fixedTimeStep must be greater than zero');
    }
    if (this.#maxSubSteps < 1) {
      throw new RangeError('maxSubSteps must be at least one');
    }
  }

  public get running(): boolean {
    return this.#handle !== null;
  }

  public get metrics(): GameLoopMetrics {
    return {
      frames: this.#frames,
      fixedSteps: this.#fixedSteps,
      droppedSeconds: this.#droppedSeconds,
      running: this.running,
    };
  }

  public start(): void {
    if (this.#handle !== null) {
      return;
    }
    // The first frame has no predecessor, so its delta must be zero rather than
    // "time since page load", which would otherwise be simulated in one go.
    this.#lastTimestampMs = null;
    this.#accumulator = 0;
    this.#handle = this.#scheduler.request(this.#onFrame);
  }

  public stop(): void {
    if (this.#handle === null) {
      return;
    }
    this.#scheduler.cancel(this.#handle);
    this.#handle = null;
  }

  /**
   * Advances the simulation by one frame.
   *
   * Public because the tests drive the loop with a synthetic clock instead of
   * waiting for real animation frames.
   *
   * @param timestampMs - Monotonic timestamp in milliseconds.
   */
  public advance(timestampMs: number): void {
    const delta = this.#consumeDelta(timestampMs);

    this.#elapsedSeconds += delta;
    this.#accumulator += delta;
    this.#frames += 1;

    // I. Run the simulation in fixed slices.
    // 1. At most `maxSubSteps` slices are simulated per frame; the remainder is
    //    dropped in the step below rather than queued.
    let subSteps = 0;
    while (this.#accumulator >= this.#fixedTimeStep && subSteps < this.#maxSubSteps) {
      this.#callbacks.onFixedStep(this.#fixedTimeStep);
      this.#accumulator -= this.#fixedTimeStep;
      subSteps += 1;
      this.#fixedSteps += 1;
    }

    // II. Discard the backlog we refuse to simulate.
    // 1. Keeping whole un-simulated steps in the accumulator would create a debt
    //    that makes the simulation run fast for the next frames, which is worse
    //    than being briefly behind: it desynchronises input from motion.
    // 2. The sub-step remainder is preserved so that dropping time never
    //    introduces a systematic drift between simulated and wall-clock time.
    if (this.#accumulator >= this.#fixedTimeStep) {
      const wholeSteps = this.#accumulator - (this.#accumulator % this.#fixedTimeStep);
      this.#droppedSeconds += wholeSteps;
      this.#accumulator -= wholeSteps;
    }

    // III. Render once per frame with the interpolation factor.
    this.#callbacks.onRenderFrame({
      deltaSeconds: delta,
      elapsedSeconds: this.#elapsedSeconds,
      interpolation: this.#accumulator / this.#fixedTimeStep,
      subSteps,
    });
  }

  #onFrame = (timestampMs: number): void => {
    if (this.#handle === null) {
      return;
    }
    this.advance(timestampMs);
    if (this.#handle !== null) {
      this.#handle = this.#scheduler.request(this.#onFrame);
    }
  };

  /** Converts two timestamps into a clamped, non-negative delta in seconds. */
  #consumeDelta(timestampMs: number): number {
    const previous = this.#lastTimestampMs;
    this.#lastTimestampMs = timestampMs;

    if (previous === null) {
      return 0;
    }

    // I. Guard against clocks that jump backwards (system sleep, NTP adjust).
    const rawDeltaMs = Math.max(0, timestampMs - previous);
    const deltaSeconds = rawDeltaMs / 1000;

    // II. Clamp stalls so a backgrounded tab cannot inject minutes of physics.
    return Math.min(deltaSeconds, this.#maxFrameDeltaSeconds);
  }
}
