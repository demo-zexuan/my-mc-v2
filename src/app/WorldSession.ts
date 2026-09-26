/**
 * A playable world session.
 *
 * I. Responsibility
 *
 * Owns everything whose lifetime is "one world": the world data, the chunk
 * streamer, the renderer for chunks and sky, the player, the interaction systems
 * and the in-game HUD. Creating a session enters a world; disposing it must leave
 * no trace — no GPU buffers, no worker threads, no DOM nodes, no event
 * subscriptions.
 *
 * II. Why it is separate from `GameApp`
 *
 * `GameApp` owns the *application*: the canvas, the boot sequence, the menus and
 * the state machine. Those outlive any individual world. Merging the two would
 * mean the main menu, the settings screen and the renderer all had to be
 * re-created for every world, and it would make "return to the main menu" a
 * partial teardown — the classic source of leaked chunks and double-subscribed
 * listeners when a player enters a second world.
 *
 * III. Update contract
 *
 * `fixedStep` advances simulation at a constant 1/60 s and `render` runs once per
 * animation frame. Keeping them apart is what makes collision and mining
 * deterministic regardless of the display's refresh rate.
 *
 * @module app/WorldSession
 */

import * as THREE from 'three';

import { type AudioManager } from '@/audio/AudioManager';
import { materialForBlockName, soundNameFor } from '@/audio/SoundBank';
import { type EventBus } from '@/engine/events/EventBus';
import { DropSystem } from '@/entities/DropSystem';
import { InputManager } from '@/input/InputManager';
import { BlockInteraction } from '@/interaction/BlockInteraction';
import { BlockSelector } from '@/interaction/BlockSelector';
import { MiningSystem } from '@/interaction/MiningSystem';
import { createHit, type InteractionHit } from '@/interaction/types';
import { PlayerInventory } from '@/inventory/Inventory';
import { MAX_STACK_SIZE } from '@/inventory/types';
import { ParticleSystem } from '@/particles/ParticleSystem';
import { PLAYER_EYE_HEIGHT } from '@/player/Player';
import { PlayerController } from '@/player/PlayerController';
import { BlockOutline } from '@/rendering/BlockOutline';
import { createEnvironment, type EnvironmentRig } from '@/rendering/Environment';
import { DayNightCycle, Sky } from '@/rendering/Sky';
import { WorldRenderer } from '@/rendering/WorldRenderer';
import { BlockAtlas } from '@/rendering/textures/BlockAtlas';
import { raycastVoxels } from '@/physics/VoxelRaycast';
import type { SettingsStore } from '@/settings/SettingsStore';
import { qualityProfileFor } from '@/settings/types';
import type { LoadedWorld, SaveManager } from '@/save/SaveManager';
import type { SaveWorldInput } from '@/save/saveSchema';
import { createTerrainGenerator } from '@/terrain/TerrainGenerator';
import { Crosshair } from '@/ui/Crosshair';
import { Hotbar } from '@/ui/Hotbar';
import { Hud } from '@/ui/Hud';
import { InventoryScreen } from '@/ui/InventoryScreen';
import { NoticeStack } from '@/ui/NoticeStack';
import { PauseMenu } from '@/ui/PauseMenu';
import { WorkerPool } from '@/workers/WorkerPool';
import { BlockId, definitionOf } from '@/world/BlockRegistry';
import { type Chunk } from '@/world/Chunk';
import { ChunkStreamer } from '@/world/ChunkStreamer';
import { World } from '@/world/World';
import { blockToLocal } from '@/world/coords';
import type { Vec3 } from '@/physics/Vec3';
import { logger } from '@/utils/logger';

import type { GameStateMachine } from './GameState';

const log = logger.child('session');

/** Distance the player can reach to break or place a block. */
const REACH = 5;

/** Ticks in one in-game day; matches the HUD's clock. */
const TICKS_PER_DAY = 24000;

export interface WorldSessionOptions {
  /** Host element for the in-game HUD. */
  readonly root: HTMLElement;
  /** Renderer owned by `GameApp`. */
  readonly renderer: THREE.WebGLRenderer;
  readonly bus: EventBus;
  readonly settings: SettingsStore;
  readonly audio: AudioManager;
  readonly save: SaveManager;
  readonly state: GameStateMachine;
  readonly worldId: string;
  readonly worldName: string;
  /** Seed as typed by the player, or a number for a restored world. */
  readonly seed: number | string;
  /** Restored state from the save file, when continuing an existing world. */
  readonly restored: LoadedWorld | null;
  /** Invoked when the player asks for the settings screen from the pause menu. */
  readonly onRequestSettings: () => void;
  /** Invoked when the player saves and leaves the world. */
  readonly onQuitToMenu: () => void;
}

export class WorldSession {
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly world: World;
  public readonly inventory: PlayerInventory;

  readonly #options: WorldSessionOptions;
  readonly #environment: EnvironmentRig;
  readonly #atlas: BlockAtlas;
  readonly #outline: BlockOutline;
  readonly #worldRenderer: WorldRenderer;
  readonly #dayNight: DayNightCycle;
  readonly #sky: Sky;
  readonly #pool: WorkerPool;
  readonly #streamer: ChunkStreamer;
  readonly #input: InputManager;
  readonly #playerController: PlayerController;
  readonly #selector: BlockSelector;
  readonly #mining: MiningSystem;
  readonly #interaction: BlockInteraction;
  readonly #drops: DropSystem;
  readonly #particles: ParticleSystem;
  readonly #crosshair: Crosshair;
  readonly #hotbar: Hotbar;
  readonly #hud: Hud;
  readonly #notices: NoticeStack;
  readonly #inventoryScreen: InventoryScreen;
  readonly #pauseMenu: PauseMenu;

  #disposed = false;
  #gameTimeTicks: number;
  #playTimeMs = 0;
  #facing = '北';

  public constructor(options: WorldSessionOptions) {
    this.#options = options;
    this.#gameTimeTicks = (options.restored?.gameTime ?? 0) % TICKS_PER_DAY;

    // I. Scene, camera and lighting.
    this.scene = new THREE.Scene();
    this.scene.name = `world:${options.worldId}`;
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    this.camera.name = 'player-camera';
    this.#environment = createEnvironment(this.scene, { shadowExtent: 120 });

    // II. World and streaming.
    // The terrain factory takes a numeric seed; a typed seed is folded into one
    // here so the same text always produces the same world.
    const numericSeed = seedToNumber(options.seed);
    const generator = createTerrainGenerator(numericSeed);
    this.world = new World({ seed: generator.seed, generator });
    this.#pool = new WorkerPool({ seed: generator.seed, generatorFactory: createTerrainGenerator });
    this.#streamer = new ChunkStreamer({
      world: this.world,
      source: this.#pool,
      renderDistance: options.settings.current.renderDistance,
    });
    this.#streamer.setOnEditedChunkUnloaded((chunk) => {
      // Persisting on unload means a build is never lost just because the player
      // walked away before the next autosave.
      options.save.noteChunkModified(chunk.editCount);
      this.#pendingUnloads.push(chunk);
    });

    // III. Rendering of the world itself.
    this.#atlas = new BlockAtlas();
    // The player must be able to see which block the crosshair is on; without an
    // outline the only feedback is the crosshair changing shape, which is invisible
    // when the crosshair is already over a solid surface.
    this.#outline = new BlockOutline(this.scene);
    this.#worldRenderer = new WorldRenderer(this.scene, { atlas: this.#atlas });
    // I. Only a restored world reuses its saved clock.
    // 1. `timeOfDay` is 0 at midnight, so seeding a *new* world from
    //    `gameTime ?? 0` started every fresh game in pitch darkness. The cycle's
    //    own default (early morning) is the right answer here.
    this.#dayNight = new DayNightCycle(
      options.restored === null ? {} : { startTime: this.#gameTimeTicks / TICKS_PER_DAY },
    );
    this.#gameTimeTicks = this.#dayNight.timeOfDay * TICKS_PER_DAY;
    this.#sky = new Sky(this.scene, { cycle: this.#dayNight });
    this.#sky.applyFog(this.scene.fog);

    // IV. Player.
    this.inventory = new PlayerInventory();
    if (options.restored !== null) {
      this.inventory.restore(options.restored.player.inventory);
    }
    this.#input = new InputManager({
      element: options.renderer.domElement,
      onPointerLockChange: (locked) => {
        this.#onPointerLockChange(locked);
      },
    });
    const restoredPosition = options.restored?.player.position;
    const spawn =
      restoredPosition === undefined
        ? this.#findSpawn()
        : { x: restoredPosition.x, y: restoredPosition.y, z: restoredPosition.z };
    this.#playerController = new PlayerController({
      world: this.world,
      input: this.#input,
      events: options.bus,
      settings: options.settings.current,
      spawn,
    });

    // V. Interaction.
    this.#selector = new BlockSelector(options.bus);
    this.#mining = new MiningSystem({ world: this.world, bus: options.bus });
    this.#interaction = new BlockInteraction({
      world: this.world,
      bus: options.bus,
      inventory: this.inventory,
      getPlayerBox: () => {
        // The collider stores a centre position plus half extent; the interaction
        // layer wants box bounds, so the conversion lives here rather than in
        // either of the two modules.
        const body = this.#playerController.player.body;
        const position = body.position;
        return {
          minX: position.x - body.halfWidth,
          minY: position.y,
          minZ: position.z - body.halfWidth,
          maxX: position.x + body.halfWidth,
          maxY: position.y + body.height,
          maxZ: position.z + body.halfWidth,
        };
      },
      maxDistance: REACH,
    });
    this.#drops = new DropSystem({
      world: this.world,
      bus: options.bus,
      inventory: this.inventory,
      getPlayerPosition: () => this.#playerController.player.position,
    });
    this.#particles = new ParticleSystem({ bus: options.bus, parent: this.scene });

    // VI. HUD.
    this.#crosshair = new Crosshair(options.root);
    this.#hotbar = new Hotbar(options.root, {
      onSelect: (index) => {
        this.inventory.select(index);
      },
    });
    this.#hud = new Hud(options.root);
    this.#notices = new NoticeStack(options.root);
    this.#inventoryScreen = new InventoryScreen(options.root, {
      onMove: (from, to) => {
        this.inventory.moveSlot(from, to);
      },
      onSplit: (from, to) => {
        this.inventory.splitSlot(from, to);
      },
      onQuickMove: (index) => {
        this.#quickMove(index);
      },
      onOpen: () => {
        this.#input.exitPointerLock();
      },
    });
    this.#pauseMenu = new PauseMenu(options.root, {
      onResume: () => {
        this.#options.state.transition('playing');
      },
      onSettings: () => {
        options.onRequestSettings();
      },
      onSaveAndQuit: () => {
        void this.#saveAndQuit();
      },
      onOpen: () => {
        this.#input.exitPointerLock();
      },
    });

    // I. HUD widgets start hidden.
    // 1. They are created hidden so a caller can build them before the world is
    //    ready without flashing placeholder text. Entering a world is exactly the
    //    moment they must appear.
    this.#crosshair.show();
    this.#hotbar.show();
    this.#hud.show();

    this.#wireEvents();
  }

  /** Kick-off: warms the spawn area and places the player on solid ground. */
  public async start(): Promise<void> {
    // A small preload is enough to make the first frame meaningful; the rest
    // streams in while the player looks around.
    await this.#streamer.preload(
      this.#playerController.player.position.x,
      this.#playerController.player.position.z,
      2,
    );
    this.#placeOnSurface();
    this.#options.save.startAutosave(() => this.buildSaveInput());
  }

  /** Advances simulation. Called at the fixed timestep. */
  public fixedStep(deltaSeconds: number): void {
    if (this.#disposed) {
      return;
    }

    this.#playTimeMs += deltaSeconds * 1000;
    this.#dayNight.advance(deltaSeconds);
    this.#gameTimeTicks = (this.#dayNight.timeOfDay * TICKS_PER_DAY) % TICKS_PER_DAY;

    // I. Looking around happens before moving, so the movement direction matches
    //    the direction the player currently sees.
    const look = this.#input.consumeLookDelta();
    if (look.dx !== 0 || look.dy !== 0) {
      this.#playerController.cameraRig.applyLook(look.dx, look.dy);
    }

    this.#playerController.update(deltaSeconds);

    // II. Interaction.
    const hit = this.#raycast();
    if (this.#selector.update(hit)) {
      this.#mining.setTarget(hit);
    }

    const attacking = this.#options.state.interactive && this.#input.isActionDown('attack');
    this.#mining.tick(deltaSeconds, attacking);

    if (this.#options.state.interactive && this.#input.wasActionPressed('use')) {
      this.#interaction.place(hit);
    }

    // III. Entities and effects.
    this.#drops.update(deltaSeconds);
    this.#particles.update(deltaSeconds);

    // IV. Streaming and autosave.
    const position = this.#playerController.player.position;
    this.#streamer.update(position.x, position.z);
    // The autosave path reports failures through the bus instead of rejecting, so
    // the promise is intentionally not awaited on the simulation hot path.
    void this.#options.save.tickAutosave();

    // V. Clear the edge-triggered input state.
    // 1. `wasActionPressed` is only true for one step. Without this call the flags
    //    would never be cleared, so holding nothing at all would still place a
    //    block every single step.
    this.#input.endStep();
  }

  /**
   * Presents the frame.
   *
   * @param deltaSeconds - Wall-clock seconds since the previous frame.
   * @param interpolation - Blend factor between simulation steps, used so the
   *        camera moves smoothly even though physics advances discretely.
   */
  public render(deltaSeconds: number, interpolation: number): void {
    if (this.#disposed) {
      return;
    }

    const player = this.#playerController.player;
    // The controller owns the eye offset, head bob and the interpolation between
    // physics steps; driving the camera from anywhere else would duplicate that.
    this.#playerController.applyCamera(this.camera, interpolation);
    this.#worldRenderer.update(this.world, this.camera);
    this.#sky.update(deltaSeconds, this.camera.position);

    this.#syncLighting();

    // I. HUD refresh. Reading the snapshot once keeps the three widgets showing
    //    the same inventory state within a frame.
    const snapshot = this.inventory.snapshot();
    this.#hotbar.update(snapshot);
    if (this.#inventoryScreen.visible) {
      this.#inventoryScreen.update(snapshot);
    }

    // I. Selection feedback.
    // 1. The outline follows the block under the crosshair and is hidden when there
    //    is no target, so the player always knows what a click would affect.
    this.#outline.update(this.#selector.current);

    const selected = snapshot.slots[snapshot.selected] ?? null;
    this.#crosshair.update({
      interactable: this.#selector.hasTarget,
      ...(selected === null
        ? {}
        : { label: `${definitionOf(selected.item).displayName} ×${selected.count}` }),
    });

    const position = player.position;
    const chunk = this.world.chunkOf(position.x, position.z);
    this.#hud.update({
      position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
      chunk: { x: chunk.cx, z: chunk.cz },
      biome: this.world.generator.biomeAt(position.x, position.z),
      timeTicks: this.#gameTimeTicks,
      facing: this.#facing,
    });

    // The held stack changed on pick-up or after placing, so the panel is kept in
    // step here rather than requiring every mutation site to remember.
    if (this.#inventoryScreen.visible) {
      this.#inventoryScreen.update(this.inventory.snapshot());
    }
  }

  /** Applies settings that can change while a world is open. */
  public applySettings(): void {
    const settings = this.#options.settings.current;
    this.#playerController.setSettings(settings);
    this.#streamer.setRenderDistance(settings.renderDistance);
    const profile = qualityProfileFor(settings);
    this.#options.renderer.shadowMap.enabled = profile.shadows;
    this.#environment.sunLight.castShadow = profile.shadows;
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh === true) {
        mesh.castShadow = mesh.castShadow && profile.shadows;
        mesh.receiveShadow = mesh.receiveShadow && profile.shadows;
      }
    });
  }

  /** Serialises the current state for the save system. */
  public buildSaveInput(): SaveWorldInput {
    const player = this.#playerController.player;
    const rig = this.#playerController.cameraRig;
    const chunks: { cx: number; cz: number; edits: readonly { index: number; id: BlockId }[] }[] =
      [];
    for (const chunk of this.world.editedChunks()) {
      chunks.push({ cx: chunk.cx, cz: chunk.cz, edits: chunk.getEdits() });
    }
    for (const chunk of this.#pendingUnloads.splice(0, this.#pendingUnloads.length)) {
      chunks.push({ cx: chunk.cx, cz: chunk.cz, edits: chunk.getEdits() });
    }

    return {
      id: this.#options.worldId,
      name: this.#options.worldName,
      seed: this.#options.seed,
      gameTime: this.#gameTimeTicks,
      player: {
        position: { x: player.position.x, y: player.position.y, z: player.position.z },
        rotation: { yaw: rig.yaw, pitch: rig.pitch },
        velocity: { x: player.velocity.x, y: player.velocity.y, z: player.velocity.z },
        health: 20,
        inventory: this.inventory.snapshot(),
      },
      settings: this.#options.settings.current,
      chunks,
    };
  }

  /** Statistics for the debug overlay. */
  public stats(): {
    chunks: number;
    queued: number;
    inFlight: number;
    drops: number;
    particles: number;
    timeTicks: number;
  } {
    const streamStats = this.#streamer.stats;
    return {
      chunks: streamStats.loaded,
      queued: streamStats.queued,
      inFlight: streamStats.inFlight,
      drops: this.#drops.count,
      particles: this.#particles.activeCount,
      timeTicks: this.#gameTimeTicks,
    };
  }

  /** True when the inventory panel is open. */
  public get inventoryOpen(): boolean {
    return this.#inventoryScreen.visible;
  }

  /** True when the pause menu is open. */
  public get paused(): boolean {
    return this.#pauseMenu.visible;
  }

  /** Opens or closes the inventory, keeping the game state in step. */
  public toggleInventory(): void {
    if (this.#inventoryScreen.visible) {
      this.#inventoryScreen.hide();
      this.#options.state.transition('playing');
      return;
    }

    // I. The state changes *before* the panel opens.
    // 1. Opening the panel releases pointer lock, and the browser answers with a
    //    `pointerlockchange` event. If the game were still in `playing` at that
    //    moment, that event would be read as "the player pressed Escape" and the
    //    pause menu would open on top of the inventory.
    this.#options.state.transition('inventory');
    this.#inventoryScreen.update(this.inventory.snapshot());
    this.#inventoryScreen.show();
  }

  /** Opens or closes the pause menu. */
  public togglePause(force?: boolean): void {
    const shouldShow = force ?? !this.#pauseMenu.visible;
    if (shouldShow) {
      // Same ordering rule as the inventory: the state must stop being `playing`
      // before pointer lock is released.
      if (this.#options.state.current === 'playing') {
        this.#options.state.transition('paused');
      }
      this.#showPauseMenu();
    } else {
      this.#pauseMenu.hide();
      if (this.#options.state.current === 'paused') {
        this.#options.state.transition('playing');
      }
    }
  }

  #pauseMenuBeforeSettings = false;

  /**
   * Opens the pause menu with a fresh snapshot.
   *
   * I. Why `setSettingsVisible` needs a remembered flag rather than re-reading
   *    `#pauseMenu.visible`
   *
   * Opening the settings screen hides the pause menu. Testing `visible` on the way
   * back therefore always read `false`, so the pause menu never returned and the
   * game sat in the `paused` state with no interface on screen at all.
   */
  #showPauseMenu(): void {
    this.#pauseMenu.update({
      playTimeMs: this.#playTimeMs,
      seedLabel: this.seedLabel,
      saving: false,
    });
    this.#pauseMenu.show();
  }

  /** Shows or hides the settings screen, preserving the screen underneath. */
  public setSettingsVisible(visible: boolean): void {
    if (visible) {
      this.#pauseMenuBeforeSettings = this.#pauseMenu.visible;
      if (this.#pauseMenuBeforeSettings) {
        this.#pauseMenu.hide();
      }
      return;
    }

    if (this.#pauseMenuBeforeSettings) {
      this.#showPauseMenu();
    }
    this.#pauseMenuBeforeSettings = false;
  }

  /** World seed as the player typed it, for the debug overlay and the pause menu. */
  public get seedLabel(): string {
    return typeof this.#options.seed === 'number'
      ? `seed-${this.#options.seed}`
      : this.#options.seed || '随机';
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    // I. Drop the subscriptions before anything else.
    // 1. Each listener is a closure over `this`, so a listener that outlives the
    //    session keeps the whole object graph alive: the UI elements it owns stay
    //    in memory as detached DOM nodes, and every world entry adds another set.
    //    Measured before this line existed: +9 listeners and ~245 detached nodes
    //    per entry, and the particles and sounds of a closed world still fired.
    for (const unsubscribe of this.#unsubscribe) {
      unsubscribe();
    }
    this.#unsubscribe.length = 0;

    this.#options.save.stopAutosave();
    this.#streamer.dispose();
    this.#pool.dispose();

    this.#input.dispose();
    this.#drops.dispose();
    this.#particles.dispose();
    this.#worldRenderer.dispose();
    this.#sky.dispose();
    this.#atlas.dispose();
    this.#outline.dispose();
    this.#environment.dispose();

    this.#crosshair.dispose();
    this.#hotbar.dispose();
    this.#hud.dispose();
    this.#notices.dispose();
    this.#inventoryScreen.dispose();
    this.#pauseMenu.dispose();

    this.world.clear();
    this.scene.clear();
  }

  /** Chunks unloaded while out of range, awaiting the next save. */
  readonly #pendingUnloads: Chunk[] = [];

  #unsubscribe: (() => void)[] = [];

  #wireEvents(): void {
    const bus = this.#options.bus;
    const audio = this.#options.audio;

    // I. Sound. The audio layer only understands materials, so the block name is
    //    resolved here where the block table is already in scope.
    this.#unsubscribe.push(
      bus.on('block:broken', ({ block, x, y, z }) => {
        const material = materialForBlockName(definitionOf(block).name);
        // Built through the helper rather than by string concatenation so the
        // material-to-sound mapping stays a single source of truth.
        audio.playSound(soundNameFor('break', material), { position: { x, y, z } });
      }),
      bus.on('block:placed', ({ x, y, z }) => {
        audio.playSound('block.place', { position: { x, y, z } });
      }),
      bus.on('item:collected', () => {
        audio.playSound('item.pickup');
      }),
      bus.on('ui:notice', (notice) => {
        // The bus speaks `warn`, the notice widget speaks `warning`; the mapping
        // lives here so neither side has to know the other's vocabulary.
        const kind = notice.tone === 'warn' ? 'warning' : notice.tone;
        this.#notices.push(notice.text, { kind });
      }),
      bus.on('player:landed', ({ distance }) => {
        if (distance > 0.8) {
          audio.playSound('player.land');
        }
      }),
    );

    // II. Every block change has to be counted for the autosave throttle.
    this.#unsubscribe.push(
      bus.on('block:broken', () => {
        this.#options.save.noteChunkModified(1);
      }),
      bus.on('block:placed', () => {
        this.#options.save.noteChunkModified(1);
      }),
    );
  }

  #onPointerLockChange(locked: boolean): void {
    if (this.#disposed) {
      return;
    }
    // Losing the lock without the game having asked for it means the player
    // pressed Escape: pause instead of leaving mouse look dead.
    if (!locked && this.#options.state.current === 'playing') {
      this.togglePause(true);
    }
  }

  /** Casts from the eye along the view direction and converts to an interaction hit. */
  #raycast(): InteractionHit | null {
    const rig = this.#playerController.cameraRig;
    const player = this.#playerController.player;
    const origin: Vec3 = {
      x: player.position.x,
      y: player.position.y + PLAYER_EYE_HEIGHT,
      z: player.position.z,
    };
    const direction: Vec3 = { x: 0, y: 0, z: 0 };
    rig.lookDirection(direction);

    const hit = raycastVoxels(
      { getBlock: (x, y, z) => this.world.getBlock(x, y, z) },
      origin,
      direction,
      REACH,
      // Water and air are not interactable: aiming at the sea floor would
      // otherwise place blocks onto the water surface instead.
      { predicate: (id) => id !== BlockId.Air && id !== BlockId.Water },
    );
    if (!hit.hit) {
      return null;
    }

    return createHit(
      hit.x,
      hit.y,
      hit.z,
      this.world.getBlock(hit.x, hit.y, hit.z),
      { x: hit.normal.x, y: hit.normal.y, z: hit.normal.z },
      hit.distance,
    );
  }

  /** Searches outwards for a column above sea level to drop the player onto. */
  #findSpawn(): Vec3 {
    for (let radius = 0; radius < 8; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const x = dx * 4;
          const z = dz * 4;
          const height = this.world.generator.surfaceHeightAt(x, z);
          if (height > 0) {
            return { x: x + 0.5, y: height + 0.1, z: z + 0.5 };
          }
        }
      }
    }
    return { x: 0.5, y: 80, z: 0.5 };
  }

  /**
   * Places the player on a clear patch of ground once the spawn chunks exist.
   *
   * I. Why the exact spawn column is searched rather than trusted
   *
   * The generator reports the surface height of a column, but that column can be
   * occupied by a tree, a boulder or the wall of a hill. Dropping the player in
   * then leaves the camera inside geometry, and the first thing a player sees is
   * the inside of a leaf block. A short outward search for a column with two
   * blocks of clear headroom is cheap and removes the whole class of problem.
   */
  #placeOnSurface(): void {
    const player = this.#playerController.player;
    const originX = Math.floor(player.position.x);
    const originZ = Math.floor(player.position.z);

    for (let radius = 0; radius <= 6; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          // A square ring would visit interior columns repeatedly; the ring test
          // keeps the search at O(radius) candidates.
          if (radius > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
            continue;
          }
          const x = originX + dx;
          const z = originZ + dz;
          const feet = this.#clearGroundHeight(x, z);
          if (feet === null) {
            continue;
          }
          player.position.x = x + 0.5;
          player.position.z = z + 0.5;
          // A tenth of a block of clearance stops the collider from starting
          // inside the floor and being pushed out on the first step.
          player.position.y = feet + 0.1;
          player.velocity.x = 0;
          player.velocity.y = 0;
          player.velocity.z = 0;
          return;
        }
      }
    }
  }

  /**
   * Finds the first Y of a column that is solid below and clear above.
   *
   * @param x - Absolute world X.
   * @param z - Absolute world Z.
   * @returns The Y a player can stand at, or `null` when the column is unusable.
   */
  #clearGroundHeight(x: number, z: number): number | null {
    const { lx, lz } = blockToLocal(x, z);
    const { cx, cz } = this.world.chunkOf(x, z);
    const chunk = this.world.getChunk(cx, cz);
    if (chunk === undefined) {
      return null;
    }

    const top = chunk.getHeight(lx, lz);
    if (top <= 0) {
      return null;
    }

    // Standing on water is not spawning: the player would sink immediately.
    const ground = this.world.getBlock(x, top - 1, z);
    if (ground === BlockId.Water || ground === BlockId.Air) {
      return null;
    }

    const head = this.world.getBlock(x, top, z);
    const above = this.world.getBlock(x, top + 1, z);
    if (head !== BlockId.Air || above !== BlockId.Air) {
      return null;
    }

    return top;
  }

  /** Moves a slot between the hotbar and the backpack. */
  #quickMove(index: number): void {
    const snapshot = this.inventory.snapshot();
    const stack = snapshot.slots[index];
    if (stack === null || stack === undefined) {
      return;
    }
    const hotbarSlots = 9;
    const target =
      index < hotbarSlots
        ? hotbarSlots + (index % (snapshot.slots.length - hotbarSlots))
        : index % hotbarSlots;
    this.inventory.moveSlot(index, target);
  }

  /** Applies the day/night state to the scene lighting and fog. */
  #syncLighting(): void {
    const skyState = this.#sky.state;
    this.#environment.sunLight.position.set(
      this.camera.position.x + skyState.sunDirection.x * 200,
      skyState.sunDirection.y * 200,
      this.camera.position.z + skyState.sunDirection.z * 200,
    );
    // The sun light covers both the day and the night term: below the horizon the
    // cycle reports a moon intensity instead, and the world must not go black.
    const direct = Math.max(skyState.sunIntensity, skyState.moonIntensity);
    this.#environment.sunLight.intensity = direct * 2.2;
    this.#environment.sunLight.color.copy(
      skyState.sunIntensity >= skyState.moonIntensity ? skyState.sunColor : skyState.horizonColor,
    );
    this.#environment.hemisphereLight.intensity = skyState.ambientIntensity;
    this.#environment.hemisphereLight.color.copy(skyState.horizonColor);
  }

  async #saveAndQuit(): Promise<void> {
    this.#options.state.transition('saving');
    try {
      await this.#options.save.saveWorld(this.buildSaveInput());
    } catch (error) {
      log.error('save before quit failed', error);
    }
    this.#options.onQuitToMenu();
  }
}

/**
 * Folds a player-typed seed into the numeric seed the generator expects.
 *
 * I. Why a hash rather than `Number.parseInt`
 *
 * `parseInt('my world')` is `NaN`, and `parseInt('world-1')` and `parseInt('world-2')`
 * are both `NaN` too — every non-numeric seed would collapse onto the same world.
 * FNV-1a gives distinct values for distinct text, and it is stable across
 * versions, which the save format requires.
 *
 * @param seed - Numeric seed, or the text the player typed.
 * @returns A signed 32-bit seed.
 */
export function seedToNumber(seed: number | string): number {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return Math.trunc(seed);
  }
  const text = String(seed).trim();
  if (text === '') {
    return 0;
  }
  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && text !== '') {
    return Math.trunc(asNumber);
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

void MAX_STACK_SIZE;
