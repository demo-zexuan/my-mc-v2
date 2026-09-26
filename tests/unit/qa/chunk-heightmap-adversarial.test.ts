import { describe, expect, it } from 'vitest';

import { BlockId } from '@/world/BlockRegistry';
import { Chunk } from '@/world/Chunk';
import { CHUNK_AREA, CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, CHUNK_VOLUME } from '@/world/coords';

/**
 * Adversarial `Chunk` height-map tests (T7 QA).
 *
 * I. The invariant under test
 *
 * `Chunk` maintains two caches incrementally inside `setBlock`:
 *
 * 1. `heightMap[column]` = highest non-air Y + 1 (0 for an empty column).
 * 2. `highestNonAir` = highest non-air Y of the whole chunk, or -1.
 *
 * Both are updated with cheap special cases instead of a rescan, which is the
 * correct trade-off — but it means every case that is *not* covered by the fast
 * path silently keeps a stale value. The tests below therefore compare the
 * caches against an independently maintained shadow model after every mutation,
 * with the removal paths (digging) exercised as heavily as the placement paths.
 */

/**
 * Flat index of a block, computed independently of `indexInChunk`.
 *
 * Deliberately duplicates the layout so that a regression in the shared helper
 * cannot hide behind itself.
 *
 * @param lx - Local X.
 * @param y - World Y.
 * @param lz - Local Z.
 */
function layoutIndex(lx: number, y: number, lz: number): number {
  return y * CHUNK_AREA + lz * CHUNK_SIZE_X + lx;
}

/** Column slot used by the height map. */
function columnSlot(lx: number, lz: number): number {
  return lz * CHUNK_SIZE_X + lx;
}

/** Deterministic PRNG (mulberry32) so a failure can be replayed exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shadow model of everything the caches are supposed to mirror. */
class ShadowChunk {
  readonly #blocks = new Map<number, number>();

  public get(lx: number, y: number, lz: number): number {
    return this.#blocks.get(layoutIndex(lx, y, lz)) ?? BlockId.Air;
  }

  public set(lx: number, y: number, lz: number, id: number): boolean {
    const index = layoutIndex(lx, y, lz);
    const previous = this.#blocks.get(index) ?? BlockId.Air;
    if (previous === id) {
      return false;
    }
    if (id === BlockId.Air) {
      this.#blocks.delete(index);
    } else {
      this.#blocks.set(index, id);
    }
    return true;
  }

  /** Expected height-map value of one column. */
  public height(lx: number, lz: number): number {
    for (let y = CHUNK_SIZE_Y - 1; y >= 0; y -= 1) {
      if (this.get(lx, y, lz) !== BlockId.Air) {
        return y + 1;
      }
    }
    return 0;
  }

  /** Expected `highestNonAir`. */
  public highest(): number {
    let highest = -1;
    for (const index of this.#blocks.keys()) {
      highest = Math.max(highest, Math.floor(index / CHUNK_AREA));
    }
    return highest;
  }
}

/**
 * Compares the chunk caches against the shadow model.
 *
 * @param chunk - Chunk under test.
 * @param shadow - Expected content.
 * @param note - Context appended to every failure message.
 */
function expectCachesMatch(chunk: Chunk, shadow: ShadowChunk, note: string): void {
  expect(chunk.highestNonAir, `highestNonAir after ${note}`).toBe(shadow.highest());

  for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
    for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
      const expected = shadow.height(lx, lz);
      expect(chunk.getHeight(lx, lz), `heightMap(${lx},${lz}) after ${note}`).toBe(expected);
      expect(chunk.heightMap[columnSlot(lx, lz)] ?? 0).toBe(expected);
    }
  }
}

describe('Chunk: construction from a pre-filled array', () => {
  it('derives the height map and the chunk extremum from provided blocks', () => {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    blocks[layoutIndex(0, 0, 0)] = BlockId.Bedrock;
    blocks[layoutIndex(15, 40, 15)] = BlockId.Stone;
    blocks[layoutIndex(7, 127, 8)] = BlockId.Lamp;

    const chunk = new Chunk(3, -4, blocks);

    expect(chunk.cx).toBe(3);
    expect(chunk.cz).toBe(-4);
    expect(chunk.highestNonAir).toBe(127);
    expect(chunk.getHeight(7, 8)).toBe(128);
    expect(chunk.getHeight(15, 15)).toBe(41);
    expect(chunk.getHeight(0, 0)).toBe(1);
    expect(chunk.getHeight(1, 1)).toBe(0);
    // Generation-time storage must not show up as a player edit.
    expect(chunk.modified).toBe(false);
    expect(chunk.editCount).toBe(0);
  });

  it('treats an all-air chunk as empty', () => {
    const chunk = new Chunk(0, 0);
    expect(chunk.highestNonAir).toBe(-1);
    expect(chunk.getHeight(0, 0)).toBe(0);
    expect(chunk.getHeight(15, 15)).toBe(0);
  });

  it('rejects an array whose length is not CHUNK_VOLUME', () => {
    expect(() => new Chunk(0, 0, new Uint8Array(CHUNK_VOLUME - 1))).toThrow(RangeError);
    expect(() => new Chunk(0, 0, new Uint8Array(0))).toThrow(RangeError);
    expect(() => new Chunk(0, 0, new Uint8Array(CHUNK_VOLUME + 1))).toThrow(RangeError);
  });
});

describe('Chunk: removing the top block of a column', () => {
  it('shrinks the height map when the top block is dug out', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(5, 70, 5, BlockId.Stone);
    chunk.setBlock(5, 4, 5, BlockId.Dirt);
    expect(chunk.getHeight(5, 5)).toBe(71);

    chunk.setBlock(5, 70, 5, BlockId.Air);

    // The fast path must not simply keep 71 because "the column was not emptied".
    expect(chunk.getHeight(5, 5)).toBe(5);
    expect(chunk.getBlock(5, 70, 5)).toBe(BlockId.Air);
    expect(chunk.getBlock(5, 4, 5)).toBe(BlockId.Dirt);
  });

  it('empties a column back to height 0 and drops the chunk extremum to -1', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(0, 0, 0, BlockId.Bedrock);
    expect(chunk.getHeight(0, 0)).toBe(1);
    expect(chunk.highestNonAir).toBe(0);

    chunk.setBlock(0, 0, 0, BlockId.Air);

    expect(chunk.getHeight(0, 0)).toBe(0);
    expect(chunk.highestNonAir).toBe(-1);
  });

  it('does not touch the height map when a block below the surface is removed', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(2, 0, 2, BlockId.Bedrock);
    chunk.setBlock(2, 30, 2, BlockId.Stone);
    expect(chunk.getHeight(2, 2)).toBe(31);

    chunk.setBlock(2, 0, 2, BlockId.Air);

    expect(chunk.getHeight(2, 2)).toBe(31);
    expect(chunk.highestNonAir).toBe(30);
  });

  it('keeps the chunk extremum when a non-highest column loses its top block', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(1, 100, 1, BlockId.Stone);
    chunk.setBlock(2, 10, 2, BlockId.Stone);
    expect(chunk.highestNonAir).toBe(100);

    chunk.setBlock(2, 10, 2, BlockId.Air);

    // Rescanning here would be wasteful; keeping the old value would be correct
    // too. Both are acceptable, a wrong answer is not.
    expect(chunk.highestNonAir).toBe(100);
    expect(chunk.getHeight(2, 2)).toBe(0);
  });
});

describe('Chunk: rescanning the chunk extremum', () => {
  it('finds the next highest block in a different column after removing the top one', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(0, 50, 0, BlockId.Stone); // index 12800
    chunk.setBlock(5, 100, 7, BlockId.Stone); // index 25733
    expect(chunk.highestNonAir).toBe(100);

    chunk.setBlock(5, 100, 7, BlockId.Air);

    expect(chunk.highestNonAir).toBe(50);
  });

  it('finds a block whose flat index is 0 and one whose index is CHUNK_VOLUME - 1', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(0, 10, 0, BlockId.Stone); // index 2560
    chunk.setBlock(0, 0, 0, BlockId.Bedrock); // index 0
    chunk.setBlock(15, 90, 15, BlockId.Stone); // index 23167
    chunk.setBlock(15, 127, 15, BlockId.Lamp); // index 32767

    chunk.setBlock(15, 127, 15, BlockId.Air);
    expect(chunk.highestNonAir).toBe(90);

    chunk.setBlock(15, 90, 15, BlockId.Air);
    expect(chunk.highestNonAir).toBe(10);

    chunk.setBlock(0, 10, 0, BlockId.Air);
    expect(chunk.highestNonAir).toBe(0);

    chunk.setBlock(0, 0, 0, BlockId.Air);
    expect(chunk.highestNonAir).toBe(-1);
  });

  it('keeps y=0 usable: a single bedrock layer must survive a full top-down dig', () => {
    const chunk = new Chunk(0, 0);
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        chunk.setBlock(lx, 0, lz, BlockId.Bedrock);
        chunk.setBlock(lx, 1, lz, BlockId.Dirt);
      }
    }
    expect(chunk.highestNonAir).toBe(1);

    // Dig every dirt block; the bedrock layer must remain the new extremum.
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        chunk.setBlock(lx, 1, lz, BlockId.Air);
      }
    }

    expect(chunk.highestNonAir).toBe(0);
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        expect(chunk.getHeight(lx, lz)).toBe(1);
      }
    }
  });
});

describe('Chunk: bounds handling and dirty flags', () => {
  it('rejects writes outside the chunk without recording an edit', () => {
    const chunk = new Chunk(0, 0);
    const rejected: readonly (readonly [number, number, number])[] = [
      [-1, 10, 0],
      [16, 10, 0],
      [0, 10, -1],
      [0, 10, 16],
      [0, -1, 0],
      [0, 128, 0],
    ];

    for (const [lx, y, lz] of rejected) {
      expect(chunk.setBlock(lx, y, lz, BlockId.Stone), `setBlock(${lx},${y},${lz})`).toBe(false);
    }
    expect(chunk.editCount).toBe(0);
    expect(chunk.modified).toBe(false);
    expect(chunk.highestNonAir).toBe(-1);
  });

  it('reads outside the chunk as air', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(0, 5, 0, BlockId.Stone);
    expect(chunk.getBlock(-1, 5, 0)).toBe(BlockId.Air);
    expect(chunk.getBlock(16, 5, 0)).toBe(BlockId.Air);
    expect(chunk.getBlock(0, 5, 16)).toBe(BlockId.Air);
    expect(chunk.getBlock(0, -1, 0)).toBe(BlockId.Air);
    expect(chunk.getBlock(0, 128, 0)).toBe(BlockId.Air);
    expect(chunk.getHeight(-1, 0)).toBe(0);
    expect(chunk.getHeight(0, 16)).toBe(0);
  });

  it('reports no change and stays clean when the value is already stored', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(3, 3, 3, BlockId.Stone);
    chunk.markMeshClean();
    expect(chunk.meshDirty).toBe(false);

    expect(chunk.setBlock(3, 3, 3, BlockId.Stone)).toBe(false);

    expect(chunk.meshDirty).toBe(false);
    expect(chunk.editCount).toBe(1);
  });

  it('records one edit per index and keeps the last value', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(1, 1, 1, BlockId.Stone);
    chunk.setBlock(1, 1, 1, BlockId.Dirt);
    chunk.setBlock(1, 1, 1, BlockId.Planks);
    chunk.setBlock(2, 1, 1, BlockId.Sand);

    expect(chunk.editCount).toBe(2);
    const edits = chunk.getEdits();
    expect(edits).toHaveLength(2);
    expect(edits[0]).toEqual({ index: layoutIndex(1, 1, 1), id: BlockId.Planks });
    expect(edits[1]).toEqual({ index: layoutIndex(2, 1, 1), id: BlockId.Sand });
  });

  it('records a revert to air as an edit', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(0, 0, 0, BlockId.Stone);
    chunk.setBlock(0, 0, 0, BlockId.Air);
    // The save layer must be able to reproduce "the player removed this block".
    expect(chunk.getEdits()[0]).toEqual({ index: 0, id: BlockId.Air });
  });

  it('can be acknowledged and is re-raised by the next block change', () => {
    // Fixed regression: `#lightDirty` used to be impossible to clear — it was set
    // in the constructor and in `setBlock`, and nothing could set it back to
    // false, so a lighting pass gating on it would rebuild every chunk forever.
    const chunk = new Chunk(0, 0);
    expect(chunk.lightDirty).toBe(true);

    chunk.markLightClean();
    expect(chunk.lightDirty).toBe(false);

    // `markMeshClean` must not touch the light flag: the two have different
    // owners and different lifetimes.
    chunk.markMeshClean();
    expect(chunk.lightDirty).toBe(false);

    // Any change to the block data invalidates the lighting again.
    chunk.setBlock(0, 0, 0, BlockId.Stone);
    expect(chunk.lightDirty).toBe(true);
  });

  it('raises lightDirty again after applyEdits', () => {
    // Regression: `markLightClean` documents that the flag "is set by every block
    // change and by `applyEdits`", but `applyEdits` only raised `#meshDirty`.
    // Restoring a save file therefore left lighting marked clean: a lighting pass
    // that had already acknowledged the chunk never rebuilt it, and the restored
    // edits were lit as if they were not there.
    const chunk = new Chunk(0, 0);
    chunk.markLightClean();
    expect(chunk.lightDirty).toBe(false);

    chunk.applyEdits([{ index: layoutIndex(1, 0, 1), id: BlockId.Stone }]);

    expect(chunk.getBlock(1, 0, 1)).toBe(BlockId.Stone);
    expect(chunk.lightDirty).toBe(true);
    expect(chunk.meshDirty).toBe(true);
  });
});

describe('Chunk: applyEdits', () => {
  it('recomputes both caches when restored edits lower the terrain', () => {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        for (let y = 0; y <= 70; y += 1) {
          blocks[layoutIndex(lx, y, lz)] = y === 70 ? BlockId.Grass : BlockId.Stone;
        }
      }
    }

    const chunk = new Chunk(0, 0, blocks);
    expect(chunk.highestNonAir).toBe(70);
    expect(chunk.getHeight(0, 0)).toBe(71);

    // A saved world where the player dug two holes and raised one tower.
    chunk.applyEdits([
      { index: layoutIndex(4, 70, 4), id: BlockId.Air },
      { index: layoutIndex(5, 69, 5), id: BlockId.Air },
      { index: layoutIndex(9, 71, 9), id: BlockId.Planks },
    ]);

    expect(chunk.getBlock(4, 70, 4)).toBe(BlockId.Air);
    expect(chunk.getHeight(4, 4)).toBe(70);
    expect(chunk.getHeight(9, 9)).toBe(72);
    expect(chunk.highestNonAir).toBe(71);
    expect(chunk.meshDirty).toBe(true);
  });

  it('skips indices outside the chunk instead of writing out of bounds', () => {
    const chunk = new Chunk(0, 0);
    chunk.applyEdits([
      { index: -1, id: BlockId.Stone },
      { index: CHUNK_VOLUME, id: BlockId.Stone },
      { index: CHUNK_VOLUME * 4, id: BlockId.Stone },
      { index: 0, id: BlockId.Stone },
    ]);

    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.Stone);
    expect(chunk.getHeight(0, 0)).toBe(1);
    expect(chunk.editCount).toBe(1);
  });

  it('skips an out-of-range block id instead of truncating it modulo 256', () => {
    // Fixed regression: a corrupt save file (or a generator bug) can carry an
    // id > 255. It used to be written into the Uint8Array, which truncates
    // silently (300 became 44) while the *untruncated* value stayed in the edit
    // log — storage and the log disagreed, so a re-save reloaded a different
    // block than the one that was written. Both the value and the log entry are
    // now rejected.
    const chunk = new Chunk(0, 0);
    const rawId = 300 as unknown as BlockId;

    chunk.applyEdits([{ index: 0, id: rawId }]);

    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.Air);
    expect(chunk.getEdits()).toEqual([]);
    expect(chunk.editCount).toBe(0);
    expect(chunk.getHeight(0, 0)).toBe(0);
    expect(chunk.highestNonAir).toBe(-1);
  });

  it('accepts the id boundaries and rejects everything outside them', () => {
    const chunk = new Chunk(0, 0);
    const asId = (value: number): BlockId => value as unknown as BlockId;

    chunk.applyEdits([
      { index: layoutIndex(0, 0, 0), id: asId(0) },
      { index: layoutIndex(1, 0, 1), id: asId(255) },
      { index: layoutIndex(2, 0, 2), id: asId(-1) },
      { index: layoutIndex(3, 0, 3), id: asId(256) },
      { index: layoutIndex(4, 0, 4), id: asId(1.5) },
      { index: layoutIndex(5, 0, 5), id: asId(Number.NaN) },
    ]);

    // id 255 has no definition but is a representable byte, so it is stored; the
    // registry answers every predicate with `false` for it (documented fail-open).
    expect(chunk.getBlock(1, 0, 1)).toBe(255);
    expect(chunk.getBlock(2, 0, 2)).toBe(BlockId.Air);
    expect(chunk.getBlock(3, 0, 3)).toBe(BlockId.Air);
    expect(chunk.getBlock(4, 0, 4)).toBe(BlockId.Air);
    expect(chunk.getBlock(5, 0, 5)).toBe(BlockId.Air);
    expect(chunk.editCount).toBe(2);
  });

  it('skips a fractional index instead of leaving it in the edit log', () => {
    // Fixed regression: `applyEdits` only range-checked the index, so a float
    // passed through, the typed-array write was silently dropped, and the bogus
    // index stayed in the log (and therefore in the next save file).
    const chunk = new Chunk(0, 0);
    const fractional = layoutIndex(1, 1, 1) + 0.5;

    chunk.applyEdits([{ index: fractional, id: BlockId.Stone }]);

    expect(chunk.getBlock(1, 1, 1)).toBe(BlockId.Air);
    expect(chunk.getEdits()).toEqual([]);
    expect(chunk.editCount).toBe(0);
    expect(chunk.highestNonAir).toBe(-1);
  });

  it('keeps applying valid edits when an invalid one sits between them', () => {
    // The invalid entries are skipped, not treated as a fatal payload: dropping a
    // whole chunk because one record is corrupt would lose the player's build.
    const chunk = new Chunk(0, 0);
    const asId = (value: number): BlockId => value as unknown as BlockId;

    chunk.applyEdits([
      { index: layoutIndex(0, 5, 0), id: BlockId.Stone },
      { index: -1, id: BlockId.Stone },
      { index: layoutIndex(1, 5, 1), id: asId(9999) },
      { index: layoutIndex(2, 5, 2), id: BlockId.Glass },
      { index: layoutIndex(3, 5, 3) + 0.25, id: BlockId.Stone },
    ]);

    expect(chunk.getBlock(0, 5, 0)).toBe(BlockId.Stone);
    expect(chunk.getBlock(1, 5, 1)).toBe(BlockId.Air);
    expect(chunk.getBlock(2, 5, 2)).toBe(BlockId.Glass);
    expect(chunk.getBlock(3, 5, 3)).toBe(BlockId.Air);
    expect(chunk.editCount).toBe(2);
    expect(chunk.highestNonAir).toBe(5);
  });
});

describe('Chunk: differential fuzz against a shadow model', () => {
  it('keeps both caches exact over 4000 random mutations', () => {
    const random = mulberry32(0xc0ffee);
    const chunk = new Chunk(-2, 7);
    const shadow = new ShadowChunk();

    // A palette that mixes opaque, transparent and fluid blocks, because the
    // height map must not care which of them it is looking at.
    const palette = [
      BlockId.Air,
      BlockId.Stone,
      BlockId.Dirt,
      BlockId.Grass,
      BlockId.Water,
      BlockId.Glass,
      BlockId.Leaves,
      BlockId.Bedrock,
      BlockId.Lamp,
    ];

    for (let step = 0; step < 4000; step += 1) {
      const lx = Math.floor(random() * CHUNK_SIZE_X);
      const lz = Math.floor(random() * CHUNK_SIZE_Z);
      const y = Math.floor(random() * CHUNK_SIZE_Y);
      const id = palette[Math.floor(random() * palette.length)] ?? BlockId.Air;

      const changed = chunk.setBlock(lx, y, lz, id);
      expect(changed, `setBlock(${lx},${y},${lz}) at step ${step}`).toBe(shadow.set(lx, y, lz, id));
      expect(chunk.getBlock(lx, y, lz), `read back at step ${step}`).toBe(id);

      expect(chunk.getHeight(lx, lz), `touched column at step ${step}`).toBe(shadow.height(lx, lz));
      expect(chunk.highestNonAir, `highestNonAir at step ${step}`).toBe(shadow.highest());

      if (step % 97 === 0) {
        expectCachesMatch(chunk, shadow, `step ${step}`);
      }
    }

    expectCachesMatch(chunk, shadow, 'end of fuzz');
    expect(chunk.modified).toBe(true);
    expect(chunk.editCount).toBeGreaterThan(0);
  });

  it('survives a full top-down dig of every column to bedrock', () => {
    const chunk = new Chunk(0, 0);
    const shadow = new ShadowChunk();
    const palette = [BlockId.Stone, BlockId.Dirt, BlockId.Grass, BlockId.Sand];

    // Fill: 60 layers of terrain plus bedrock.
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        chunk.setBlock(lx, 0, lz, BlockId.Bedrock);
        shadow.set(lx, 0, lz, BlockId.Bedrock);
        for (let y = 1; y <= 60; y += 1) {
          const id = palette[(lx + y + lz) % palette.length] ?? BlockId.Stone;
          chunk.setBlock(lx, y, lz, id, false);
          shadow.set(lx, y, lz, id);
        }
      }
    }
    expectCachesMatch(chunk, shadow, 'after filling');

    // Dig every column from the top down, in a shuffled order.
    const random = mulberry32(42);
    const columns: Array<readonly [number, number]> = [];
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        columns.push([lx, lz]);
      }
    }
    for (let i = columns.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const a = columns[i];
      const b = columns[j];
      if (a !== undefined && b !== undefined) {
        columns[i] = b;
        columns[j] = a;
      }
    }

    for (const column of columns) {
      const [lx, lz] = column;
      for (let y = 60; y >= 0; y -= 1) {
        chunk.setBlock(lx, y, lz, BlockId.Air, false);
        shadow.set(lx, y, lz, BlockId.Air);
      }
      expect(chunk.getHeight(lx, lz), `column (${lx},${lz}) after digging`).toBe(0);
    }

    expectCachesMatch(chunk, shadow, 'after digging everything');
    expect(chunk.highestNonAir).toBe(-1);
  });
});
