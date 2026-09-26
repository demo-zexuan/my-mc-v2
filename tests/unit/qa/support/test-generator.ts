import { BlockId } from '@/world/BlockRegistry';
import type { BiomeId, ChunkDataTarget, TerrainGenerator, TerrainOptions } from '@/terrain/types';

/**
 * Test terrain generators for the QA suites.
 *
 * I. Why the QA tests carry their own generator
 *
 * The production generator is a large, deterministic noise pipeline owned by
 * another module. Using it here would make these tests fail whenever the
 * terrain art changes, and would hide a `World` boundary bug behind a terrain
 * diff. These generators are deliberately trivial: a known, hand-computable
 * shape means the *only* thing a failure can come from is `World` itself.
 *
 * @module tests/unit/qa/support/test-generator
 */

/** Options resolved exactly like the production generator resolves them. */
const BASE_OPTIONS: Required<TerrainOptions> = {
  seaLevel: 62,
  baseHeight: 4,
  mountainAmplitude: 0,
  caves: false,
  ores: false,
  decorations: false,
};

/**
 * Generator that fills every column with `surfaceHeight - 1` stone layers on
 * top of a bedrock floor.
 */
export class FlatTestGenerator implements TerrainGenerator {
  public readonly seed: number;
  public readonly options: Required<TerrainOptions>;

  /** Y of the first air block above the surface. */
  readonly #surfaceHeight: number;

  /** When set, every column is raised by `columnOffset(x, z)`. */
  readonly #columnOffset: (x: number, z: number) => number;

  public constructor(
    seed = 1,
    surfaceHeight = 4,
    columnOffset: (x: number, z: number) => number = () => 0,
  ) {
    this.seed = seed;
    this.#surfaceHeight = surfaceHeight;
    this.#columnOffset = columnOffset;
    this.options = { ...BASE_OPTIONS, baseHeight: surfaceHeight };
  }

  /** Number of `generate` calls, used to prove caching / re-use in `World`. */
  public calls = 0;

  public generate(cx: number, cz: number, target: ChunkDataTarget): void {
    this.calls += 1;
    for (let lz = 0; lz < 16; lz += 1) {
      for (let lx = 0; lx < 16; lx += 1) {
        const worldX = cx * 16 + lx;
        const worldZ = cz * 16 + lz;
        const surface = this.surfaceHeightAt(worldX, worldZ);

        target.setBlock(lx, 0, lz, BlockId.Bedrock);
        for (let y = 1; y < surface; y += 1) {
          target.setBlock(lx, y, lz, y === surface - 1 ? BlockId.Grass : BlockId.Stone);
        }
        // Explicitly clear the rest so the generator is independent of the
        // caller's initial buffer contents.
        for (let y = surface; y < 128; y += 1) {
          target.setBlock(lx, y, lz, BlockId.Air);
        }
      }
    }
  }

  public surfaceHeightAt(x: number, z: number): number {
    return Math.max(2, this.#surfaceHeight + this.#columnOffset(x, z));
  }

  public biomeAt(_x: number, _z: number): BiomeId {
    return 'plains';
  }
}

/**
 * Generator whose writes deliberately violate the documented `ChunkDataTarget`
 * contract, used to check that `World` does not corrupt a chunk when a
 * generator misbehaves.
 */
export class RogueTestGenerator implements TerrainGenerator {
  public readonly seed = 1;
  public readonly options: Required<TerrainOptions> = BASE_OPTIONS;

  public generate(_cx: number, _cz: number, target: ChunkDataTarget): void {
    // Valid anchor block.
    target.setBlock(1, 1, 1, BlockId.Stone);
    // Horizontal overflows: must be ignored (not aliased into another column).
    target.setBlock(16, 1, 0, BlockId.Lamp);
    target.setBlock(-1, 1, 0, BlockId.Lamp);
    target.setBlock(0, 1, 16, BlockId.Lamp);
    target.setBlock(0, 1, -1, BlockId.Lamp);
    // Vertical overflows: must be ignored as well.
    target.setBlock(2, 128, 2, BlockId.Lamp);
    target.setBlock(2, -1, 2, BlockId.Lamp);
    target.setBlock(2, 9999, 2, BlockId.Lamp);
    // Fractional Y below zero: the flat index stays inside the array, so this is
    // the one overflow that can write into a real block unless the sink
    // validates Y.
    target.setBlock(15, -0.5, 15, BlockId.Lamp);
  }

  public surfaceHeightAt(_x: number, _z: number): number {
    return 4;
  }

  public biomeAt(_x: number, _z: number): BiomeId {
    return 'plains';
  }
}
