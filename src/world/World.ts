/**
 * Voxel world: chunk ownership, block access and edit tracking.
 *
 * I. Responsibilities
 *
 * 1. Own the loaded chunks and answer block queries in **world** coordinates.
 * 2. Decide which chunks exist, which are being generated and which must be
 *    unloaded.
 * 3. Keep the set of edited chunks that the save system has to persist.
 *
 * II. What it deliberately does not do
 *
 * It never touches Three.js, never talks to the DOM and never schedules its own
 * frames. The renderer asks the world for data; the world does not know a
 * renderer exists. That is what allows the whole voxel core to be tested in
 * Node without a GL context.
 *
 * @module world/World
 */

import type { ChunkDataTarget, TerrainGenerator } from '@/terrain/types';

import { BlockId, isSolid } from './BlockRegistry';
import { Chunk } from './Chunk';
import {
  CHUNK_SIZE_X,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  WORLD_MAX_Y,
  blockToLocal,
  chunkKey,
  indexInChunk,
  isInsideWorldHeight,
  worldToChunkCoord,
} from './coords';

/** Chunk lifecycle states, visible to the streaming layer and the debug panel. */
export type ChunkStatus = 'generating' | 'ready';

export interface WorldOptions {
  /** Seed the world was created from; part of the save format. */
  readonly seed: number;
  /** Deterministic terrain source. */
  readonly generator: TerrainGenerator;
  /** Upper bound of chunks kept in memory; the oldest unmodified ones are dropped. */
  readonly maxLoadedChunks?: number;
}

/** Summary of the world state, cheap to compute for the debug overlay. */
export interface WorldStats {
  readonly loadedChunks: number;
  readonly readyChunks: number;
  readonly pendingChunks: number;
  readonly editedChunks: number;
  readonly dirtyMeshes: number;
}

export class World {
  public readonly seed: number;
  public readonly generator: TerrainGenerator;

  readonly #chunks = new Map<number, Chunk>();
  readonly #pending = new Set<number>();
  readonly #maxLoadedChunks: number;

  public constructor(options: WorldOptions) {
    this.seed = options.seed;
    this.generator = options.generator;
    this.#maxLoadedChunks = options.maxLoadedChunks ?? 1024;
  }

  /** Number of chunks currently in memory. */
  public get loadedChunkCount(): number {
    return this.#chunks.size;
  }

  /** Every loaded chunk. Mutating the returned chunks is allowed; the map is not. */
  public get chunks(): IterableIterator<Chunk> {
    return this.#chunks.values();
  }

  /**
   * Looks up a loaded chunk.
   *
   * @param cx - Chunk X.
   * @param cz - Chunk Z.
   */
  public getChunk(cx: number, cz: number): Chunk | undefined {
    return this.#chunks.get(chunkKey(cx, cz));
  }

  /** True when the chunk is loaded and no longer being generated. */
  public hasChunk(cx: number, cz: number): boolean {
    return this.#chunks.has(chunkKey(cx, cz));
  }

  /** True when generation for the chunk has been started but not finished. */
  public isPending(cx: number, cz: number): boolean {
    return this.#pending.has(chunkKey(cx, cz));
  }

  /**
   * Marks a chunk as being generated.
   *
   * Called by the streaming layer before handing the request to a worker, which
   * prevents the same chunk from being queued twice while a worker is busy.
   *
   * @returns False when the chunk is already loaded or pending.
   */
  public beginGeneration(cx: number, cz: number): boolean {
    const key = chunkKey(cx, cz);
    if (this.#chunks.has(key) || this.#pending.has(key)) {
      return false;
    }
    this.#pending.add(key);
    return true;
  }

  /** Clears the pending flag after a failed worker request. */
  public cancelGeneration(cx: number, cz: number): void {
    this.#pending.delete(chunkKey(cx, cz));
  }

  /**
   * Inserts a chunk whose blocks were generated elsewhere (normally a worker).
   *
   * @param cx - Chunk X.
   * @param cz - Chunk Z.
   * @param blocks - Flat block array of `CHUNK_VOLUME` entries.
   * @returns The stored chunk.
   */
  public adoptGeneratedChunk(cx: number, cz: number, blocks: Uint8Array): Chunk {
    const chunk = new Chunk(cx, cz, blocks);
    this.#chunks.set(chunkKey(cx, cz), chunk);
    this.#pending.delete(chunkKey(cx, cz));
    return chunk;
  }

  /**
   * Generates a chunk synchronously on the calling thread.
   *
   * I. When this is acceptable
   *
   * The normal path runs generation in a worker pool. This method exists for
   * three cases where the synchronous path is the right answer: unit and
   * integration tests, the fallback when workers are unavailable (for example a
   * hardened browser that blocks module workers), and spawn-point search, which
   * needs a handful of chunks before the world is shown.
   *
   * @param cx - Chunk X.
   * @param cz - Chunk Z.
   * @returns The generated chunk, or the existing one when already loaded.
   */
  public generateChunkNow(cx: number, cz: number): Chunk {
    const existing = this.getChunk(cx, cz);
    if (existing !== undefined) {
      return existing;
    }

    const blocks = new Uint8Array(CHUNK_VOLUME);

    const target: ChunkDataTarget = {
      setBlock: (lx, y, lz, id): void => {
        if (lx < 0 || lx >= CHUNK_SIZE_X || lz < 0 || lz >= CHUNK_SIZE_Z) {
          return;
        }
        blocks[indexInChunk(lx, y, lz)] = id;
      },
    };

    this.generator.generate(cx, cz, target);
    const chunk = new Chunk(cx, cz, blocks);
    this.#chunks.set(chunkKey(cx, cz), chunk);
    this.#pending.delete(chunkKey(cx, cz));
    return chunk;
  }

  /**
   * Unloads a chunk, dropping it on the floor if it was never edited.
   *
   * @param cx - Chunk X.
   * @param cz - Chunk Z.
   * @returns The edited chunk that the caller must persist, or `null`.
   */
  public unloadChunk(cx: number, cz: number): Chunk | null {
    const key = chunkKey(cx, cz);
    const chunk = this.#chunks.get(key);
    this.#chunks.delete(key);
    this.#pending.delete(key);
    if (chunk !== undefined && chunk.modified) {
      return chunk;
    }
    return null;
  }

  /**
   * Reads a block in world coordinates.
   *
   * I. Boundary semantics
   *
   * - Above the world: air.
   * - Below the world: bedrock. Reporting an opaque block there makes the mesher
   *   cull the bottom faces of the lowest layer for free, and stops the player
   *   from falling out of the world through an unloaded chunk.
   * - Outside a loaded chunk: air, so the streaming layer can render a partially
   *   loaded neighbourhood without special cases.
   *
   * @param x - World X.
   * @param y - World Y.
   * @param z - World Z.
   */
  public getBlock(x: number, y: number, z: number): BlockId {
    const { lx, lz } = blockToLocal(x, z);
    const { cx, cz } = this.chunkOf(x, z);
    const chunk = this.#chunks.get(chunkKey(cx, cz));
    if (chunk === undefined) {
      return BlockId.Air;
    }
    if (y < 0) {
      return BlockId.Bedrock;
    }
    if (y > WORLD_MAX_Y) {
      return BlockId.Air;
    }
    return chunk.blocks[indexInChunk(lx, y, lz)] as BlockId;
  }

  /**
   * Writes a block in world coordinates.
   *
   * I. Why neighbouring chunks are also marked dirty
   *
   * A block on a chunk border owns one of the four faces that the neighbouring
   * chunk renders for its own edge column. Without marking the neighbour, a
   * player digging at a chunk boundary would see a hole appear on one side only.
   *
   * @param x - World X.
   * @param y - World Y.
   * @param z - World Z.
   * @param id - Block id.
   * @param recordEdit - Pass `false` for generation-time writes that do not need
   *        to be persisted.
   * @returns True when the world changed.
   */
  public setBlock(x: number, y: number, z: number, id: BlockId, recordEdit = true): boolean {
    if (!isInsideWorldHeight(y)) {
      return false;
    }

    const { lx, lz } = blockToLocal(x, z);
    const { cx, cz } = this.chunkOf(x, z);
    const chunk = this.#chunks.get(chunkKey(cx, cz));
    if (chunk === undefined) {
      return false;
    }

    const changed = chunk.setBlock(lx, y, lz, id, recordEdit);
    if (!changed) {
      return false;
    }

    if (lx === 0) this.#markMeshDirty(cx - 1, cz);
    if (lx === CHUNK_SIZE_X - 1) this.#markMeshDirty(cx + 1, cz);
    if (lz === 0) this.#markMeshDirty(cx, cz - 1);
    if (lz === CHUNK_SIZE_Z - 1) this.#markMeshDirty(cx, cz + 1);

    return true;
  }

  /**
   * Tests whether a block stops the player.
   *
   * @param x - World X.
   * @param y - World Y.
   * @param z - World Z.
   */
  public isSolidAt(x: number, y: number, z: number): boolean {
    return isSolid(this.getBlock(x, y, z));
  }

  /**
   * Height of the terrain surface at a column.
   *
   * @param x - World X.
   * @param z - World Z.
   * @returns Y of the first air block above the surface.
   */
  public surfaceHeightAt(x: number, z: number): number {
    const { cx, cz } = this.chunkOf(x, z);
    const chunk = this.getChunk(cx, cz);
    if (chunk === undefined) {
      return this.generator.surfaceHeightAt(x, z);
    }
    const { lx, lz } = blockToLocal(x, z);
    return chunk.getHeight(lx, lz);
  }

  /** Chunk coordinate that owns a world column. */
  public chunkOf(x: number, z: number): { readonly cx: number; readonly cz: number } {
    return {
      cx: worldToChunkCoord(x, CHUNK_SIZE_X),
      cz: worldToChunkCoord(z, CHUNK_SIZE_Z),
    };
  }

  /** Chunks that were edited and are therefore part of the save file. */
  public *editedChunks(): IterableIterator<Chunk> {
    for (const chunk of this.#chunks.values()) {
      if (chunk.modified) {
        yield chunk;
      }
    }
  }

  /** Drops chunks that have never been edited until the cap is satisfied. */
  public trimToCapacity(protectedKeys: ReadonlySet<number> = new Set()): number {
    if (this.#chunks.size <= this.#maxLoadedChunks) {
      return 0;
    }

    let dropped = 0;
    for (const [key, chunk] of this.#chunks) {
      if (this.#chunks.size <= this.#maxLoadedChunks) {
        break;
      }
      // Edited chunks are kept: unloading one would require a save round trip
      // before the player walks back into it.
      if (chunk.modified || protectedKeys.has(key)) {
        continue;
      }
      this.#chunks.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  /** Removes every chunk; used when leaving a world. */
  public clear(): void {
    this.#chunks.clear();
    this.#pending.clear();
  }

  /** Compact statistics for the debug overlay. */
  public stats(): WorldStats {
    let ready = 0;
    let edited = 0;
    let dirty = 0;
    for (const chunk of this.#chunks.values()) {
      ready += 1;
      if (chunk.modified) edited += 1;
      if (chunk.meshDirty) dirty += 1;
    }
    return {
      loadedChunks: this.#chunks.size,
      readyChunks: ready,
      pendingChunks: this.#pending.size,
      editedChunks: edited,
      dirtyMeshes: dirty,
    };
  }

  #markMeshDirty(cx: number, cz: number): void {
    this.#chunks.get(chunkKey(cx, cz))?.markMeshDirty();
  }
}
