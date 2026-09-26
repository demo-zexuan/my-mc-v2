/**
 * Small promise helpers used by the boot sequence.
 *
 * @module utils/async
 */

/**
 * Resolves after the browser has painted the next animation frame.
 *
 * I. Why this exists
 *
 * 1. The boot sequence mutates the DOM (overlay text) and then immediately
 *    performs heavy synchronous work such as shader compilation. Without
 *    yielding to the compositor the player never sees the intermediate message,
 *    which makes startup feel like a freeze rather than a progress bar.
 *
 * @returns A promise resolved on the next animation frame.
 */
export function nextAnimationFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      resolve();
    });
  });
}

/**
 * Resolves after `milliseconds`, used by the boot sequence to keep the loading
 * screen on screen long enough to be read instead of flashing.
 *
 * @param milliseconds - Delay in milliseconds.
 */
export function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}
