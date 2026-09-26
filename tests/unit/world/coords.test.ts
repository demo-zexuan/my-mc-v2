import { describe, expect, it } from 'vitest';

import {
  CHUNK_AREA,
  CHUNK_SIZE_X,
  CHUNK_SIZE_Y,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
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

describe('chunk constants', () => {
  it('stay self-consistent', () => {
    expect(CHUNK_AREA).toBe(CHUNK_SIZE_X * CHUNK_SIZE_Z);
    expect(CHUNK_VOLUME).toBe(CHUNK_AREA * CHUNK_SIZE_Y);
  });
});

describe('worldToChunkCoord', () => {
  it('maps positive coordinates to their chunk', () => {
    expect(worldToChunkCoord(0, 16)).toBe(0);
    expect(worldToChunkCoord(15, 16)).toBe(0);
    expect(worldToChunkCoord(16, 16)).toBe(1);
    expect(worldToChunkCoord(31, 16)).toBe(1);
  });

  it('maps negative coordinates to the chunk on their own side', () => {
    // Truncation instead of flooring would place -1 in chunk 0 and produce a
    // one-block-wide seam of duplicated terrain along both axes.
    expect(worldToChunkCoord(-1, 16)).toBe(-1);
    expect(worldToChunkCoord(-16, 16)).toBe(-1);
    expect(worldToChunkCoord(-17, 16)).toBe(-2);
  });
});

describe('worldToLocalCoord', () => {
  it('never returns a negative value', () => {
    for (const value of [-1, -15, -16, -17, -1000, -32768]) {
      const local = worldToLocalCoord(value, 16);
      expect(local).toBeGreaterThanOrEqual(0);
      expect(local).toBeLessThan(16);
    }
  });

  it('matches the chunk coordinate it was derived from', () => {
    for (const value of [-32768, -1234, -17, -16, -1, 0, 1, 15, 16, 1234, 32768]) {
      const chunk = worldToChunkCoord(value, 16);
      const local = worldToLocalCoord(value, 16);
      // The defining property: chunk * size + local === value.
      expect(chunk * 16 + local).toBe(value);
    }
  });
});

describe('blockToChunk / blockToLocal', () => {
  it('agree with the single-axis helpers', () => {
    for (const [x, z] of [
      [0, 0],
      [15, 15],
      [16, 16],
      [-1, -1],
      [-16, -17],
      [-33, 47],
    ] as const) {
      const { cx, cz } = blockToChunk(x, z);
      const { lx, lz } = blockToLocal(x, z);
      expect(cx).toBe(worldToChunkCoord(x, CHUNK_SIZE_X));
      expect(cz).toBe(worldToChunkCoord(z, CHUNK_SIZE_Z));
      expect(cx * CHUNK_SIZE_X + lx).toBe(x);
      expect(cz * CHUNK_SIZE_Z + lz).toBe(z);
    }
  });
});

describe('indexInChunk', () => {
  it('stays inside the chunk volume for every legal coordinate', () => {
    expect(indexInChunk(0, 0, 0)).toBe(0);
    expect(indexInChunk(15, 0, 0)).toBe(15);
    expect(indexInChunk(0, 0, 1)).toBe(16);
    expect(indexInChunk(0, 1, 0)).toBe(CHUNK_AREA);
    const last = indexInChunk(CHUNK_SIZE_X - 1, CHUNK_SIZE_Y - 1, CHUNK_SIZE_Z - 1);
    expect(last).toBe(CHUNK_VOLUME - 1);
  });

  it('produces a unique index for every coordinate', () => {
    const seen = new Set<number>();
    for (let y = 0; y < CHUNK_SIZE_Y; y += 7) {
      for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
        for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
          const index = indexInChunk(lx, y, lz);
          expect(seen.has(index)).toBe(false);
          seen.add(index);
        }
      }
    }
  });
});

describe('coordsFromIndex', () => {
  it('is the exact inverse of indexInChunk', () => {
    // Exhaustive over the full chunk: a single off-by-one in the inverse would
    // make bulk edit loading write blocks into the wrong place.
    for (let y = 0; y < CHUNK_SIZE_Y; y += 1) {
      for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
        for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
          const index = indexInChunk(lx, y, lz);
          const decoded = coordsFromIndex(index);
          if (decoded.lx !== lx || decoded.y !== y || decoded.lz !== lz) {
            throw new Error(
              `round trip failed for (${lx},${y},${lz}) -> ${index} -> (${decoded.lx},${decoded.y},${decoded.lz})`,
            );
          }
        }
      }
    }
    expect(true).toBe(true);
  });
});

describe('chunkKey', () => {
  it('round trips over a wide coordinate range', () => {
    for (const cx of [-4096, -1, 0, 1, 4096, 100000]) {
      for (const cz of [-4096, -1, 0, 1, 4096, -100000]) {
        const decoded = chunkKeyToCoord(chunkKey(cx, cz));
        expect(decoded).toEqual({ cx, cz });
      }
    }
  });

  it('does not collide for neighbouring coordinates', () => {
    const keys = new Set<number>();
    for (let cx = -64; cx <= 64; cx += 1) {
      for (let cz = -64; cz <= 64; cz += 1) {
        keys.add(chunkKey(cx, cz));
      }
    }
    expect(keys.size).toBe(129 * 129);
  });
});

describe('isInsideWorldHeight', () => {
  it('includes both boundaries', () => {
    expect(isInsideWorldHeight(0)).toBe(true);
    expect(isInsideWorldHeight(CHUNK_SIZE_Y - 1)).toBe(true);
    expect(isInsideWorldHeight(CHUNK_SIZE_Y)).toBe(false);
    expect(isInsideWorldHeight(-1)).toBe(false);
  });
});
