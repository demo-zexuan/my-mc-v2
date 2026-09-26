/**
 * WebGL renderer construction.
 *
 * I. Centralising renderer creation
 *
 * 1. Every renderer option that affects visual quality or device battery life
 *    (pixel ratio cap, shadows, colour space, antialiasing) is decided in one
 *    place, so the settings screen can later change them without hunting for
 *    `new WebGLRenderer` call sites.
 * 2. Construction is wrapped so that a driver-level failure surfaces as an
 *    {@link AppError} with a player-facing message instead of a raw exception.
 *
 * @module rendering/createRenderer
 */

import * as THREE from 'three';

import { AppError } from '@/utils/errors';

import { detectGraphicsBackend } from './capabilities';

export interface RendererOptions {
  /**
   * Upper bound for `devicePixelRatio`. Rendering a 3x retina display at native
   * resolution triples the fragment work for a visual gain nobody notices on a
   * voxel world, so the default caps at 2.
   */
  readonly pixelRatioCap?: number;
  /** Enables the shadow map pipeline. Defaults to true. */
  readonly shadows?: boolean;
  /** Enables MSAA. Defaults to true. */
  readonly antialias?: boolean;
}

export interface RendererHandle {
  readonly renderer: THREE.WebGLRenderer;
  /** Releases GPU resources; safe to call more than once. */
  dispose(): void;
}

/**
 * Creates the WebGL renderer for the given canvas.
 *
 * @param canvas - Canvas the renderer draws into.
 * @param options - Quality related options; all have sensible defaults.
 * @returns The renderer plus a disposer.
 * @throws {AppError} With code `WEBGL_UNAVAILABLE` when WebGL 2 is missing.
 * @throws {AppError} With code `RENDERER_INIT_FAILED` when construction fails.
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  options: RendererOptions = {},
): RendererHandle {
  // I. Refuse to construct a renderer without a WebGL 2 context.
  // 1. Three.js r163+ dropped WebGL 1 support; failing fast produces a much
  //    clearer message than the renderer's internal error.
  // 2. The probe MUST run on a throwaway canvas. A canvas can only ever hand out
  //    one context, and the probe deliberately calls
  //    `WEBGL_lose_context.loseContext()` to avoid leaking a context. Probing the
  //    renderer's own canvas would therefore pass a *lost* context to Three.js,
  //    which then fails with "Cannot read properties of null (reading
  //    'precision')" because every WebGL call on a lost context returns null.
  if (detectGraphicsBackend(document.createElement('canvas')) === 'none') {
    throw new AppError(
      'WEBGL_UNAVAILABLE',
      'WebGL 2 context could not be created on a probe canvas.',
    );
  }

  // II. Construct the renderer.
  // 1. Any throw here is a driver/GPU problem rather than a user-caused issue,
  //    therefore it is reported with its own error code.
  try {
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: options.antialias ?? true,
      // Discrete GPUs are preferred: integrated chips struggle with the chunk
      // mesh upload rate during world streaming.
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.pixelRatioCap ?? 2));

    // ACES tone mapping keeps the bright sky from clipping to white while the
    // sun crosses the horizon; sRGB output matches the colour pipeline used by
    // the procedural texture atlas.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;

    if (options.shadows ?? true) {
      renderer.shadowMap.enabled = true;
      // PCF soft shadows hide the stair-stepping that is very visible on the
      // long, flat surfaces of a voxel world.
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    let disposed = false;
    return {
      renderer,
      dispose: (): void => {
        if (disposed) {
          return;
        }
        disposed = true;
        renderer.dispose();
        renderer.forceContextLoss();
      },
    };
  } catch (error) {
    // The underlying message is folded into the technical string on purpose: it
    // is the only place a driver or a headless-browser limitation becomes
    // visible, and the boot card is the fastest way to read it.
    const cause = error instanceof Error ? error.message : String(error);
    throw new AppError(
      'RENDERER_INIT_FAILED',
      `THREE.WebGLRenderer construction failed: ${cause}`,
      {
        cause,
        context: { antialias: options.antialias ?? true, shadows: options.shadows ?? true },
      },
    );
  }
}
