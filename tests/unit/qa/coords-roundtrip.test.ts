import { describe, expect, it } from 'vitest';

import {
  CHUNK_AREA,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Y,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
  blockToChunk,
  blockToLocal,
  chunkKey,
  chunkKeyToCoord,
  coordsFromIndex,
  indexInChunk,
  isInsideWorldHeight,
  worldToChunkCoord,
  worldToLocalCoord,
} from '@/world/coords';

/**
 * Adversarial coordinate tests (T7 QA).
 *
 * I. Why these duplicate the "obvious" cases
 *
 * The chunk mesher, terrain generator and save format all derive indices from
 * this module. A single off-by-one here is invisible in the positive quadrant
 * and corrupts everything at x < 0, which is exactly where a casual play test
 * never looks. Every assertion below is therefore written to fail loudly on a
 * boundary (0, size-1, -1, -size) rather than in the middle of a chunk.
 */

describe('coords: indexInChunk <-> coordsFromIndex', () => {
  it('is exactly inverse for every one of the 32768 valid indices', () => {
    const seen = new Set<number>();

    for (let y = 0; y < CHUNK_SIZE_Y; y += 1) {
      for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
        for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
          const index = indexInChunk(lx, y, lz);

          // I. Uniqueness: a collision would make two blocks share storage.
          expect(seen.has(index), `index ${index} reused by (${lx},${y},${lz})`).toBe(false);
          seen.add(index);

          const back = coordsFromIndex(index);
          expect({ lx: back.lx, y: back.y, lz: back.lz }).toEqual({ lx, y, lz });
        }
      }
    }

    expect(seen.size).toBe(CHUNK_VOLUME);
    expect(Math.min(...seen)).toBe(0);
    expect(Math.max(...seen)).toBe(CHUNK_VOLUME - 1);
  });

  it('maps the eight chunk corners to the documented extremes', () => {
    expect(indexInChunk(0, 0, 0)).toBe(0);
    expect(indexInChunk(CHUNK_SIZE_X - 1, 0, CHUNK_SIZE_Z - 1)).toBe(CHUNK_AREA - 1);
    expect(indexInChunk(0, WORLD_MAX_Y, 0)).toBe(WORLD_MAX_Y * CHUNK_AREA);
    expect(indexInChunk(CHUNK_SIZE_X - 1, WORLD_MAX_Y, CHUNK_SIZE_Z - 1)).toBe(CHUNK_VOLUME - 1);

    expect(coordsFromIndex(0)).toEqual({ lx: 0, y: 0, lz: 0 });
    expect(coordsFromIndex(CHUNK_VOLUME - 1)).toEqual({
      lx: CHUNK_SIZE_X - 1,
      y: WORLD_MAX_Y,
      lz: CHUNK_SIZE_Z - 1,
    });
  });

  it('does not validate its input, so callers must pre-check (characterisation)', () => {
    // `indexInChunk` is a hot-path helper with no bounds check. Recording this
    // explicitly because it is the reason a fractional coordinate can reach the
    // typed array without throwing: see the World tests.
    const aliased = coordsFromIndex(indexInChunk(CHUNK_SIZE_X, 0, 0));
    expect(aliased).toEqual({ lx: 0, y: 0, lz: 1 });

    const fractional = indexInChunk(1.5, 0, 0);
    expect(Number.isInteger(fractional)).toBe(false);
    expect(fractional).toBe(1.5);
  });
});

describe('coords: world <-> chunk <-> local conversion', () => {
  it('assigns negative world coordinates to the chunk on their negative side', () => {
    const cases: readonly (readonly [number, number, number])[] = [
      // [world, chunk, local]
      [0, 0, 0],
      [15, 0, 15],
      [16, 1, 0],
      [-1, -1, 15],
      [-2, -1, 14],
      [-15, -1, 1],
      [-16, -1, 0],
      [-17, -2, 15],
      [-32, -2, 0],
      [-33, -3, 15],
      [31, 1, 15],
      [32, 2, 0],
    ];

    for (const [world, chunk, local] of cases) {
      expect(worldToChunkCoord(world, CHUNK_SIZE_X), `chunk of ${world}`).toBe(chunk);
      // `Object.is` is deliberately avoided: at exact multiples of the chunk size
      // `%` returns negative zero, which is `-0` rather than `0`. That is
      // harmless for every downstream use (index arithmetic, `=== 0` tests and
      // Map keys all treat the two the same) but it is worth pinning down.
      expect(worldToLocalCoord(world, CHUNK_SIZE_X) === local, `local of ${world}`).toBe(true);

      // The two halves must always reconstruct the original coordinate.
      expect(chunk * CHUNK_SIZE_X + local).toBe(world);
    }
  });

  it('returns negative zero for world coordinates at an exact chunk multiple', () => {
    // Characterisation: `-16 % 16` is `-0` and the `local < 0` correction does
    // not fire, so the caller receives `-0`. Every consumer is unaffected — the
    // real risk would be a caller comparing with `Object.is` or serialising the
    // value into a format that preserves the sign of zero.
    const local = worldToLocalCoord(-16, CHUNK_SIZE_X);
    expect(local === 0).toBe(true);
    expect(Object.is(local, -0)).toBe(true);
    expect(Object.is(worldToLocalCoord(16, CHUNK_SIZE_X), -0)).toBe(false);
    expect(indexInChunk(local, 5, 3)).toBe(indexInChunk(0, 5, 3));
  });

  it('never returns a negative local coordinate for any sampled world value', () => {
    for (let world = -512; world <= 512; world += 1) {
      const local = worldToLocalCoord(world, CHUNK_SIZE_X);
      expect(local).toBeGreaterThanOrEqual(0);
      expect(local).toBeLessThan(CHUNK_SIZE_X);
      expect(worldToChunkCoord(world, CHUNK_SIZE_X) * CHUNK_SIZE_X + local).toBe(world);
    }
  });

  it('keeps blockToChunk and blockToLocal consistent with the scalar helpers', () => {
    for (const x of [-257, -33, -16, -1, 0, 1, 15, 16, 31, 32, 255]) {
      for (const z of [-257, -16, -1, 0, 15, 16, 33, 255]) {
        const chunk = blockToChunk(x, z);
        const local = blockToLocal(x, z);

        expect(chunk.cx).toBe(worldToChunkCoord(x, CHUNK_SIZE_X));
        expect(chunk.cz).toBe(worldToChunkCoord(z, CHUNK_SIZE_Z));
        expect(local.lx).toBe(worldToLocalCoord(x, CHUNK_SIZE_X));
        expect(local.lz).toBe(worldToLocalCoord(z, CHUNK_SIZE_Z));
        expect(chunk.cx * CHUNK_SIZE_X + local.lx).toBe(x);
        expect(chunk.cz * CHUNK_SIZE_Z + local.lz).toBe(z);
      }
    }
  });

  it('treats non-integer coordinates the way Math.floor does (characterisation)', () => {
    // The module does not floor its inputs. -0.5 therefore lands on chunk -1 with
    // local 15.5, which is *not* a valid local coordinate; callers must floor.
    expect(worldToChunkCoord(-0.5, CHUNK_SIZE_X)).toBe(-1);
    expect(worldToLocalCoord(-0.5, CHUNK_SIZE_X)).toBe(15.5);
  });
});

describe('coords: chunkKey packing', () => {
  it('round-trips every chunk in a 513x513 neighbourhood, negatives included', () => {
    for (let cx = -256; cx <= 256; cx += 1) {
      for (let cz = -256; cz <= 256; cz += 1) {
        const key = chunkKey(cx, cz);
        expect(Number.isSafeInteger(key), `key for (${cx},${cz}) is not a safe integer`).toBe(true);
        expect(chunkKeyToCoord(key)).toEqual({ cx, cz });
      }
    }
  });

  it('produces distinct keys over that neighbourhood', () => {
    const keys = new Set<number>();
    for (let cx = -128; cx <= 128; cx += 1) {
      for (let cz = -128; cz <= 128; cz += 1) {
        keys.add(chunkKey(cx, cz));
      }
    }
    expect(keys.size).toBe(257 * 257);
  });

  it('round-trips extreme but reachable coordinates', () => {
    const extremes: readonly (readonly [number, number])[] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [-1, -1],
      [1_000_000, 1_000_000],
      [-1_000_000, -1_000_000],
      [1_000_000, -1_000_000],
      [-1_000_000, 1_000_000],
      [2_097_151, 2_097_151],
      [-2_097_152, -2_097_152],
    ];

    for (const [cx, cz] of extremes) {
      expect(chunkKeyToCoord(chunkKey(cx, cz)), `round trip for (${cx},${cz})`).toEqual({ cx, cz });
    }
  });

  it('collides once cz leaves the documented +-2^21 window (characterisation)', () => {
    // The packing reserves 22 bits for cz. `cz = +2^21` overflows into the cx
    // field, so it aliases the chunk one step to the +cx side:
    //   chunkKey(0, 2^21) === chunkKey(1, -2^21)
    // The module documents a +-1,048,576 chunk range, which is +-16.7 M blocks
    // and far outside any reachable world, so this is a documented limit rather
    // than a live bug — but the limit is silent: the two chunks would share one
    // Map entry instead of throwing.
    const limit = 0x200000;
    expect(chunkKey(0, limit)).toBe(chunkKey(1, -limit));
    expect(chunkKey(0, limit - 1)).not.toBe(chunkKey(1, -(limit - 1)));
  });
});

describe('coords: world height predicates', () => {
  it('accepts exactly 0..127 and nothing outside', () => {
    expect(isInsideWorldHeight(WORLD_MIN_Y)).toBe(true);
    expect(isInsideWorldHeight(WORLD_MAX_Y)).toBe(true);
    expect(isInsideWorldHeight(-1)).toBe(false);
    expect(isInsideWorldHeight(WORLD_MAX_Y + 1)).toBe(false);
    expect(isInsideWorldHeight(Number.NaN)).toBe(false);
    expect(isInsideWorldHeight(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('exposes a chunk volume that matches the geometry helpers', () => {
    expect(CHUNK_VOLUME).toBe(CHUNK_SIZE_X * CHUNK_SIZE_Y * CHUNK_SIZE_Z);
    expect(CHUNK_AREA).toBe(CHUNK_SIZE_X * CHUNK_SIZE_Z);
  });
});
