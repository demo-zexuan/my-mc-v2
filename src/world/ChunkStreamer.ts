/**
 * Chunk streaming.
 *
 * I. Responsibility
 *
 * Given the player's position and a render distance, decide which chunks must
 * exist, request the missing ones in priority order, and release the ones that
 * fell out of range. It is the only component that knows both "where the player
 * is" and "how chunks come into existence".
 *
 * II. Why it is separated from `World` and from the renderer
 *
 * - The world must stay testable without a scheduler or a worker pool.
 * - The renderer must not care where block data came from.
 * - This class is pure policy — a queue, a budget and a radius — so it can be
 *   unit tested by passing a fake source that resolves immediately.
 *
 * III. Budget
 *
 * Requests are dispatched under a per-update cap and an in-flight cap. Without
 * the caps, teleporting the player (or spawning) would queue thousands of chunks
 * at once: the worker pool would saturate, memory would spike, and the player
 * would see nothing until the last chunk in the queue finished. With them, the
 * nearest chunks arrive first and the world fills in from the centre outwards.
 *
 * @module world/ChunkStreamer
 */

import type { ChunkGenerationSource } from '@/workers/WorkerPool';

import { logger } from '@/utils/logger';

import { World } from './World';
import { chunkKey } from './coords';

const log = logger.child('streaming');

/** A chunk waiting to be requested, ordered by distance from the player. */
interface QueueEntry {
  readonly cx: number;
  readonly cz: number;
  /** Squared distance in chunk units; avoids a square root per comparison. */
  readonly distanceSquared: number;
}

export interface ChunkStreamerOptions {
  /** World that receives the generated chunks. */
  readonly world: World;
  /** Source of generated block data. */
  readonly source: ChunkGenerationSource;
  /** Horizontal radius in chunks. Defaults to 8. */
  readonly renderDistance?: number;
  /** Requests dispatched per `update` call. Defaults to 6. */
  readonly dispatchBudget?: number;
  /** Upper bound on concurrently outstanding requests. Defaults to 16. */
  readonly maxInFlight?: number;
  /**
   * Extra ring of chunks kept loaded beyond the render distance, in chunks.
   * Prevents a chunk from being dropped and immediately re-requested when the
   * player walks back and forth across a boundary. Defaults to 2.
   */
  readonly keepMargin?: number;
}

/** Streaming counters for the debug overlay. */
export interface StreamerStats {
  readonly queued: number;
  readonly inFlight: number;
  readonly loaded: number;
  readonly dispatched: number;
  readonly failed: number;
}

export class ChunkStreamer {
  readonly #world: World;
  readonly #source: ChunkGenerationSource;
  readonly #dispatchBudget: number;
  readonly #maxInFlight: number;
  readonly #keepMargin: number;

  #renderDistance: number;
  #queue: QueueEntry[] = [];
  #queuedKeys = new Set<number>();
  #dispatchedCount = 0;
  #failedCount = 0;
  #disposed = false;
  /**
   * Chunk the player currently occupies. Streaming only recomputes its queue when
   * this changes; walking a few blocks inside the same chunk cannot change which
   * chunks are in range, so recomputing per frame would allocate a queue entry
   * per chunk per frame for nothing.
   */
  #centreCx = Number.NaN;
  #centreCz = Number.NaN;

  public constructor(options: ChunkStreamerOptions) {
    this.#world = options.world;
    this.#source = options.source;
    this.#renderDistance = options.renderDistance ?? 8;
    this.#dispatchBudget = options.dispatchBudget ?? 6;
    this.#maxInFlight = options.maxInFlight ?? 16;
    this.#keepMargin = options.keepMargin ?? 2;
  }

  public get renderDistance(): number {
    return this.#renderDistance;
  }

  public get stats(): StreamerStats {
    return {
      queued: this.#queue.length,
      inFlight: this.#source.inFlight,
      loaded: this.#world.loadedChunkCount,
      dispatched: this.#dispatchedCount,
      failed: this.#failedCount,
    };
  }

  /**
   * Changes the render distance.
   *
   * Lowering it does not immediately unload chunks; the next `update` handles
   * that, so a slider drag cannot free hundreds of chunks in one frame.
   *
   * @param distance - New radius in chunks, clamped to `1 .. 32`.
   */
  public setRenderDistance(distance: number): void {
    const clamped = Math.max(1, Math.min(32, Math.round(distance)));
    if (clamped === this.#renderDistance) {
      return;
    }
    this.#renderDistance = clamped;
    // Force a recompute: the set of chunks in range changed.
    this.#centreCx = Number.NaN;
    this.#centreCz = Number.NaN;
  }

  /**
   * Advances streaming for a player position.
   *
   * @param playerX - Absolute world X of the player.
   * @param playerZ - Absolute world Z of the player.
   * @returns Number of requests dispatched during this call.
   */
  public update(playerX: number, playerZ: number): number {
    if (this.#disposed) {
      return 0;
    }

    const cx = Math.floor(playerX / 16);
    const cz = Math.floor(playerZ / 16);

    if (cx !== this.#centreCx || cz !== this.#centreCz) {
      this.#centreCx = cx;
      this.#centreCz = cz;
      this.#rebuildQueue(cx, cz);
      this.#unloadOutOfRange(cx, cz);
    }

    return this.#dispatch();
  }

  /**
   * Requests and generates everything in range, awaiting completion.
   *
   * Used by the spawn sequence, which needs a small neighbourhood to exist before
   * the player is placed, and by tests that want a deterministic pre-filled world.
   *
   * @param playerX - Absolute world X.
   * @param playerZ - Absolute world Z.
   * @param radius - Radius in chunks; defaults to the current render distance.
   */
  public async preload(playerX: number, playerZ: number, radius?: number): Promise<void> {
    if (this.#disposed) {
      return;
    }
    const effectiveRadius = radius ?? this.#renderDistance;
    const cx = Math.floor(playerX / 16);
    const cz = Math.floor(playerZ / 16);

    const entries: QueueEntry[] = [];
    for (let dz = -effectiveRadius; dz <= effectiveRadius; dz += 1) {
      for (let dx = -effectiveRadius; dx <= effectiveRadius; dx += 1) {
        const targetCx = cx + dx;
        const targetCz = cz + dz;
        if (this.#world.hasChunk(targetCx, targetCz)) {
          continue;
        }
        entries.push({ cx: targetCx, cz: targetCz, distanceSquared: dx * dx + dz * dz });
      }
    }
    entries.sort((a, b) => a.distanceSquared - b.distanceSquared);

    for (const entry of entries) {
      await this.#generate(entry.cx, entry.cz);
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#queue.length = 0;
    this.#queuedKeys.clear();
  }

  #rebuildQueue(centreCx: number, centreCz: number): void {
    const entries: QueueEntry[] = [];
    const radius = this.#renderDistance;

    for (let dz = -radius; dz <= radius; dz += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const cx = centreCx + dx;
        const cz = centreCz + dz;
        // A circular radius rather than a square one: the corner chunks of a
        // square are 41% further away than the edge-midpoints and are the first
        // to fall outside the fog, so loading them wastes worker time.
        if (dx * dx + dz * dz > radius * radius) {
          continue;
        }
        if (this.#world.hasChunk(cx, cz) || this.#world.isPending(cx, cz)) {
          continue;
        }
        entries.push({ cx, cz, distanceSquared: dx * dx + dz * dz });
      }
    }

    // Nearest first, so the world fills in around the player instead of at the
    // edge of the view distance.
    entries.sort((a, b) => a.distanceSquared - b.distanceSquared);

    this.#queue = entries;
    this.#queuedKeys = new Set(entries.map((entry) => chunkKey(entry.cx, entry.cz)));
  }

  #unloadOutOfRange(centreCx: number, centreCz: number): void {
    const dropRadius = this.#renderDistance + this.#keepMargin;
    const dropRadiusSquared = dropRadius * dropRadius;

    // Snapshot because `unloadChunk` mutates the map being iterated.
    const candidates: { key: number; cx: number; cz: number }[] = [];
    for (const chunk of this.#world.chunks) {
      const dx = chunk.cx - centreCx;
      const dz = chunk.cz - centreCz;
      if (dx * dx + dz * dz > dropRadiusSquared) {
        candidates.push({ key: chunkKey(chunk.cx, chunk.cz), cx: chunk.cx, cz: chunk.cz });
      }
    }

    for (const candidate of candidates) {
      const edited = this.#world.unloadChunk(candidate.cx, candidate.cz);
      if (edited !== null) {
        // Edited chunks are handed back rather than silently dropped; losing them
        // would delete the player's builds. The session persists them.
        this.#onEditedChunkUnloaded?.(edited);
      }
      this.#queuedKeys.delete(candidate.key);
    }
  }

  #dispatch(): number {
    let dispatched = 0;

    while (this.#queue.length > 0 && dispatched < this.#dispatchBudget) {
      if (this.#source.inFlight >= this.#maxInFlight) {
        break;
      }
      const entry = this.#queue.shift();
      if (entry === undefined) {
        break;
      }
      this.#queuedKeys.delete(chunkKey(entry.cx, entry.cz));
      if (this.#world.hasChunk(entry.cx, entry.cz) || this.#world.isPending(entry.cx, entry.cz)) {
        continue;
      }
      void this.#generate(entry.cx, entry.cz);
      dispatched += 1;
    }

    return dispatched;
  }

  async #generate(cx: number, cz: number): Promise<void> {
    if (!this.#world.beginGeneration(cx, cz)) {
      return;
    }
    this.#dispatchedCount += 1;

    try {
      const blocks = await this.#source.request({ cx, cz });
      if (this.#disposed) {
        return;
      }
      if (blocks === null) {
        this.#failedCount += 1;
        this.#world.cancelGeneration(cx, cz);
        return;
      }
      this.#world.adoptGeneratedChunk(cx, cz, blocks);
    } catch (error) {
      log.error(`generation failed for chunk (${cx},${cz})`, error);
      this.#failedCount += 1;
      this.#world.cancelGeneration(cx, cz);
    }
  }

  #onEditedChunkUnloaded: ((chunk: import('./Chunk').Chunk) => void) | null = null;

  /**
   * Registers the handler invoked when an edited chunk leaves the view distance.
   *
   * @param handler - Receives the chunk so it can be persisted before being
   *        dropped from memory.
   */
  public setOnEditedChunkUnloaded(handler: (chunk: import('./Chunk').Chunk) => void): void {
    this.#onEditedChunkUnloaded = handler;
  }
}
