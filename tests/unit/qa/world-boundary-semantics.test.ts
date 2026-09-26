import { describe, expect, it } from 'vitest';

import type { Chunk } from '@/world/Chunk';
import { BlockId } from '@/world/BlockRegistry';
import { World } from '@/world/World';
import { blockToLocal, chunkKey } from '@/world/coords';

import { FlatTestGenerator, RogueTestGenerator } from './support/test-generator';

/**
 * Adversarial `World` boundary tests (T7 QA).
 *
 * I. What is under test here
 *
 * `World` owns the semantics that every other system trusts:
 *
 * 1. what `getBlock` answers outside the world (below y=0, above y=127, in an
 *    unloaded chunk);
 * 2. which neighbouring chunks a border edit has to invalidate;
 * 3. what happens when the caller — or the generator — passes a coordinate the
 *    world cannot represent.
 *
 * Each of those has a legitimate design answer, and several of the assertions
 * below are *characterisations*: they pin down what the code does today so that
 * a future change is deliberate rather than accidental. Cases where the
 * behaviour contradicts the module's own documented contract are marked as such.
 */

/** World holding a 3x3 block of chunks around the origin. */
function createWorld3x3(options: { readonly maxLoadedChunks?: number } = {}): {
  world: World;
  generator: FlatTestGenerator;
} {
  const generator = new FlatTestGenerator();
  const world = new World({
    seed: 7,
    generator,
    ...(options.maxLoadedChunks === undefined ? {} : { maxLoadedChunks: options.maxLoadedChunks }),
  });
  for (let cz = -1; cz <= 1; cz += 1) {
    for (let cx = -1; cx <= 1; cx += 1) {
      world.generateChunkNow(cx, cz);
    }
  }
  return { world, generator };
}

/** Clears the mesh-dirty flag of every loaded chunk. */
function clearDirtyFlags(world: World): void {
  for (const chunk of world.chunks) {
    chunk.markMeshClean();
  }
}

/** Sorted `cx,cz` labels of the chunks whose mesh is dirty. */
function dirtyLabels(world: World): string[] {
  const labels: string[] = [];
  for (const chunk of world.chunks) {
    if (chunk.meshDirty) {
      labels.push(`${chunk.cx},${chunk.cz}`);
    }
  }
  return labels.sort();
}

describe('World: block reads at the vertical boundaries', () => {
  it('answers bedrock below y=0 and air above y=127 for a loaded chunk', () => {
    const { world } = createWorld3x3();
    expect(world.setBlock(3, 127, 3, BlockId.Lamp)).toBe(true);

    // Loaded chunk, inside the world.
    expect(world.getBlock(3, 0, 3)).toBe(BlockId.Bedrock);
    expect(world.getBlock(3, 127, 3)).toBe(BlockId.Lamp);

    // Loaded chunk, outside the world.
    expect(world.getBlock(3, -1, 3)).toBe(BlockId.Bedrock);
    expect(world.getBlock(3, -1000, 3)).toBe(BlockId.Bedrock);
    expect(world.getBlock(3, 128, 3)).toBe(BlockId.Air);
    expect(world.getBlock(3, 100_000, 3)).toBe(BlockId.Air);
    expect(world.isSolidAt(3, -1, 3)).toBe(true);
  });

  it('answers bedrock below y=0 even when the chunk is not loaded', () => {
    // Fixed regression: the y < 0 rule used to be applied *after* the chunk
    // lookup, so an unloaded column reported air below the world — the player fell
    // out of the world and the mesher lost the free bottom-face culling it relies
    // on. The rule is now decided before the chunk is resolved.
    const { world } = createWorld3x3();
    const unloadedX = 400;

    expect(world.hasChunk(25, 25)).toBe(false);
    expect(world.getBlock(unloadedX, -1, unloadedX)).toBe(BlockId.Bedrock);
    expect(world.getBlock(unloadedX, -1000, unloadedX)).toBe(BlockId.Bedrock);
    expect(world.isSolidAt(unloadedX, -1, unloadedX)).toBe(true);

    // Loaded and unloaded columns now agree, so the answer no longer depends on
    // streaming state. The same applies above the world.
    expect(world.getBlock(0, -1, 0)).toBe(BlockId.Bedrock);
    expect(world.isSolidAt(0, -1, 0)).toBe(true);
    expect(world.getBlock(unloadedX, 128, unloadedX)).toBe(BlockId.Air);
    expect(world.getBlock(0, 128, 0)).toBe(BlockId.Air);
  });

  it('rejects writes outside the world height on both ends', () => {
    const { world } = createWorld3x3();
    clearDirtyFlags(world);

    expect(world.setBlock(3, -1, 3, BlockId.Stone)).toBe(false);
    expect(world.setBlock(3, 128, 3, BlockId.Stone)).toBe(false);
    expect(world.setBlock(3, Number.NaN, 3, BlockId.Stone)).toBe(false);
    expect(world.setBlock(3, Number.POSITIVE_INFINITY, 3, BlockId.Stone)).toBe(false);

    expect(dirtyLabels(world)).toEqual([]);
    expect(world.getBlock(3, 0, 3)).toBe(BlockId.Bedrock);
  });

  it('returns air and refuses writes for a chunk that is not loaded', () => {
    const { world } = createWorld3x3();
    expect(world.getBlock(500, 64, -500)).toBe(BlockId.Air);
    expect(world.setBlock(500, 64, -500, BlockId.Stone)).toBe(false);
    expect(world.surfaceHeightAt(500, -500)).toBe(world.generator.surfaceHeightAt(500, -500));
  });
});

describe('World: cross-chunk dirty marking', () => {
  it('marks only the edited chunk for an interior block', () => {
    const { world } = createWorld3x3();
    clearDirtyFlags(world);

    expect(world.setBlock(5, 10, 5, BlockId.Stone)).toBe(true);

    expect(dirtyLabels(world)).toEqual(['0,0']);
  });

  it('marks the negative neighbour for lx === 0 and lz === 0', () => {
    const { world } = createWorld3x3();
    clearDirtyFlags(world);

    expect(world.setBlock(0, 10, 5, BlockId.Stone)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['-1,0', '0,0']);

    clearDirtyFlags(world);
    expect(world.setBlock(5, 10, 0, BlockId.Stone)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['0,-1', '0,0']);
  });

  it('marks the positive neighbour for lx === 15 and lz === 15', () => {
    const { world } = createWorld3x3();
    clearDirtyFlags(world);

    expect(world.setBlock(15, 10, 5, BlockId.Stone)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['0,0', '1,0']);

    clearDirtyFlags(world);
    expect(world.setBlock(5, 10, 15, BlockId.Stone)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['0,0', '0,1']);
  });

  it('marks both neighbours at a chunk corner and no diagonal', () => {
    const { world } = createWorld3x3();
    clearDirtyFlags(world);

    // (0,*,0) is local (0,0) of chunk (0,0): it touches (-1,0) and (0,-1).
    expect(world.setBlock(0, 10, 0, BlockId.Stone)).toBe(true);

    expect(dirtyLabels(world)).toEqual(['-1,0', '0,-1', '0,0']);
    // The diagonal chunk shares only an edge, not a face, so a face-culled
    // mesher does not need to rebuild it.
    expect(world.getChunk(1, 1)?.meshDirty).toBe(false);

    clearDirtyFlags(world);
    // (15,*,15) is local (15,15) of chunk (0,0): it touches (1,0) and (0,1).
    expect(world.setBlock(15, 10, 15, BlockId.Stone)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['0,0', '0,1', '1,0']);
    expect(world.getChunk(-1, -1)?.meshDirty).toBe(false);
  });

  it('marks across a negative chunk border and tolerates a missing neighbour', () => {
    const generator = new FlatTestGenerator();
    const world = new World({ seed: 3, generator });
    for (let cz = -2; cz <= 2; cz += 1) {
      for (let cx = -2; cx <= 2; cx += 1) {
        world.generateChunkNow(cx, cz);
      }
    }
    clearDirtyFlags(world);

    // x = -16 is local lx = 15 of chunk (-1,0): its neighbour is chunk (-2,0).
    expect(world.setBlock(-16, 10, 5, BlockId.Stone)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['-1,0', '-2,0']);

    // Now unload the neighbour and edit the same border again: marking a chunk
    // that is no longer in the map must not throw and must not resurrect it.
    world.unloadChunk(-2, 0);
    clearDirtyFlags(world);
    expect(world.setBlock(-16, 11, 5, BlockId.Stone)).toBe(true);
    expect(dirtyLabels(world)).toEqual(['-1,0']);
    expect(world.hasChunk(-2, 0)).toBe(false);
  });

  it('does not mark anything when the write is a no-op', () => {
    const { world } = createWorld3x3();
    clearDirtyFlags(world);

    // y = 1 is already stone in the flat generator, and the same value must not
    // be reported as a change.
    expect(world.setBlock(0, 1, 0, BlockId.Stone)).toBe(false);
    expect(world.setBlock(0, 1, 0, BlockId.Stone)).toBe(false);

    expect(dirtyLabels(world)).toEqual([]);
  });
});

describe('World: non-integer coordinates', () => {
  it('answers air instead of undefined for a fractional position', () => {
    // Fixed regression: `getBlock` used to bounds-check without requiring
    // integers, so a fractional coordinate produced a fractional flat index and
    // `blocks[2561.5]` was `undefined` — returned through a `BlockId` type.
    const { world } = createWorld3x3();

    for (const value of [1.5, -0.5, 0.25]) {
      expect(world.getBlock(value, 10, 0), `x=${value}`).toBe(BlockId.Air);
      expect(world.getBlock(1, 10, value), `z=${value}`).toBe(BlockId.Air);
    }
    expect(world.getBlock(1, 10.5, 0)).toBe(BlockId.Air);
    expect(world.getBlock(1, -0.5, 0)).toBe(BlockId.Bedrock);

    // The value is a real block id again, not a hole in the type.
    expect(typeof world.getBlock(1.5, 10, 0)).toBe('number');
    expect(world.isSolidAt(1.5, 10, 0)).toBe(false);
  });

  it('rejects a fractional write without marking anything dirty', () => {
    // Regression: `setBlock` used to accept non-integer coordinates. A fractional
    // X produced the flat index $2561.5$; the typed-array write was silently
    // dropped while the method still returned `true`, marked the chunk (and a
    // bogus neighbour) dirty and recorded `{index: 2561.5}` in the edit log — which
    // the save layer then persisted. It now rejects the write outright.
    const { world } = createWorld3x3();
    const chunk = world.getChunk(0, 0);
    expect(chunk).toBeDefined();
    clearDirtyFlags(world);

    expect(world.setBlock(1.5, 10, 0, BlockId.Stone)).toBe(false);
    expect(world.setBlock(1, 10.5, 0, BlockId.Stone)).toBe(false);
    expect(world.setBlock(0.25, 10, 3.75, BlockId.Stone)).toBe(false);
    expect(world.setBlock(1, 10, -0.5, BlockId.Stone)).toBe(false);

    expect(chunk?.getEdits()).toEqual([]);
    expect(chunk?.modified).toBe(false);
    expect(dirtyLabels(world)).toEqual([]);

    // The rejection is complete: nothing was stored at either neighbouring
    // integer coordinate, and the height map is untouched.
    expect(world.getBlock(1, 10, 0)).toBe(BlockId.Air);
    expect(world.getBlock(2, 10, 0)).toBe(BlockId.Air);
    expect(world.surfaceHeightAt(1, 0)).toBe(4);
  });

  it('rejects a NaN X/Z before it reaches a chunk', () => {
    // NaN is safe by accident: the chunk lookup key becomes NaN, which is never in
    // the map. Recording it so a future validation change cannot regress it.
    const { world } = createWorld3x3();
    expect(world.setBlock(Number.NaN, 10, 0, BlockId.Stone)).toBe(false);
    expect(world.setBlock(0, 10, Number.NaN, BlockId.Stone)).toBe(false);
  });
});

describe('World: generation bookkeeping', () => {
  it('returns the existing chunk and does not regenerate it', () => {
    const { world, generator } = createWorld3x3();
    const callsAfterSetup = generator.calls;

    const first = world.generateChunkNow(0, 0);
    const second = world.generateChunkNow(0, 0);

    expect(second).toBe(first);
    expect(generator.calls).toBe(callsAfterSetup);
  });

  it('clears the pending flag when the chunk is generated or adopted', () => {
    const { world } = createWorld3x3();

    expect(world.beginGeneration(9, 9)).toBe(true);
    expect(world.beginGeneration(9, 9)).toBe(false);
    expect(world.isPending(9, 9)).toBe(true);

    world.generateChunkNow(9, 9);
    expect(world.isPending(9, 9)).toBe(false);
    expect(world.hasChunk(9, 9)).toBe(true);

    expect(world.beginGeneration(10, 10)).toBe(true);
    world.cancelGeneration(10, 10);
    expect(world.isPending(10, 10)).toBe(false);
    expect(world.hasChunk(10, 10)).toBe(false);

    expect(world.beginGeneration(11, 11)).toBe(true);
    world.adoptGeneratedChunk(11, 11, new Uint8Array(16 * 128 * 16));
    expect(world.isPending(11, 11)).toBe(false);
    expect(world.hasChunk(11, 11)).toBe(true);
  });

  it('clears the pending entry when adoptGeneratedChunk rejects a payload', () => {
    // Regression: the `try/finally` was applied to `generateChunkNow` first and
    // `adoptGeneratedChunk` kept the old code, so a malformed worker payload threw
    // out of the `Chunk` constructor before `#pending.delete` ran. A streaming
    // layer that trusts `isPending` would then never retry that chunk: it stayed
    // "generating" for the rest of the session and left a permanent hole in the
    // world. The pending entry must not survive an exception.
    const { world } = createWorld3x3();
    world.beginGeneration(12, 12);
    expect(world.isPending(12, 12)).toBe(true);

    expect(() => world.adoptGeneratedChunk(12, 12, new Uint8Array(10))).toThrow(RangeError);
    expect(world.hasChunk(12, 12)).toBe(false);
    expect(world.isPending(12, 12)).toBe(false);
    expect(world.stats().pendingChunks).toBe(0);

    // And the chunk must be retryable afterwards.
    expect(world.beginGeneration(12, 12)).toBe(true);
    world.adoptGeneratedChunk(12, 12, new Uint8Array(16 * 128 * 16));
    expect(world.hasChunk(12, 12)).toBe(true);
    expect(world.isPending(12, 12)).toBe(false);
  });

  it('ignores every out-of-range or fractional generator write', () => {
    // Fixed regression: the `ChunkDataTarget` sink now validates `Number.isInteger`
    // as well as the bounds. A fractional y used to produce a flat index that is
    // still inside the array — `indexInChunk(15, -0.5, 15)` is 127, i.e.
    // (lx=15, y=0, lz=7) — so a buggy generator silently overwrote an unrelated
    // block instead of being ignored.
    const world = new World({ seed: 1, generator: new RogueTestGenerator() });
    const chunk = world.generateChunkNow(0, 0);

    expect(chunk.getBlock(1, 1, 1)).toBe(BlockId.Stone);
    // lx/lz overflow and integer y overflow are dropped...
    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.Air);
    expect(chunk.getBlock(15, 0, 0)).toBe(BlockId.Air);
    // `indexInChunk(16, 1, 0)` is 272, which is (lx=0, y=1, lz=1).
    expect(chunk.getBlock(0, 1, 1)).toBe(BlockId.Air);
    // `indexInChunk(0, 1, 16)` is 512, which is (lx=0, y=2, lz=0).
    expect(chunk.getBlock(0, 2, 0)).toBe(BlockId.Air);
    expect(chunk.getBlock(2, 127, 2)).toBe(BlockId.Air);
    // ...and so is the fractional y that used to alias (lx=15, y=0, lz=7).
    expect(chunk.getBlock(15, 0, 7)).toBe(BlockId.Air);

    // The chunk still holds exactly the one valid anchor block.
    expect(chunk.highestNonAir).toBe(1);
    expect(chunk.getHeight(1, 1)).toBe(2);
  });
});

describe('World: chunk capacity and lifecycle', () => {
  it('drops the oldest unmodified chunks until the cap is satisfied', () => {
    const generator = new FlatTestGenerator();
    const world = new World({ seed: 1, generator, maxLoadedChunks: 4 });
    for (let i = 0; i < 9; i += 1) {
      world.generateChunkNow(i, 0);
    }
    expect(world.loadedChunkCount).toBe(9);

    const dropped = world.trimToCapacity();

    expect(dropped).toBe(5);
    expect(world.loadedChunkCount).toBe(4);
    // Insertion order decides who goes first: (0,0)..(4,0).
    expect(world.hasChunk(0, 0)).toBe(false);
    expect(world.hasChunk(4, 0)).toBe(false);
    expect(world.hasChunk(5, 0)).toBe(true);
  });

  it('never drops an edited chunk, even when the cap cannot be met', () => {
    const generator = new FlatTestGenerator();
    const world = new World({ seed: 1, generator, maxLoadedChunks: 2 });
    for (let i = 0; i < 4; i += 1) {
      world.generateChunkNow(i, 0);
    }
    // Edit the oldest chunk: it must survive.
    expect(world.setBlock(1, 10, 1, BlockId.Lamp)).toBe(true);

    expect(world.trimToCapacity()).toBe(2);
    expect(world.loadedChunkCount).toBe(2);
    expect(world.hasChunk(0, 0)).toBe(true);
    expect(world.getBlock(1, 10, 1)).toBe(BlockId.Lamp);

    // If every remaining chunk is edited the cap is simply exceeded: losing a
    // player's build is worse than a memory overrun.
    const second = new World({ seed: 1, generator: new FlatTestGenerator(), maxLoadedChunks: 1 });
    second.generateChunkNow(0, 0);
    second.generateChunkNow(1, 0);
    second.setBlock(1, 10, 1, BlockId.Lamp);
    second.setBlock(17, 10, 1, BlockId.Lamp);

    expect(second.trimToCapacity()).toBe(0);
    expect(second.loadedChunkCount).toBe(2);
  });

  it('honours protected keys', () => {
    const generator = new FlatTestGenerator();
    const world = new World({ seed: 1, generator, maxLoadedChunks: 2 });
    for (let i = 0; i < 5; i += 1) {
      world.generateChunkNow(i, 0);
    }
    const protectedKey = chunkKey(2, 0);

    const dropped = world.trimToCapacity(new Set([protectedKey]));

    expect(dropped).toBe(3);
    expect(world.loadedChunkCount).toBe(2);
    expect(world.hasChunk(2, 0)).toBe(true);
  });

  it('is a no-op while the world is below the cap', () => {
    const { world } = createWorld3x3({ maxLoadedChunks: 32 });
    expect(world.trimToCapacity()).toBe(0);
    expect(world.loadedChunkCount).toBe(9);
  });

  it('reports edited chunks and drops pristine ones on unload', () => {
    const { world } = createWorld3x3();

    expect(world.unloadChunk(1, 1)).toBe(null);
    expect(world.hasChunk(1, 1)).toBe(false);

    world.setBlock(0, 10, 0, BlockId.Lamp);
    const edited = world.unloadChunk(0, 0);
    expect(edited).not.toBe(null);
    expect(edited?.modified).toBe(true);

    world.setBlock(-16, 10, 0, BlockId.Lamp);
    const editedLabels: string[] = [];
    for (const chunk of world.editedChunks()) {
      editedLabels.push(`${chunk.cx},${chunk.cz}`);
    }
    expect(editedLabels).toEqual(['-1,0']);

    world.clear();
    expect(world.loadedChunkCount).toBe(0);
    expect(world.getBlock(0, 10, 0)).toBe(BlockId.Air);
  });

  it('reports coherent statistics', () => {
    const { world } = createWorld3x3();
    const before = world.stats();

    expect(before.loadedChunks).toBe(9);
    expect(before.readyChunks).toBe(9);
    expect(before.pendingChunks).toBe(0);
    expect(before.editedChunks).toBe(0);
    expect(before.dirtyMeshes).toBe(9);

    clearDirtyFlags(world);
    world.setBlock(5, 10, 5, BlockId.Stone);
    world.beginGeneration(20, 20);

    const after = world.stats();
    expect(after.dirtyMeshes).toBe(1);
    expect(after.editedChunks).toBe(1);
    expect(after.pendingChunks).toBe(1);
  });
});

describe('World: surface height consistency', () => {
  it('agrees with the generator for a freshly loaded chunk', () => {
    const generator = new FlatTestGenerator(1, 4, (x) => (x < 0 ? 10 : 0));
    const world = new World({ seed: 1, generator });
    world.generateChunkNow(-1, 0);

    // x = -1 is inside the loaded chunk; x = 15 is inside an unloaded one.
    expect(world.surfaceHeightAt(-1, 3)).toBe(14);
    expect(world.surfaceHeightAt(15, 3)).toBe(generator.surfaceHeightAt(15, 3));
    expect(world.surfaceHeightAt(15, 3)).toBe(4);
  });

  it('tracks player edits of the top block', () => {
    const { world } = createWorld3x3();
    expect(world.surfaceHeightAt(2, 2)).toBe(4);

    expect(world.setBlock(2, 8, 2, BlockId.Lamp)).toBe(true);
    expect(world.surfaceHeightAt(2, 2)).toBe(9);

    // Remove the tower, then peel the surface layer as well.
    expect(world.setBlock(2, 8, 2, BlockId.Air)).toBe(true);
    expect(world.surfaceHeightAt(2, 2)).toBe(4);

    expect(world.setBlock(2, 3, 2, BlockId.Air)).toBe(true);
    expect(world.surfaceHeightAt(2, 2)).toBe(3);

    // A column lookup must never return a negative height.
    for (let y = 3; y >= 0; y -= 1) {
      world.setBlock(2, y, 2, BlockId.Air);
    }
    expect(world.surfaceHeightAt(2, 2)).toBe(0);
  });

  it('keeps the column height in step with a top-down scan after random digging', () => {
    const { world } = createWorld3x3();

    for (let x = 0; x < 16; x += 1) {
      for (let z = -8; z < 8; z += 1) {
        // Remove the two topmost layers of part of the surface.
        if ((x + z) % 3 === 0) {
          world.setBlock(x, 3, z, BlockId.Air);
          world.setBlock(x, 2, z, BlockId.Air);
        }
      }
    }

    // Only the 3x3 loaded neighbourhood can be compared: outside it
    // `surfaceHeightAt` falls back to the generator while `getBlock` reports the
    // unloaded column as air, which is a documented (and checked elsewhere)
    // difference rather than a height-map bug.
    for (let x = -16; x < 16; x += 1) {
      for (let z = -16; z < 16; z += 1) {
        const reported = world.surfaceHeightAt(x, z);
        let scanned = 0;
        for (let y = 127; y >= 0; y -= 1) {
          if (world.getBlock(x, y, z) !== BlockId.Air) {
            scanned = y + 1;
            break;
          }
        }
        expect(reported, `surface height of (${x},${z})`).toBe(scanned);
      }
    }
  });
});

describe('World: edited chunk round-trip', () => {
  it('restores the recorded edits onto a freshly generated chunk', () => {
    const generator = new FlatTestGenerator();
    const world = new World({ seed: 5, generator });
    world.generateChunkNow(0, 0);

    const positions: ReadonlyArray<readonly [number, number, number, BlockId]> = [
      [1, 10, 1, BlockId.Lamp],
      [15, 12, 15, BlockId.Planks],
      [0, 0, 0, BlockId.Air],
    ];
    for (const [x, y, z, id] of positions) {
      expect(world.setBlock(x, y, z, id)).toBe(true);
    }

    const original: Chunk | undefined = world.getChunk(0, 0);
    expect(original).toBeDefined();
    const edits = original?.getEdits() ?? [];
    expect(edits).toHaveLength(3);

    // Simulate the save round-trip: regenerate, then apply the edits.
    world.unloadChunk(0, 0);
    const regenerated = world.generateChunkNow(0, 0);
    regenerated.applyEdits(edits);

    for (const [x, y, z, id] of positions) {
      const { lx, lz } = blockToLocal(x, z);
      expect(regenerated.getBlock(lx, y, lz), `restored (${x},${y},${z})`).toBe(id);
    }
    expect(regenerated.getHeight(1, 1)).toBe(11);
    expect(regenerated.highestNonAir).toBe(12);
  });
});
