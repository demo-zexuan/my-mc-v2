import { describe, expect, it } from 'vitest';

import { BLOCK_DEFINITIONS } from '@/world/blocks';
import { BlockId, definitionOf, isOpaque, isSolid } from '@/world/BlockRegistry';
import { Chunk } from '@/world/Chunk';
import { World } from '@/world/World';
import { CHUNK_VOLUME, blockToLocal } from '@/world/coords';

import { FlatTestGenerator } from '../../unit/qa/support/test-generator';

/**
 * Integration tests for the world pipeline (T7 QA).
 *
 * I. What only an integration test can show
 *
 * The unit suites check `Chunk` in isolation and `World` in isolation. These
 * tests drive the whole chain — world coordinates → chunk lookup → local
 * coordinates → flat index → byte storage → height map → save round-trip — with
 * real chunk borders and negative coordinates in the middle of it, which is
 * where the two modules can disagree without either one being wrong on its own.
 *
 * II. The save round-trip check
 *
 * `World` keeps only the edits of a chunk; a loaded world is rebuilt by
 * regenerating every chunk from the seed and replaying those edits. If that
 * reconstruction is not byte-identical to the live world, a player would see
 * their build change after a reload — so the round-trip below compares the raw
 * `Uint8Array` payloads, not a few sampled blocks.
 */

/** World with `radius` chunks around the origin in each direction. */
function createWorld(radius: number): { world: World; generator: FlatTestGenerator } {
  const generator = new FlatTestGenerator();
  const world = new World({ seed: 20250926, generator });
  for (let cz = -radius; cz <= radius; cz += 1) {
    for (let cx = -radius; cx <= radius; cx += 1) {
      world.generateChunkNow(cx, cz);
    }
  }
  return { world, generator };
}

/** Snapshot of every loaded chunk's raw payload, keyed by `cx,cz`. */
function snapshotBlocks(world: World): Map<string, Uint8Array> {
  const snapshot = new Map<string, Uint8Array>();
  for (const chunk of world.chunks) {
    snapshot.set(`${chunk.cx},${chunk.cz}`, Uint8Array.from(chunk.blocks));
  }
  return snapshot;
}

/** Sorted `cx,cz` labels of dirty chunks. */
function dirtyLabels(world: World): string[] {
  const labels: string[] = [];
  for (const chunk of world.chunks) {
    if (chunk.meshDirty) {
      labels.push(`${chunk.cx},${chunk.cz}`);
    }
  }
  return labels.sort();
}

/** Clears every mesh-dirty flag. */
function clearDirtyFlags(world: World): void {
  for (const chunk of world.chunks) {
    chunk.markMeshClean();
  }
}

/** Height of the first air block above a column, found by scanning downwards. */
function scannedHeight(world: World, x: number, z: number): number {
  for (let y = 127; y >= 0; y -= 1) {
    if (world.getBlock(x, y, z) !== BlockId.Air) {
      return y + 1;
    }
  }
  return 0;
}

describe('world pipeline: generation', () => {
  it('produces identical payloads for the same seed in two independent worlds', () => {
    // `generateChunkNow` runs on the calling thread; the worker path calls the
    // same generator from several threads. Any cross-call mutable state would
    // show up here as a difference between the two worlds.
    const first = createWorld(1);
    const second = createWorld(1);

    const firstSnapshot = snapshotBlocks(first.world);
    const secondSnapshot = snapshotBlocks(second.world);

    expect([...firstSnapshot.keys()].sort()).toEqual([...secondSnapshot.keys()].sort());
    for (const [key, blocks] of firstSnapshot) {
      expect(secondSnapshot.get(key), `payload of chunk ${key}`).toEqual(blocks);
    }
  });

  it('gives the same payload whether the chunk is generated or adopted', () => {
    // `adoptGeneratedChunk` is the worker path: the blocks are produced by the
    // generator writing into a caller-owned buffer. Both paths must agree.
    const { world } = createWorld(0);
    const direct = world.getChunk(0, 0);
    expect(direct).toBeDefined();

    const adoptedBlocks = new Uint8Array(CHUNK_VOLUME);
    const generator = new FlatTestGenerator();
    generator.generate(0, 0, {
      setBlock: (lx, y, lz, id): void => {
        adoptedBlocks[y * 256 + lz * 16 + lx] = id;
      },
    });
    const adopted = new Chunk(0, 0, adoptedBlocks);

    expect(adopted.blocks).toEqual(direct?.blocks);
    expect(adopted.heightMap).toEqual(direct?.heightMap);
    expect(adopted.highestNonAir).toBe(direct?.highestNonAir);
  });

  it('keeps the negative quadrants consistent with the positive ones', () => {
    const { world } = createWorld(2);

    for (let x = -32; x < 32; x += 1) {
      for (let z = -32; z < 32; z += 1) {
        const { lx, lz } = blockToLocal(x, z);
        const { cx, cz } = world.chunkOf(x, z);
        const chunk = world.getChunk(cx, cz);
        expect(chunk, `chunk of (${x},${z})`).toBeDefined();
        // The flat generator puts bedrock at y=0 and a grass cap at the surface.
        expect(chunk?.getBlock(lx, 0, lz), `bedrock at (${x},0,${z})`).toBe(BlockId.Bedrock);
        expect(chunk?.getBlock(lx, 3, lz), `surface at (${x},3,${z})`).toBe(BlockId.Grass);
        expect(chunk?.getBlock(lx, 4, lz), `air above (${x},${z})`).toBe(BlockId.Air);
      }
    }
  });
});

describe('world pipeline: edits across chunk borders', () => {
  it('dirty-marks exactly the chunks touched by a border edit', () => {
    const { world } = createWorld(1);
    clearDirtyFlags(world);

    // Two edits on either side of the x = 15 / x = 16 seam.
    expect(world.setBlock(15, 10, 5, BlockId.Lamp)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['0,0', '1,0']);

    clearDirtyFlags(world);
    expect(world.setBlock(16, 10, 5, BlockId.Lamp)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['0,0', '1,0']);

    // Both edits must be readable across the seam.
    expect(world.getBlock(15, 10, 5)).toBe(BlockId.Lamp);
    expect(world.getBlock(16, 10, 5)).toBe(BlockId.Lamp);
  });

  it('digs a tunnel straight through four chunk boundaries', () => {
    const { world, generator } = createWorld(2);
    const expectedSurface = generator.surfaceHeightAt(0, 5);

    // Dig a 1x1 tunnel along +X at z = 5, from x = -31 to x = 30.
    for (let x = -31; x <= 30; x += 1) {
      expect(world.setBlock(x, 3, 5, BlockId.Air), `dig surface at x=${x}`).toBe(true);
      expect(world.setBlock(x, 2, 5, BlockId.Air), `dig below at x=${x}`).toBe(true);
    }

    for (let x = -31; x <= 30; x += 1) {
      // Two layers removed from a four-block surface: height 4 -> 2.
      expect(world.surfaceHeightAt(x, 5), `surface height at x=${x}`).toBe(2);
      expect(scannedHeight(world, x, 5), `scanned height at x=${x}`).toBe(2);
      expect(world.getBlock(x, 2, 5)).toBe(BlockId.Air);
      expect(world.getBlock(x, 1, 5)).toBe(BlockId.Stone);
    }

    // The untouched neighbours keep the original surface.
    expect(world.surfaceHeightAt(-31, 4)).toBe(expectedSurface);
    expect(world.surfaceHeightAt(30, 6)).toBe(expectedSurface);
  });

  it('digs a trench straight through the z boundaries as well', () => {
    const { world } = createWorld(2);

    for (let z = -31; z <= 30; z += 1) {
      expect(world.setBlock(7, 3, z, BlockId.Air)).toBe(true);
    }

    for (let z = -31; z <= 30; z += 1) {
      expect(world.surfaceHeightAt(7, z), `surface height at z=${z}`).toBe(3);
      expect(scannedHeight(world, 7, z)).toBe(3);
    }
    expect(world.surfaceHeightAt(7, 32)).toBe(4);
  });

  it('builds a platform spanning a chunk corner with no hole at the seam', () => {
    const { world } = createWorld(1);

    // A 2x2 platform at y = 70 whose blocks live in four different chunks.
    const cells: ReadonlyArray<readonly [number, number]> = [
      [-1, -1],
      [-1, 0],
      [0, -1],
      [0, 0],
    ];
    for (const [x, z] of cells) {
      expect(world.setBlock(x, 70, z, BlockId.Planks)).toBe(true);
    }

    for (const [x, z] of cells) {
      expect(world.getBlock(x, 70, z), `platform block (${x},${z})`).toBe(BlockId.Planks);
      expect(scannedHeight(world, x, z)).toBe(71);
      expect(world.surfaceHeightAt(x, z)).toBe(71);
    }

    // Each of the four chunks sees its own block: no aliasing across the seam.
    for (const [x, z] of cells) {
      const { cx, cz } = world.chunkOf(x, z);
      const { lx, lz } = blockToLocal(x, z);
      const chunk = world.getChunk(cx, cz);
      expect(chunk, `chunk (${cx},${cz})`).toBeDefined();
      expect(chunk?.getBlock(lx, 70, lz), `local block in chunk (${cx},${cz})`).toBe(
        BlockId.Planks,
      );
      expect(chunk?.highestNonAir, `extremum of chunk (${cx},${cz})`).toBe(70);
      expect(chunk?.getHeight(lx, lz), `height in chunk (${cx},${cz})`).toBe(71);
    }
  });

  it('keeps transparent blocks distinguishable from air and from each other', () => {
    const { world } = createWorld(1);
    clearDirtyFlags(world);

    // Glass in one chunk, water in the neighbouring chunk, leaves in a third.
    expect(world.setBlock(0, 70, 0, BlockId.Glass)).toBe(true);
    expect(world.setBlock(-1, 70, 0, BlockId.Water)).toBe(true);
    expect(world.setBlock(0, 70, -1, BlockId.Leaves)).toBe(true);

    expect(world.getBlock(0, 70, 0)).toBe(BlockId.Glass);
    expect(world.getBlock(-1, 70, 0)).toBe(BlockId.Water);
    expect(world.getBlock(0, 70, -1)).toBe(BlockId.Leaves);

    // Each is transparent, and a transparent block must not stop the player in
    // the same way an opaque one does.
    for (const id of [BlockId.Glass, BlockId.Water, BlockId.Leaves]) {
      expect(isOpaque(id), `isOpaque(${id})`).toBe(false);
    }
    expect(isSolid(BlockId.Water)).toBe(false);
    expect(isSolid(BlockId.Glass)).toBe(true);

    // Breaking the water must not disturb the glass next to it in another chunk.
    expect(world.setBlock(-1, 70, 0, BlockId.Air)).toBe(true);
    expect(world.getBlock(-1, 70, 0)).toBe(BlockId.Air);
    expect(world.getBlock(0, 70, 0)).toBe(BlockId.Glass);
  });
});

describe('world pipeline: every registered block survives storage', () => {
  it('round-trips all definition ids through the byte payload and the height map', () => {
    const { world } = createWorld(0);

    // Place every block type in its own column at a different height.
    for (const definition of BLOCK_DEFINITIONS) {
      const x = definition.id % 16;
      const z = Math.floor(definition.id / 16);
      const y = 64 + (definition.id % 8);
      const changed = world.setBlock(x, y, z, definition.id);
      // Air is what is already stored above the surface, so it cannot "change".
      expect(changed, `place ${definition.name}`).toBe(definition.id !== BlockId.Air);
    }

    for (const definition of BLOCK_DEFINITIONS) {
      const x = definition.id % 16;
      const z = Math.floor(definition.id / 16);
      const y = 64 + (definition.id % 8);
      const stored = world.getBlock(x, y, z);

      // A truncating Uint8Array write or an off-by-one in the index layout would
      // turn an id into a different block here.
      expect(stored, `stored id of ${definition.name}`).toBe(definition.id);
      expect(definitionOf(stored).name).toBe(definition.name);

      // The height map must reflect the tallest thing in the column, which is
      // the block that was just placed unless it was air.
      expect(world.surfaceHeightAt(x, z), `height of ${definition.name}`).toBe(
        definition.id === BlockId.Air ? 4 : y + 1,
      );
    }
  });

  it('keeps the tallest possible stack correct', () => {
    const { world } = createWorld(0);

    // Planks, because y = 0..3 of the flat generator are already filled.
    for (let y = 0; y < 128; y += 1) {
      expect(world.setBlock(8, y, 8, BlockId.Planks), `place y=${y}`).toBe(true);
    }
    expect(world.surfaceHeightAt(8, 8)).toBe(128);
    expect(world.getBlock(8, 127, 8)).toBe(BlockId.Planks);
    // Above the towering column the world is still air.
    expect(world.getBlock(8, 128, 8)).toBe(BlockId.Air);

    // Remove the top block: the height map has to fall back to 127, not 128.
    expect(world.setBlock(8, 127, 8, BlockId.Air)).toBe(true);
    expect(world.surfaceHeightAt(8, 8)).toBe(127);

    // Clear the whole column; y = 0 must survive as long as it is filled.
    for (let y = 127; y >= 1; y -= 1) {
      world.setBlock(8, y, 8, BlockId.Air);
    }
    expect(world.surfaceHeightAt(8, 8)).toBe(1);
    expect(world.setBlock(8, 0, 8, BlockId.Air)).toBe(true);
    expect(world.surfaceHeightAt(8, 8)).toBe(0);
  });
});

describe('world pipeline: save round-trip', () => {
  it('rebuilds an edited world byte-for-byte from the seed plus the edited chunks', () => {
    const original = createWorld(1).world;

    // Scripted edits: a tower, a hole, a border wall and a negative-coordinate block.
    const script: ReadonlyArray<readonly [number, number, number, BlockId]> = [
      [1, 70, 1, BlockId.Lamp],
      [15, 12, 15, BlockId.Planks],
      [-1, 20, -1, BlockId.Brick],
      [-16, 8, 0, BlockId.Cobblestone],
      [2, 2, 2, BlockId.Air],
      [3, 3, 3, BlockId.Air],
      [0, 71, 0, BlockId.Glass],
      [-15, 70, 15, BlockId.Water],
    ];
    for (const [x, y, z, id] of script) {
      expect(original.setBlock(x, y, z, id), `edit (${x},${y},${z})`).toBe(true);
    }

    // Collect the edit log exactly like the save layer would.
    const savedEdits = new Map<string, ReturnType<Chunk['getEdits']>>();
    for (const chunk of original.chunks) {
      savedEdits.set(`${chunk.cx},${chunk.cz}`, chunk.getEdits());
    }
    const expectedBlocks = snapshotBlocks(original);
    const expectedHeights = new Map<string, Uint8Array>();
    for (const chunk of original.chunks) {
      expectedHeights.set(`${chunk.cx},${chunk.cz}`, Uint8Array.from(chunk.heightMap));
    }

    // Load: fresh world, regenerate, replay the edits.
    const reloaded = createWorld(1).world;
    for (const chunk of reloaded.chunks) {
      const edits = savedEdits.get(`${chunk.cx},${chunk.cz}`) ?? [];
      chunk.applyEdits(edits);
    }

    const actualBlocks = snapshotBlocks(reloaded);
    expect([...actualBlocks.keys()].sort()).toEqual([...expectedBlocks.keys()].sort());
    for (const [key, blocks] of expectedBlocks) {
      expect(actualBlocks.get(key), `reloaded payload of chunk ${key}`).toEqual(blocks);
    }

    for (const chunk of reloaded.chunks) {
      expect(chunk.heightMap, `reloaded height map of (${chunk.cx},${chunk.cz})`).toEqual(
        expectedHeights.get(`${chunk.cx},${chunk.cz}`),
      );
    }

    // And the surviving edits must still answer the same world queries.
    for (const [x, y, z, id] of script) {
      expect(reloaded.getBlock(x, y, z), `reloaded (${x},${y},${z})`).toBe(id);
    }
  });

  it('produces an empty edit log for an untouched world', () => {
    const { world } = createWorld(1);
    for (const chunk of world.chunks) {
      expect(chunk.getEdits()).toEqual([]);
      expect(chunk.modified).toBe(false);
    }
    let edited = 0;
    for (const chunk of world.editedChunks()) {
      if (chunk.modified) {
        edited += 1;
      }
    }
    expect(edited).toBe(0);
  });
});

describe('world pipeline: randomised differential test', () => {
  it('matches a shadow model over 2000 random edits spanning 9 chunks', () => {
    const { world } = createWorld(1);
    const model = new Map<string, number>();
    const palette: readonly BlockId[] = [
      BlockId.Stone,
      BlockId.Dirt,
      BlockId.Glass,
      BlockId.Water,
      BlockId.Lamp,
      BlockId.Air,
    ];

    // The model starts as a copy of the generated world, so that replacing a
    // solid block is compared against real content and not against air.
    for (let x = -16; x < 16; x += 1) {
      for (let z = -16; z < 16; z += 1) {
        for (let y = 0; y < 40; y += 1) {
          const id = world.getBlock(x, y, z);
          if (id !== BlockId.Air) {
            model.set(`${x},${y},${z}`, id);
          }
        }
      }
    }

    // Deterministic PRNG so a failure can be replayed.
    let state = 0x2f6e2b1;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 4294967296;
    };

    const touchedColumns = new Set<string>();

    for (let step = 0; step < 2000; step += 1) {
      const x = Math.floor(random() * 32) - 16;
      const z = Math.floor(random() * 32) - 16;
      const y = Math.floor(random() * 40);
      const id = palette[Math.floor(random() * palette.length)] ?? BlockId.Stone;
      const key = `${x},${y},${z}`;

      const changed = world.setBlock(x, y, z, id);
      const previous = model.get(key) ?? BlockId.Air;
      expect(changed, `change reported at ${key} (step ${step})`).toBe(previous !== id);
      if (id === BlockId.Air) {
        model.delete(key);
      } else {
        model.set(key, id);
      }
      touchedColumns.add(`${x},${z}`);

      expect(world.getBlock(x, y, z), `read back at ${key} (step ${step})`).toBe(id);
    }

    for (const column of touchedColumns) {
      const [xText, zText] = column.split(',');
      const x = Number(xText);
      const z = Number(zText);
      expect(world.surfaceHeightAt(x, z), `height of column ${column}`).toBe(
        scannedHeight(world, x, z),
      );
    }
  });
});
