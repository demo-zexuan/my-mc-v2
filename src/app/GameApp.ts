/**
 * Application root.
 *
 * I. Responsibilities
 *
 * 1. Owns the lifetime of everything that has to be created and destroyed with
 *    the page: the canvas, the renderer, the active scene and the game loop.
 * 2. Owns the boot sequence, which is deliberately linear and yields to the
 *    compositor between stages so that the loading screen stays responsive.
 * 3. Owns the frame callback that connects the fixed-step simulation to the
 *    renderer and to the debug overlay.
 *
 * II. What it must not do
 *
 * It contains no gameplay rules. In the finished game the scene is produced by
 * the world/player systems; this class only knows how to drive them. Keeping
 * that boundary is what allows those systems to be tested without a GL context.
 *
 * @module app/GameApp
 */

import type * as THREE from 'three';

import { appConfig } from '@/config/env';
import { DebugOverlay, type DebugRow } from '@/debug/DebugOverlay';
import { FrameStats } from '@/engine/core/FrameStats';
import { GameLoop, type RenderFrameInfo } from '@/engine/core/GameLoop';
import { createRenderer, type RendererHandle } from '@/rendering/createRenderer';
import { createSmokeTestScene, type SmokeTestScene } from '@/rendering/smoke/SmokeTestScene';
import { BootOverlay } from '@/ui/BootOverlay';
import { nextAnimationFrame } from '@/utils/async';
import { AppError, toAppError } from '@/utils/errors';
import { logger } from '@/utils/logger';

import { detectGraphicsBackend } from '../rendering/capabilities';

const log = logger.child('app');

/** Metrics rows that will be filled in by the voxel systems from Phase 2 on. */
const WORLD_ROWS: readonly DebugRow[] = [
  { key: 'position', label: 'Position' },
  { key: 'chunk', label: 'Chunk' },
  { key: 'chunks', label: 'Chunks' },
  { key: 'renderDistance', label: 'Render dist' },
  { key: 'seed', label: 'Seed' },
  { key: 'time', label: 'Time' },
];

export interface GameAppOptions {
  /** Shows the debug overlay immediately. Defaults to the environment flag. */
  readonly showDebugOverlay?: boolean;
}

/**
 * Owns one running instance of the game.
 *
 * The class is intentionally not a singleton: tests and the visual-regression
 * harness create and dispose instances, and a hidden global would leak the GL
 * context across runs.
 */
export class GameApp {
  readonly #root: HTMLElement;
  readonly #bootOverlay: BootOverlay;
  readonly #frameStats = new FrameStats();

  #debugOverlay: DebugOverlay | null = null;
  #rendererHandle: RendererHandle | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #scene: SmokeTestScene | null = null;
  #loop: GameLoop | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #showDebug: boolean;
  #disposed = false;
  #booted = false;

  public constructor(root: HTMLElement, options: GameAppOptions = {}) {
    this.#root = root;
    this.#bootOverlay = new BootOverlay(root);
    this.#showDebug = options.showDebugOverlay ?? appConfig.debugOverlayByDefault;
  }

  /** True once the first frame has been presented to the player. */
  public get booted(): boolean {
    return this.#booted;
  }

  /**
   * Runs the boot sequence and starts the game loop.
   *
   * @throws {AppError} Never — failures are presented through the boot overlay
   *         so that callers do not have to duplicate error UI.
   */
  public async start(): Promise<void> {
    try {
      await this.#boot();
    } catch (error) {
      const appError = toAppError(error);
      log.error(`boot failed: ${appError.code}`, appError);
      this.#bootOverlay.showFatal(appError);
    }
  }

  /** Releases every resource owned by the instance. Idempotent. */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    this.#loop?.stop();
    this.#loop = null;

    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;

    window.removeEventListener('keydown', this.#onKeyDown);

    this.#debugOverlay?.dispose();
    this.#debugOverlay = null;

    this.#scene?.dispose();
    this.#scene = null;

    this.#rendererHandle?.dispose();
    this.#rendererHandle = null;

    this.#canvas?.remove();
    this.#canvas = null;

    this.#bootOverlay.dispose();
  }

  async #boot(): Promise<void> {
    log.info(`booting ${appConfig.appTitle} (dev=${String(appConfig.isDev)})`);

    // I. Graphics capability check.
    // 1. Yielding first guarantees the loading card is painted before the probe
    //    allocates a throwaway GL context.
    this.#bootOverlay.showLoading('正在检测图形能力…');
    await nextAnimationFrame();

    if (detectGraphicsBackend(document.createElement('canvas')) === 'none') {
      throw new AppError('WEBGL_UNAVAILABLE', 'Graphics probe reported no WebGL 2 support.');
    }

    // II. Renderer creation.
    this.#bootOverlay.showLoading('正在创建渲染器…');
    await nextAnimationFrame();

    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    canvas.dataset['testid'] = 'game-canvas';
    // The canvas is focusable so that keyboard input works before the player
    // clicks; pointer lock later takes over for mouse look.
    canvas.tabIndex = 0;
    this.#root.append(canvas);
    this.#canvas = canvas;

    this.#rendererHandle = createRenderer(canvas);

    // III. Scene construction.
    this.#bootOverlay.showLoading('正在构建场景…');
    await nextAnimationFrame();

    const scene = createSmokeTestScene();
    this.#scene = scene;

    // IV. Overlays and resize handling.
    this.#debugOverlay = new DebugOverlay(this.#root, {
      rows: WORLD_ROWS,
      visible: this.#showDebug,
    });
    this.#debugOverlay.set(
      'seed',
      appConfig.defaultWorldSeed === '' ? '(random)' : appConfig.defaultWorldSeed,
    );
    this.#debugOverlay.set('renderDistance', '—');

    this.#installResizeHandling();
    window.addEventListener('keydown', this.#onKeyDown);

    // V. Start the loop. The loading overlay is dismissed from inside the first
    //    rendered frame, which is the only reliable signal that something is
    //    actually on screen.
    this.#loop = new GameLoop({
      onFixedStep: (deltaSeconds): void => {
        this.#scene?.update(deltaSeconds);
      },
      onRenderFrame: (info): void => {
        this.#renderFrame(info);
      },
    });
    this.#loop.start();

    log.info('boot complete, loop started');
  }

  #installResizeHandling(): void {
    const resize = (): void => {
      this.#applySize();
    };
    resize();

    // I. ResizeObserver is preferred over the `resize` event because the canvas
    //    is layout-driven; it also fires when dev tools are docked.
    // 1. The guard keeps the class usable under jsdom, which does not implement
    //    ResizeObserver.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resize);
      return;
    }
    this.#resizeObserver = new ResizeObserver(resize);
    this.#resizeObserver.observe(this.#root);
  }

  #applySize(): void {
    const renderer = this.#rendererHandle?.renderer;
    const scene = this.#scene;
    const canvas = this.#canvas;
    if (renderer === undefined || scene === null || canvas === null) {
      return;
    }

    // I. Size from the canvas' own client box rather than `window.innerWidth`
    //    so that HUD panels can shrink the viewport without distorting the
    //    projection.
    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);

    renderer.setSize(width, height, false);
    const camera: THREE.PerspectiveCamera = scene.camera;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  #renderFrame(info: RenderFrameInfo): void {
    const renderer = this.#rendererHandle?.renderer;
    const scene = this.#scene;
    if (renderer === undefined || scene === null) {
      return;
    }

    this.#frameStats.record(info.deltaSeconds * 1000);

    renderer.render(scene.scene, scene.camera);

    // I. Refresh the overlay after rendering so that `renderer.info` describes
    //    the frame that was just presented.
    const stats = this.#frameStats.snapshot();
    const overlay = this.#debugOverlay;
    if (overlay !== null && overlay.visible) {
      overlay.setNumber('fps', Math.round(stats.fps));
      overlay.set('frameTime', `${stats.frameTimeMs.toFixed(2)} ms`);
      overlay.set('drawCalls', String(renderer.info.render.calls));
      overlay.set('triangles', renderer.info.render.triangles.toLocaleString('en-US'));
      overlay.set('position', '—');
      overlay.set('chunk', '—');
      overlay.set('chunks', '—');
      overlay.set('time', '—');
    }

    // II. Dismiss the loading screen once a frame is really on screen.
    if (!this.#booted) {
      this.#booted = true;
      this.#bootOverlay.hide();
    }
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    // F3 mirrors the debug-view convention players already know; F1 is left for
    // a future help overlay.
    if (event.code === 'F3') {
      event.preventDefault();
      this.#debugOverlay?.toggle();
    }
  };
}
