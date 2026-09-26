/**
 * Graphics capability detection.
 *
 * I. Why WebGL 2 is required rather than preferred
 *
 * 1. Three.js removed the WebGL 1 renderer in r163; from that release on,
 *    `WebGLRenderer` creates a WebGL 2 context only. Detecting the limitation
 *    ourselves lets the boot sequence show an actionable message instead of the
 *    renderer throwing during construction.
 * 2. The probe takes a minimal structural type instead of an
 *    `HTMLCanvasElement`, so the unit test can inject a stub without needing a
 *    real GL context (which jsdom cannot provide).
 *
 * @module rendering/capabilities
 */

/** Graphics backends the game can run on. */
export type GraphicsBackend = 'webgl2' | 'none';

/** Minimal surface needed to probe for a GL context. */
export interface GraphicsProbeTarget {
  getContext(contextId: string, options?: unknown): unknown;
}

/**
 * Detects which graphics backend is available.
 *
 * I. The target must be a throwaway canvas
 *
 * This function loses the probe context on purpose (see below), so the canvas it
 * was given is permanently unusable for WebGL afterwards. Callers that need a
 * working canvas — most importantly `createRenderer` — must therefore pass a
 * freshly created element, never the canvas the game will render into.
 *
 * @param target - Canvas-like probe (usually a throwaway
 *        `document.createElement('canvas')`).
 * @returns `'webgl2'` when a WebGL 2 context can be created, otherwise `'none'`.
 */
export function detectGraphicsBackend(target: GraphicsProbeTarget | null): GraphicsBackend {
  if (target === null) {
    return 'none';
  }

  try {
    // I. Probe without keeping a live context.
    // 1. Browsers limit the number of simultaneous WebGL contexts (commonly 16).
    //    A probe that leaks a context would reduce the budget available to the
    //    real renderer, so the probe context is explicitly lost afterwards.
    const context = target.getContext('webgl2');
    if (context === null || context === undefined) {
      return 'none';
    }

    const loseContext = (
      context as { getExtension?: (name: string) => { loseContext?: () => void } | null }
    ).getExtension?.('WEBGL_lose_context');
    loseContext?.loseContext?.();

    return 'webgl2';
  } catch {
    // Some privacy-hardened browsers throw instead of returning null when a
    // canvas is used for fingerprinting.
    return 'none';
  }
}
