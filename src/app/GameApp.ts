/**
 * Application root.
 *
 * I. Responsibilities
 *
 * 1. Owns everything whose lifetime is the whole page: the canvas, the renderer,
 *    the event bus, settings, audio, the save manager and the state machine.
 * 2. Owns the boot sequence, which is deliberately linear and yields to the
 *    compositor between stages so the loading screen stays responsive.
 * 3. Owns the frame callback that connects the fixed-step simulation to the
 *    renderer, the session and the debug overlay.
 *
 * II. What it must not do
 *
 * It contains no gameplay rules and no world data. A world lives in a
 * {@link WorldSession}; this class only creates one, drives it and disposes it.
 * That boundary is what makes "return to the main menu" a genuine teardown
 * instead of a partial one that leaks chunks, workers and listeners.
 *
 * @module app/GameApp
 */

import * as THREE from 'three';

import { AudioManager } from '@/audio/AudioManager';
import { appConfig } from '@/config/env';
import { DebugOverlay, type DebugRow } from '@/debug/DebugOverlay';
import { FrameStats } from '@/engine/core/FrameStats';
import { GameLoop, type RenderFrameInfo } from '@/engine/core/GameLoop';
import { EventBus } from '@/engine/events/EventBus';
import { createRenderer, type RendererHandle } from '@/rendering/createRenderer';
import { SaveManager } from '@/save/SaveManager';
import { SettingsStore } from '@/settings/SettingsStore';
import { qualityProfileFor } from '@/settings/types';
import { BootOverlay } from '@/ui/BootOverlay';
import { MainMenu } from '@/ui/MainMenu';
import { SettingsScreen } from '@/ui/SettingsScreen';
import { nextAnimationFrame } from '@/utils/async';
import { AppError, toAppError } from '@/utils/errors';
import { logger } from '@/utils/logger';

import type { LoadedWorld } from '@/save/SaveManager';

import { detectGraphicsBackend } from '../rendering/capabilities';

import { GameStateMachine } from './GameState';
import { WorldSession } from './WorldSession';

const log = logger.child('app');

/** Debug overlay rows for the running world. */
const WORLD_ROWS: readonly DebugRow[] = [
  { key: 'position', label: 'Position' },
  { key: 'chunk', label: 'Chunk' },
  { key: 'chunks', label: 'Chunks' },
  { key: 'renderDistance', label: 'Render dist' },
  { key: 'seed', label: 'Seed' },
  { key: 'time', label: 'Time' },
  { key: 'entities', label: 'Drops' },
  { key: 'particles', label: 'Particles' },
];

/** Version label shown on the main menu. */
const APP_VERSION = '0.1.0';

export interface GameAppOptions {
  /** Shows the debug overlay immediately. Defaults to the environment flag. */
  readonly showDebugOverlay?: boolean;
}

export class GameApp {
  readonly #root: HTMLElement;
  readonly #bootOverlay: BootOverlay;
  readonly #frameStats = new FrameStats();
  readonly #bus = new EventBus();
  readonly #state = new GameStateMachine('boot');
  readonly #settings: SettingsStore;

  #debugOverlay: DebugOverlay | null = null;
  #rendererHandle: RendererHandle | null = null;
  #canvas: HTMLCanvasElement | null = null;
  #loop: GameLoop | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #audio: AudioManager | null = null;
  #save: SaveManager | null = null;
  #mainMenu: MainMenu | null = null;
  #settingsScreen: SettingsScreen | null = null;
  #session: WorldSession | null = null;
  #showDebug: boolean;
  #disposed = false;
  #booted = false;

  public constructor(root: HTMLElement, options: GameAppOptions = {}) {
    this.#root = root;
    this.#bootOverlay = new BootOverlay(root);
    this.#settings = new SettingsStore();
    this.#showDebug = options.showDebugOverlay ?? appConfig.debugOverlayByDefault;
  }

  /** True once the first frame has been presented to the player. */
  public get booted(): boolean {
    return this.#booted;
  }

  /**
   * Runs the boot sequence and starts the game loop.
   *
   * Never throws: failures are presented through the boot overlay, so callers do
   * not have to duplicate error UI.
   */
  public async start(): Promise<void> {
    try {
      await this.#boot();
    } catch (error) {
      const appError = toAppError(error);
      log.error(`boot failed: ${appError.code}`, appError);
      this.#bootOverlay.showFatal(appError);
      this.#state.transition('error');
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
    window.removeEventListener('pointerdown', this.#unlockAudio);

    this.#session?.dispose();
    this.#session = null;

    this.#mainMenu?.dispose();
    this.#settingsScreen?.dispose();
    this.#debugOverlay?.dispose();
    // `dispose()` closes the AudioContext and therefore returns a promise.
    void this.#audio?.dispose();
    this.#save?.dispose();
    this.#bus.clear();

    this.#rendererHandle?.dispose();
    this.#rendererHandle = null;
    this.#canvas?.remove();
    this.#canvas = null;

    this.#bootOverlay.dispose();
  }

  async #boot(): Promise<void> {
    log.info(`booting ${appConfig.appTitle} (dev=${String(appConfig.isDev)})`);

    // I. Graphics capability check. Yielding first guarantees the loading card is
    //    painted before the probe allocates a throwaway GL context.
    this.#bootOverlay.showLoading('正在检测图形能力…');
    await nextAnimationFrame();

    if (detectGraphicsBackend(document.createElement('canvas')) === 'none') {
      throw new AppError('WEBGL_UNAVAILABLE', 'Graphics probe reported no WebGL 2 support.');
    }

    // II. Renderer.
    this.#bootOverlay.showLoading('正在创建渲染器…');
    await nextAnimationFrame();

    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    canvas.dataset['testid'] = 'game-canvas';
    canvas.tabIndex = 0;
    this.#root.append(canvas);
    this.#canvas = canvas;

    const profile = qualityProfileFor(this.#settings.current);
    this.#rendererHandle = createRenderer(canvas, {
      pixelRatioCap: profile.pixelRatioCap,
      shadows: profile.shadows,
      antialias: profile.antialias,
    });

    // III. Services.
    this.#bootOverlay.showLoading('正在加载设置与存档…');
    await nextAnimationFrame();

    this.#audio = new AudioManager();
    this.#save = new SaveManager();
    this.#audio.applySettings(this.#settings.current);

    // IV. Menus.
    this.#mainMenu = new MainMenu(this.#root, {
      onStart: () => {
        void this.#enterWorld(true);
      },
      onNewWorld: (seed) => {
        void this.#enterWorld(false, seed);
      },
      onSettings: () => {
        this.#openSettings();
      },
      version: APP_VERSION,
      onOpen: () => {
        if (this.#state.current === 'boot') {
          this.#state.transition('menu');
        }
      },
    });

    this.#settingsScreen = new SettingsScreen(this.#root, {
      onChange: (patch) => {
        this.#settings.update(patch);
        // Volume and quality changes must be audible and visible immediately;
        // waiting for the screen to close would make the sliders feel dead.
        this.#audio?.applySettings(this.#settings.current);
        this.#session?.applySettings();
      },
      onBack: () => {
        this.#closeSettings();
      },
      onClose: () => {
        this.#closeSettings();
      },
    });

    // V. Overlay and resize handling.
    this.#debugOverlay = new DebugOverlay(this.#root, {
      rows: WORLD_ROWS,
      visible: this.#showDebug,
    });
    this.#debugOverlay.set(
      'seed',
      appConfig.defaultWorldSeed === '' ? '随机' : appConfig.defaultWorldSeed,
    );
    this.#installResizeHandling();

    window.addEventListener('keydown', this.#onKeyDown);
    // Browsers only allow an AudioContext to start inside a user gesture, so the
    // very first pointer press anywhere unlocks audio.
    window.addEventListener('pointerdown', this.#unlockAudio);

    // VI. Start the loop, then show the menu.
    this.#loop = new GameLoop({
      onFixedStep: (deltaSeconds): void => {
        if (this.#state.info.simulates) {
          this.#session?.fixedStep(deltaSeconds);
        }
      },
      onRenderFrame: (info): void => {
        this.#renderFrame(info);
      },
    });
    this.#loop.start();

    await this.#refreshMenu();

    log.info('boot complete, loop started');
  }

  #installResizeHandling(): void {
    const resize = (): void => {
      this.#applySize();
    };
    resize();

    // ResizeObserver is preferred over the `resize` event because the canvas is
    // layout driven; the guard keeps the class usable under jsdom.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', resize);
      return;
    }
    this.#resizeObserver = new ResizeObserver(resize);
    this.#resizeObserver.observe(this.#root);
  }

  #applySize(): void {
    const renderer = this.#rendererHandle?.renderer;
    const canvas = this.#canvas;
    if (renderer === undefined || canvas === null) {
      return;
    }

    const width = Math.max(1, canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, canvas.clientHeight || window.innerHeight);

    renderer.setSize(width, height, false);

    const session = this.#session;
    if (session !== null) {
      session.camera.aspect = width / height;
      session.camera.updateProjectionMatrix();
    }
  }

  #renderFrame(info: RenderFrameInfo): void {
    const renderer = this.#rendererHandle?.renderer;
    if (renderer === undefined) {
      return;
    }

    this.#frameStats.record(info.deltaSeconds * 1000);

    const session = this.#session;
    if (session !== null) {
      this.#syncCameraToRenderer(renderer, session);
      session.render(info.deltaSeconds, info.interpolation);
      renderer.render(session.scene, session.camera);
    }

    this.#updateDebugOverlay(renderer);

    if (!this.#booted) {
      this.#booted = true;
      this.#bootOverlay.hide();
    }
  }

  /**
   * Keeps the renderer's aspect in step with the session camera.
   *
   * The camera is recreated with every world, so the aspect applied during boot
   * would otherwise be lost as soon as a world is entered.
   */
  #syncCameraToRenderer(renderer: THREE.WebGLRenderer, session: WorldSession): void {
    const size = renderer.getSize(new THREE.Vector2());
    const aspect = size.x / Math.max(1, size.y);
    if (Math.abs(session.camera.aspect - aspect) > 1e-4) {
      session.camera.aspect = aspect;
      session.camera.updateProjectionMatrix();
    }
  }

  #updateDebugOverlay(renderer: THREE.WebGLRenderer): void {
    const overlay = this.#debugOverlay;
    if (overlay === null || !overlay.visible) {
      return;
    }

    const stats = this.#frameStats.snapshot();
    overlay.setNumber('fps', Math.round(stats.fps));
    overlay.set('frameTime', `${stats.frameTimeMs.toFixed(2)} ms`);
    overlay.set('drawCalls', String(renderer.info.render.calls));
    overlay.set('triangles', renderer.info.render.triangles.toLocaleString('en-US'));

    const session = this.#session;
    if (session === null) {
      overlay.set('position', '—');
      overlay.set('chunk', '—');
      overlay.set('chunks', '—');
      overlay.set('entities', '—');
      overlay.set('particles', '—');
      overlay.set('time', '—');
      return;
    }

    const position = session.camera.position;
    const worldStats = session.stats();
    const chunk = session.world.chunkOf(position.x, position.z);
    overlay.set(
      'position',
      `${position.x.toFixed(1)} ${position.y.toFixed(1)} ${position.z.toFixed(1)}`,
    );
    overlay.set('chunk', `${chunk.cx} ${chunk.cz}`);
    overlay.set('chunks', `${worldStats.chunks} (+${worldStats.queued}q/${worldStats.inFlight}f)`);
    overlay.set('renderDistance', `${this.#settings.current.renderDistance} chunks`);
    overlay.set('entities', String(worldStats.drops));
    overlay.set('particles', String(worldStats.particles));
    overlay.set('time', `${Math.round(worldStats.timeTicks)} t`);
  }

  /** Starts a new world, or continues the most recent save. */
  async #enterWorld(continueExisting: boolean, seedText = ''): Promise<void> {
    const save = this.#save;
    if (this.#disposed || this.#session !== null || save === null) {
      return;
    }

    this.#state.transition('world-loading');
    this.#mainMenu?.hide();
    this.#bootOverlay.showLoading(continueExisting ? '正在读取存档…' : '正在生成世界…');
    await nextAnimationFrame();

    let worldId = `world-${Date.now().toString(36)}`;
    let worldName = '新的世界';
    let seed: number | string = seedText.trim() === '' ? appConfig.defaultWorldSeed : seedText;
    if (seed === '') {
      seed = Math.floor(Math.random() * 0x7fffffff);
    }
    let restored: LoadedWorld | null = null;

    try {
      if (continueExisting) {
        const worlds = await save.listWorlds();
        const latest = worlds[0];
        if (latest === undefined) {
          // Nothing to continue: fall through to a fresh world and say so, rather
          // than dropping the player back on the menu with no explanation.
          this.#bus.emit('ui:notice', { text: '没有找到存档，已创建新世界', tone: 'info' });
        } else {
          restored = await save.loadWorld(latest.id);
          worldId = restored.worldId;
          worldName = restored.worldName;
          seed = restored.seed;
        }
      }

      const session = new WorldSession({
        root: this.#root,
        renderer: this.#requireRenderer(),
        bus: this.#bus,
        settings: this.#settings,
        audio: this.#requireAudio(),
        save,
        state: this.#state,
        worldId,
        worldName,
        seed,
        restored,
        onRequestSettings: () => {
          this.#openSettings();
        },
        onQuitToMenu: () => {
          void this.#leaveWorld();
        },
      });
      this.#session = session;

      this.#bootOverlay.showLoading('正在生成地形…');
      await session.start();

      this.#applySize();
      this.#state.transition('playing');
      this.#bootOverlay.hide();
      this.#debugOverlay?.toggle(this.#showDebug);
      this.#bus.emit('ui:notice', { text: `已进入世界：${worldName}`, tone: 'info' });
    } catch (error) {
      const appError = toAppError(error, 'WORLD_GENERATION_FAILED');
      log.error('entering the world failed', appError);
      this.#session?.dispose();
      this.#session = null;
      this.#bootOverlay.showFatal(appError);
      this.#state.transition('error');
    }
  }

  /** Disposes the session and returns to the main menu. */
  async #leaveWorld(): Promise<void> {
    this.#session?.dispose();
    this.#session = null;
    this.#state.transition('menu');
    await this.#refreshMenu();
  }

  async #refreshMenu(): Promise<void> {
    const menu = this.#mainMenu;
    const save = this.#save;
    if (menu === null || save === null) {
      return;
    }

    let hasSave: boolean;
    try {
      hasSave = (await save.listWorlds()).length > 0;
    } catch {
      // A blocked storage backend must not stop the player from starting a new
      // world, so the failure only disables "continue".
      hasSave = false;
    }

    menu.update({ hasSave, version: APP_VERSION });
    menu.setCanReturn(false);
    menu.show();

    // The boot overlay is re-shown for later stages ("正在生成世界…"), so it must
    // be dismissed here explicitly. Relying on the first-frame hook alone left the
    // loading card stacked on top of the menu forever.
    this.#bootOverlay.hide();
    // The engine metrics belong to a running world; showing them over the menu
    // looks like debris.
    this.#debugOverlay?.toggle(false);
  }

  #openSettings(): void {
    const screen = this.#settingsScreen;
    if (screen === null) {
      return;
    }
    screen.update(this.#settings.current);
    screen.show();
    this.#mainMenu?.hide();
    this.#session?.setSettingsVisible(true);
    if (this.#state.canTransitionTo('settings')) {
      this.#state.transition('settings');
    }
  }

  #closeSettings(): void {
    this.#settingsScreen?.hide();
    const session = this.#session;
    if (session !== null) {
      session.setSettingsVisible(false);
      session.applySettings();
      this.#state.leaveSettings();
      return;
    }
    this.#state.leaveSettings();
    void this.#refreshMenu();
  }

  #requireRenderer(): THREE.WebGLRenderer {
    const renderer = this.#rendererHandle?.renderer;
    if (renderer === undefined) {
      throw new AppError('RENDERER_INIT_FAILED', 'The renderer is not available.');
    }
    return renderer;
  }

  #requireAudio(): AudioManager {
    this.#audio ??= new AudioManager();
    return this.#audio;
  }

  #unlockAudio = (): void => {
    // `unlock()` resolves to a boolean; the caller has nothing to do with it, and
    // an unhandled floating promise would trip the lint gate.
    void this.#audio?.unlock();
  };

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'F3') {
      event.preventDefault();
      this.#debugOverlay?.toggle();
      return;
    }

    const session = this.#session;
    if (session === null) {
      return;
    }

    // I. Shortcuts are state dependent.
    // 1. `inventory` must be accepted as well as `playing`: opening the panel
    //    moves the game into the `inventory` state, so a check for `playing`
    //    alone let the player open the bag but never close it with the same key.
    if (
      event.code === 'KeyE' &&
      (this.#state.current === 'playing' || this.#state.current === 'inventory')
    ) {
      event.preventDefault();
      session.toggleInventory();
      return;
    }
    if (event.code === 'Escape') {
      event.preventDefault();
      if (session.inventoryOpen) {
        session.toggleInventory();
        return;
      }
      session.togglePause();
    }
  };
}
