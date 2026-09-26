/**
 * Voxel coordinate system.
 *
 * I. Why every conversion lives here
 *
 * 1. A voxel engine mixes three coordinate spaces (world, chunk, chunk-local)
 *    and two of them are affected by negative numbers. `Math.floor` and `%` do
 *    not agree on negatives: `-1 % 16` is `-1`, while the chunk-local index of
 *    world x = -1 must be 15. Getting this wrong produces a world that is
 *    correct in the positive quadrant and corrupt everywhere else, which is
 *    exactly the kind of bug that survives a casual play test.
 * 2. Centralising the arithmetic means it can be unit-tested once, and the
 *    chunk mesher, terrain generator and save format cannot disagree about
 *    where a block lives.
 *
 * II. Terminology
 *
 * - **world coordinate**: absolute block position, may be negative.
 * - **chunk coordinate**: index of the 16x128x16 column that owns a block.
 * - **local coordinate**: `0 .. size-1` position inside a chunk.
 *
 * @module world/coords
 */

/** Chunk extent along X, in blocks. A power of two so shifts are usable. */
export const CHUNK_SIZE_X = 16;
/** Chunk extent along Y (world height). */
export const CHUNK_SIZE_Y = 128;
/** Chunk extent along Z, in blocks. */
export const CHUNK_SIZE_Z = 16;

/** Number of blocks in one horizontal layer of a chunk. */
export const CHUNK_AREA = CHUNK_SIZE_X * CHUNK_SIZE_Z;
/** Total number of blocks in a chunk. */
export const CHUNK_VOLUME = CHUNK_AREA * CHUNK_SIZE_Y;

/** Lowest world Y that exists. */
export const WORLD_MIN_Y = 0;
/** Highest world Y that exists (inclusive). */
export const WORLD_MAX_Y = CHUNK_SIZE_Y - 1;

/** An absolute block position in the world. */
export interface BlockPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Horizontal index of a chunk column. */
export interface ChunkCoord {
  readonly cx: number;
  readonly cz: number;
}

/**
 * Converts a world coordinate to the chunk coordinate that owns it.
 *
 * Uses `Math.floor` rather than truncation so that negative coordinates map to
 * the chunk on their negative side (`-1` belongs to chunk `-1`, not `0`).
 *
 * @param worldValue - Absolute coordinate along one axis.
 * @param chunkSize - Extent of a chunk along the same axis.
 * @returns Index of the owning chunk.
 */
export function worldToChunkCoord(worldValue: number, chunkSize: number): number {
  return Math.floor(worldValue / chunkSize);
}

/**
 * Converts a world coordinate to its chunk-local coordinate.
 *
 * @param worldValue - Absolute coordinate along one axis.
 * @param chunkSize - Extent of a chunk along the same axis.
 * @returns Local coordinate in `0 .. chunkSize - 1`, always non-negative.
 */
export function worldToLocalCoord(worldValue: number, chunkSize: number): number {
  const local = worldValue % chunkSize;
  // `%` keeps the sign of the dividend, so a negative remainder is shifted into
  // the positive range here instead of at every call site.
  return local < 0 ? local + chunkSize : local;
}

/**
 * Converts a block position to the chunk that owns it.
 *
 * @param x - Absolute X.
 * @param z - Absolute Z.
 * @returns The owning chunk coordinate.
 */
export function blockToChunk(x: number, z: number): ChunkCoord {
  return {
    cx: worldToChunkCoord(x, CHUNK_SIZE_X),
    cz: worldToChunkCoord(z, CHUNK_SIZE_Z),
  };
}

/**
 * Converts absolute X/Z to chunk-local X/Z.
 *
 * @param x - Absolute X.
 * @param z - Absolute Z.
 * @returns Local coordinates in `0 .. 15`.
 */
export function blockToLocal(x: number, z: number): { readonly lx: number; readonly lz: number } {
  return {
    lx: worldToLocalCoord(x, CHUNK_SIZE_X),
    lz: worldToLocalCoord(z, CHUNK_SIZE_Z),
  };
}

/**
 * Computes the array index of a chunk-local block.
 *
 * I. Memory layout
 *
 * Y is the outermost axis so that a vertical column is strided by `CHUNK_AREA`.
 * Terrain generation walks columns top-down while meshing walks horizontal
 * layers, and this layout keeps the mesher's inner loop contiguous, which is
 * the hotter of the two paths.
 *
 * @param lx - Local X in `0 .. 15`.
 * @param y - World Y in `0 .. 127` (equals local Y).
 * @param lz - Local Z in `0 .. 15`.
 * @returns Index into the chunk's flat block array.
 */
export function indexInChunk(lx: number, y: number, lz: number): number {
  return y * CHUNK_AREA + lz * CHUNK_SIZE_X + lx;
}

/**
 * Inverse of {@link indexInChunk}.
 *
 * @param index - Flat index inside a chunk.
 * @returns The local coordinates encoded by `index`.
 */
export function coordsFromIndex(index: number): {
  readonly lx: number;
  readonly y: number;
  readonly lz: number;
} {
  const y = Math.floor(index / CHUNK_AREA);
  const remainder = index - y * CHUNK_AREA;
  const lz = Math.floor(remainder / CHUNK_SIZE_X);
  const lx = remainder - lz * CHUNK_SIZE_X;
  return { lx, y, lz };
}

/**
 * Stable numeric key for a chunk column.
 *
 * I. Why not a string
 *
 * `Map<string, Chunk>` allocates a string per lookup, and the streaming code
 * looks chunks up thousands of times per second while the player walks. Packing
 * the two coordinates into one number keeps the common path allocation-free.
 * The 2^21 offset gives a ±1,048,576 chunk range, i.e. ±16.7 million blocks,
 * which is far beyond any reachable world extent.
 *
 * @param cx - Chunk X.
 * @param cz - Chunk Z.
 * @returns A number that is unique for the supported coordinate range.
 */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 0x200000) * 0x400000 + (cz + 0x200000);
}

/**
 * Inverse of {@link chunkKey}.
 *
 * @param key - Value produced by `chunkKey`.
 * @returns The chunk coordinates encoded by `key`.
 */
export function chunkKeyToCoord(key: number): ChunkCoord {
  const cx = Math.floor(key / 0x400000) - 0x200000;
  const cz = key - (cx + 0x200000) * 0x400000 - 0x200000;
  return { cx, cz };
}

/**
 * Tests whether a world Y is inside the world.
 *
 * @param y - Absolute Y.
 */
export function isInsideWorldHeight(y: number): boolean {
  return y >= WORLD_MIN_Y && y <= WORLD_MAX_Y;
}
