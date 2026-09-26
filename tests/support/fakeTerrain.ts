import type { BlockId } from '@/world/BlockRegistry';
import { BlockId as Id } from '@/world/BlockRegistry';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z } from '@/world/coords';
import type { BiomeId, ChunkDataTarget, TerrainGenerator, TerrainOptions } from '@/terrain/types';

/**
 * Deterministic terrain generator for tests.
 *
 * I. Why a hand-written fake instead of the real generator
 *
 * Tests of `World`, the streamer and the save format must not depend on the
 * terrain module: a change to noise constants would otherwise break unrelated
 * suites. This fake produces a shape that is trivial to assert on — bedrock at
 * y=0, stone up to a fixed height, a grass cap, air above — plus a marker column
 * that identifies the chunk.
 */
export class FakeTerrainGenerator implements TerrainGenerator {
  public readonly seed: number;
  public readonly options: Required<TerrainOptions>;
  public generateCallCount = 0;

  public constructor(seed = 1, options: TerrainOptions = {}) {
    this.seed = seed;
    this.options = {
      seaLevel: options.seaLevel ?? 62,
      baseHeight: options.baseHeight ?? 8,
      mountainAmplitude: options.mountainAmplitude ?? 0,
      caves: options.caves ?? false,
      ores: options.ores ?? false,
      decorations: options.decorations ?? false,
    };
  }

  public generate(cx: number, cz: number, target: ChunkDataTarget): void {
    this.generateCallCount += 1;
    const surface = this.options.baseHeight;

    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        target.setBlock(lx, 0, lz, Id.Bedrock);
        for (let y = 1; y < surface; y += 1) {
          target.setBlock(lx, y, lz, Id.Stone);
        }
        target.setBlock(lx, surface, lz, Id.Grass);
      }
    }

    // A single marker block whose id encodes the chunk, so a test can prove that
    // the chunk it received really was generated for those coordinates.
    target.setBlock(0, surface + 1, 0, markerFor(cx, cz));

    // Deliberately writes outside the chunk: a conforming sink must clip it, and
    // the test asserts the sink does not throw or corrupt memory.
    target.setBlock(-1, surface + 2, 0, Id.Lamp);
    target.setBlock(CHUNK_SIZE_X, surface + 2, 0, Id.Lamp);
  }

  public surfaceHeightAt(_x: number, _z: number): number {
    return this.options.baseHeight + 2;
  }

  public biomeAt(_x: number, _z: number): BiomeId {
    return 'plains';
  }
}

/** Picks a non-air marker id that is a pure function of the chunk coordinates. */
export function markerFor(cx: number, cz: number): BlockId {
  const choices: BlockId[] = [Id.Planks, Id.Brick, Id.Sandstone, Id.Cobblestone, Id.Glass];
  const index = Math.abs(cx * 31 + cz * 17) % choices.length;
  return choices[index] ?? Id.Planks;
}
