/**
 * Rolling frame statistics.
 *
 * I. Why exponential moving averages instead of a plain average
 *
 * 1. A plain average over a fixed window still lags visibly when the frame rate
 *    changes, which makes optimisation work hard to judge.
 * 2. An EMA reacts immediately to a regression while staying readable; the
 *    windowed minimum/maximum are kept alongside it so that one-off spikes
 *    (shader compilation, chunk uploads) remain visible.
 *
 * @module engine/core/FrameStats
 */

/** Immutable statistics snapshot. All times are milliseconds. */
export interface FrameStatsSnapshot {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly averageFrameTimeMs: number;
  readonly minFrameTimeMs: number;
  readonly maxFrameTimeMs: number;
  readonly sampleCount: number;
}

export interface FrameStatsOptions {
  /** Smoothing factor of the EMA in `(0, 1]`; higher reacts faster. */
  readonly smoothing?: number;
  /** Number of frames considered by the min/max window. */
  readonly windowSize?: number;
}

export class FrameStats {
  readonly #smoothing: number;
  readonly #windowSize: number;
  readonly #window: Float32Array;

  #windowIndex = 0;
  #windowFilled = 0;
  #emaFrameTimeMs = 0;
  #totalSamples = 0;

  public constructor(options: FrameStatsOptions = {}) {
    const smoothing = options.smoothing ?? 0.1;
    if (smoothing <= 0 || smoothing > 1) {
      throw new RangeError('smoothing must be within (0, 1]');
    }
    this.#smoothing = smoothing;
    this.#windowSize = options.windowSize ?? 120;
    this.#window = new Float32Array(this.#windowSize);
  }

  /**
   * Records one frame.
   *
   * @param frameTimeMs - Wall-clock duration of the frame in milliseconds.
   */
  public record(frameTimeMs: number): void {
    const value = Number.isFinite(frameTimeMs) ? Math.max(0, frameTimeMs) : 0;

    // I. Update the exponential moving average.
    // 1. The first sample seeds the EMA; smoothing from zero would take dozens
    //    of frames to reach a plausible value.
    this.#emaFrameTimeMs =
      this.#totalSamples === 0
        ? value
        : this.#emaFrameTimeMs + this.#smoothing * (value - this.#emaFrameTimeMs);

    // II. Update the fixed-size window using a ring buffer so that recording a
    //     frame allocates nothing and therefore never causes GC pressure.
    this.#window[this.#windowIndex] = value;
    this.#windowIndex = (this.#windowIndex + 1) % this.#windowSize;
    this.#windowFilled = Math.min(this.#windowFilled + 1, this.#windowSize);
    this.#totalSamples += 1;
  }

  public reset(): void {
    this.#window.fill(0);
    this.#windowIndex = 0;
    this.#windowFilled = 0;
    this.#emaFrameTimeMs = 0;
    this.#totalSamples = 0;
  }

  public snapshot(): FrameStatsSnapshot {
    // I. Reduce the window.
    // 1. `filled` is zero until the first frame, in which case the values below
    //    stay at zero and the overlay simply shows "—".
    let min = Number.POSITIVE_INFINITY;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < this.#windowFilled; i += 1) {
      const value = this.#window[i] ?? 0;
      min = Math.min(min, value);
      max = Math.max(max, value);
      sum += value;
    }

    const hasSamples = this.#windowFilled > 0;
    return {
      fps: this.#emaFrameTimeMs > 0 ? 1000 / this.#emaFrameTimeMs : 0,
      frameTimeMs: this.#emaFrameTimeMs,
      averageFrameTimeMs: hasSamples ? sum / this.#windowFilled : 0,
      minFrameTimeMs: hasSamples ? min : 0,
      maxFrameTimeMs: max,
      sampleCount: this.#totalSamples,
    };
  }
}
