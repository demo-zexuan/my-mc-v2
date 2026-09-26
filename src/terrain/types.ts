/**
 * Terrain generation contract.
 *
 * I. Why the generator writes into a target instead of returning a chunk
 *
 * 1. The generator runs inside a Web Worker. Returning a `Chunk` instance would
 *    couple terrain generation to the world's data structures and force the
 *    worker to import them; writing into a caller-supplied sink keeps the
 *    contract to three numbers and an id, and lets the same code fill a
 *    `Uint8Array` directly.
 * 2. Decoration features (trees, ore veins) need to write blocks *after* the
 *    base terrain exists, sometimes outside the chunk being generated. A sink
 *    that accepts any coordinate makes that natural; a return value would not.
 *
 * II. Determinism requirement
 *
 * `generate` must be a pure function of `(seed, cx, cz)`. Saved worlds store only
 * the seed plus the blocks the player changed, so unmodified chunks are
 * regenerated on load. Any dependence on iteration order, wall-clock time,
 * `Math.random()` or the order in which chunks are requested would make a saved
 * world mutate between sessions.
 *
 * @module terrain/types
 */

import type { BlockId } from '@/world/BlockRegistry';

/** Sink the generator writes blocks into, in chunk-local coordinates. */
export interface ChunkDataTarget {
  /**
   * Writes one block.
   *
   * @param lx - Local X in `0 .. 15`.
   * @param y - World Y in `0 .. 127`.
   * @param lz - Local Z in `0 .. 15`.
   * @param id - Block id.
   */
  setBlock(lx: number, y: number, lz: number, id: BlockId): void;
}

/** Biome classification used for surface material and decoration choices. */
export type BiomeId = 'ocean' | 'beach' | 'plains' | 'forest' | 'hills' | 'mountains' | 'snow';

/** Tunable generation parameters, exposed for the debug panel and tests. */
export interface TerrainOptions {
  /** Sea level in world Y. Columns below it are flooded. Defaults to 62. */
  readonly seaLevel?: number;
  /** Average surface height of flat terrain. Defaults to 68. */
  readonly baseHeight?: number;
  /** Maximum additional height produced by the mountain octaves. */
  readonly mountainAmplitude?: number;
  /** Enables cave carving. Defaults to true. */
  readonly caves?: boolean;
  /** Enables ore veins. Defaults to true. */
  readonly ores?: boolean;
  /** Enables trees and other surface decoration. Defaults to true. */
  readonly decorations?: boolean;
}

/**
 * Deterministic terrain source for one world.
 *
 * Implementations are created per world from its seed and must be safe to call
 * from several workers at once (no shared mutable state between calls).
 */
export interface TerrainGenerator {
  /** Seed this generator was created from. */
  readonly seed: number;
  /** Effective options after defaults were applied. */
  readonly options: Required<TerrainOptions>;

  /**
   * Fills one chunk.
   *
   * @param cx - Chunk X.
   * @param cz - Chunk Z.
   * @param target - Sink receiving every block of the chunk, including air when
   *        the generator needs to overwrite a previously written block.
   */
  generate(cx: number, cz: number, target: ChunkDataTarget): void;

  /**
   * Surface height of a world column, used to place the player on first spawn.
   *
   * Must be cheaper than a full chunk generation and consistent with the result
   * of {@link generate}.
   *
   * @param x - Absolute world X.
   * @param z - Absolute world Z.
   * @returns Y of the first air block above the terrain surface.
   */
  surfaceHeightAt(x: number, z: number): number;

  /**
   * Biome at a world column. Exposed so the UI can name the biome the player is
   * standing in without duplicating the classification thresholds.
   *
   * @param x - Absolute world X.
   * @param z - Absolute world Z.
   */
  biomeAt(x: number, z: number): BiomeId;
}

/** Factory signature implemented by `src/terrain/TerrainGenerator.ts`. */
export type TerrainGeneratorFactory = (seed: number, options?: TerrainOptions) => TerrainGenerator;
