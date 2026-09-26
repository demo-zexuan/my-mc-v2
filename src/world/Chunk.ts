/**
 * Chunk block storage.
 *
 * I. Why a flat `Uint8Array` per chunk
 *
 * A 16x128x16 chunk holds 32,768 blocks. Storing one object per block would
 * allocate 32,768 heap objects per chunk — roughly 1.5 MB of headers alone,
 * before any payload — and the garbage collector would have to walk every one of
 * them. 289 loaded chunks would therefore produce ~9.5 million objects. The flat
 * array costs 32 KB per chunk, is cache friendly, and can be transferred to and
 * from a worker without copying.
 *
 * II. Dirty tracking
 *
 * Two independent flags are kept because they have different lifetimes and
 * different costs:
 *
 * - `meshDirty` — the rendered geometry no longer matches the data.
 * - `modified` — the player changed the chunk, so it must be written to the save
 *   file. Chunks that were never edited are regenerated from the seed instead of
 *   being stored, which keeps a save file proportional to what the player built
 *   rather than to how far they walked.
 *
 * @module world/Chunk
 */

import { BlockId, MAX_BLOCK_ID } from './BlockRegistry';
import {
  CHUNK_AREA,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Y,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  indexInChunk,
} from './coords';

/** One block change: flat index plus the new id. */
export interface BlockEdit {
  readonly index: number;
  readonly id: BlockId;
}

export class Chunk {
  public static readonly SIZE_X = CHUNK_SIZE_X;
  public static readonly SIZE_Y = CHUNK_SIZE_Y;
  public static readonly SIZE_Z = CHUNK_SIZE_Z;
  public static readonly VOLUME = CHUNK_VOLUME;

  /** Chunk X coordinate. */
  public readonly cx: number;
  /** Chunk Z coordinate. */
  public readonly cz: number;

  /** Flat block storage, indexed by {@link indexInChunk}. */
  public readonly blocks: Uint8Array;

  /**
   * Highest block that is not air, plus one, per horizontal column.
   *
   * Cached because terrain decoration, tree placement, spawn search and the
   * player's "am I about to fall into a hole" check all need it, and each of
   * those would otherwise scan 128 blocks per column.
   */
  public readonly heightMap: Uint8Array;

  /** World Y of the highest non-air block, or `-1` for an empty column. */
  #highestNonAir = -1;

  /** Block edits that must be persisted. */
  readonly #edits = new Map<number, BlockId>();

  #meshDirty = true;
  #lightDirty = true;

  public constructor(cx: number, cz: number, blocks?: Uint8Array) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = blocks ?? new Uint8Array(CHUNK_VOLUME);
    if (this.blocks.length !== CHUNK_VOLUME) {
      throw new RangeError(
        `Chunk (${cx},${cz}) received ${this.blocks.length} blocks, expected ${CHUNK_VOLUME}.`,
      );
    }
    this.heightMap = new Uint8Array(CHUNK_AREA);
    this.recomputeHeightMap();
  }

  /** True while the rendered geometry no longer matches the block data. */
  public get meshDirty(): boolean {
    return this.#meshDirty;
  }

  /** True when the chunk holds edits that must be written to the save file. */
  public get modified(): boolean {
    return this.#edits.size > 0;
  }

  /** True while a light propagation pass is required. */
  public get lightDirty(): boolean {
    return this.#lightDirty;
  }

  /** Y of the highest non-air block, or `-1` when the chunk is empty. */
  public get highestNonAir(): number {
    return this.#highestNonAir;
  }

  /** Number of edits recorded since the chunk was created or loaded. */
  public get editCount(): number {
    return this.#edits.size;
  }

  /**
   * Reads a block in chunk-local coordinates.
   *
   * @param lx - Local X in `0 .. 15`.
   * @param y - World Y in `0 .. 127`.
   * @param lz - Local Z in `0 .. 15`.
   * @returns The block id, or `Air` when the coordinate is outside the chunk.
   */
  public getBlock(lx: number, y: number, lz: number): BlockId {
    if (
      lx < 0 ||
      lx >= CHUNK_SIZE_X ||
      lz < 0 ||
      lz >= CHUNK_SIZE_Z ||
      y < 0 ||
      y >= CHUNK_SIZE_Y
    ) {
      return BlockId.Air;
    }
    return this.blocks[indexInChunk(lx, y, lz)] as BlockId;
  }

  /**
   * Writes a block in chunk-local coordinates.
   *
   * @param lx - Local X in `0 .. 15`.
   * @param y - World Y in `0 .. 127`.
   * @param lz - Local Z in `0 .. 15`.
   * @param id - Block id to store.
   * @param recordEdit - When true (default) the change is marked for saving.
   *        Terrain generation passes `false` because generated blocks are
   *        reproducible from the seed.
   * @returns True when the stored value actually changed.
   */
  public setBlock(lx: number, y: number, lz: number, id: BlockId, recordEdit = true): boolean {
    if (
      lx < 0 ||
      lx >= CHUNK_SIZE_X ||
      lz < 0 ||
      lz >= CHUNK_SIZE_Z ||
      y < 0 ||
      y >= CHUNK_SIZE_Y
    ) {
      return false;
    }

    const index = indexInChunk(lx, y, lz);
    if (this.blocks[index] === id) {
      return false;
    }

    this.blocks[index] = id;
    this.#meshDirty = true;
    this.#lightDirty = true;

    if (recordEdit) {
      this.#edits.set(index, id);
    }

    // I. Keep the height map and the column extremum coherent.
    // 1. When the change removes the top block the column shrinks, so a full
    //    recompute of that column is required; otherwise the extent only grows.
    const columnIndex = lz * CHUNK_SIZE_X + lx;
    const previousHeight = this.heightMap[columnIndex] ?? 0;
    if (id === BlockId.Air) {
      if (y >= previousHeight - 1) {
        this.#recomputeColumn(columnIndex, lx, lz);
      }
    } else if (y + 1 > previousHeight) {
      this.heightMap[columnIndex] = y + 1;
    }
    if (id !== BlockId.Air && y > this.#highestNonAir) {
      this.#highestNonAir = y;
    } else if (id === BlockId.Air && y === this.#highestNonAir) {
      this.#recomputeHighestNonAir();
    }

    return true;
  }

  /** Marks the chunk as needing a mesh rebuild. */
  public markMeshDirty(): void {
    this.#meshDirty = true;
  }

  /** Clears the mesh-dirty flag; called after a rebuild is queued. */
  public markMeshClean(): void {
    this.#meshDirty = false;
  }

  /**
   * Clears the light-dirty flag.
   *
   * The flag is set by every block change and by {@link applyEdits}; without a
   * way to acknowledge it, a future light propagation pass that gates on it would
   * rebuild lighting every frame for every loaded chunk.
   */
  public markLightClean(): void {
    this.#lightDirty = false;
  }

  /**
   * Recomputes the cached height map and the highest non-air block.
   *
   * Called after bulk generation, where per-block incremental maintenance would
   * be slower than one linear pass.
   */
  public recomputeHeightMap(): void {
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        this.#recomputeColumn(lz * CHUNK_SIZE_X + lx, lx, lz);
      }
    }
    this.#recomputeHighestNonAir();
  }

  /**
   * Height of the first air block above a column.
   *
   * @param lx - Local X.
   * @param lz - Local Z.
   * @returns Highest non-air Y plus one, or `0` for an empty column.
   */
  public getHeight(lx: number, lz: number): number {
    if (lx < 0 || lx >= CHUNK_SIZE_X || lz < 0 || lz >= CHUNK_SIZE_Z) {
      return 0;
    }
    return this.heightMap[lz * CHUNK_SIZE_X + lx] ?? 0;
  }

  /** Edits recorded for this chunk, in insertion order. */
  public getEdits(): readonly BlockEdit[] {
    const edits: BlockEdit[] = [];
    for (const [index, id] of this.#edits) {
      edits.push({ index, id });
    }
    return edits;
  }

  /**
   * Applies edits restored from a save file without marking them again.
   *
   * @param edits - Edits produced by {@link getEdits}.
   */
  public applyEdits(edits: readonly BlockEdit[]): void {
    for (const edit of edits) {
      // A non-integer index would be stored as an array property while the byte
      // array stays unchanged, and an out-of-range id would be silently truncated
      // by the `Uint8Array` (300 becomes 44) while the edit log keeps the original
      // value — so the next save would reload a different block than the one that
      // was written.
      if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= CHUNK_VOLUME) {
        continue;
      }
      if (!Number.isInteger(edit.id) || edit.id < 0 || edit.id > MAX_BLOCK_ID) {
        continue;
      }
      this.blocks[edit.index] = edit.id;
      this.#edits.set(edit.index, edit.id);
    }
    this.recomputeHeightMap();
    this.#meshDirty = true;
    // Replayed edits change what the player sees, so any cached lighting for this
    // chunk is stale as well.
    this.#lightDirty = true;
  }

  #recomputeColumn(columnIndex: number, lx: number, lz: number): void {
    // Walking downwards and stopping at the first non-air block is the whole
    // point of the cache: most columns are empty above y = 90.
    for (let y = CHUNK_SIZE_Y - 1; y >= 0; y -= 1) {
      if (this.blocks[indexInChunk(lx, y, lz)] !== BlockId.Air) {
        this.heightMap[columnIndex] = y + 1;
        return;
      }
    }
    this.heightMap[columnIndex] = 0;
  }

  #recomputeHighestNonAir(): void {
    let highest = -1;
    for (let index = this.blocks.length - 1; index >= 0; index -= 1) {
      if (this.blocks[index] !== BlockId.Air) {
        // Convert the flat index back to Y without allocating.
        highest = Math.floor(index / CHUNK_AREA);
        break;
      }
    }
    this.#highestNonAir = highest;
  }
}
