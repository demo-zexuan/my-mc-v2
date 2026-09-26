import { describe, expect, it } from 'vitest';

import { BlockId } from '@/world/BlockRegistry';
import { Chunk } from '@/world/Chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_VOLUME, indexInChunk } from '@/world/coords';

describe('Chunk', () => {
  it('starts empty with a zero height map', () => {
    const chunk = new Chunk(0, 0);

    expect(chunk.blocks.length).toBe(CHUNK_VOLUME);
    expect(chunk.highestNonAir).toBe(-1);
    expect(chunk.getHeight(0, 0)).toBe(0);
    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.Air);
    expect(chunk.modified).toBe(false);
  });

  it('rejects a block array of the wrong size', () => {
    // A truncated payload would otherwise read as air past its end and produce a
    // chunk that looks correct until the player walks into it.
    expect(() => new Chunk(0, 0, new Uint8Array(10))).toThrow(RangeError);
  });

  it('round trips a block through local coordinates', () => {
    const chunk = new Chunk(2, -3);

    expect(chunk.setBlock(5, 40, 7, BlockId.Stone)).toBe(true);
    expect(chunk.getBlock(5, 40, 7)).toBe(BlockId.Stone);
    expect(chunk.getBlock(5, 40, 8)).toBe(BlockId.Air);
    expect(chunk.modified).toBe(true);
  });

  it('reports no change when writing the same value', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(1, 1, 1, BlockId.Stone);

    expect(chunk.setBlock(1, 1, 1, BlockId.Stone)).toBe(false);
    expect(chunk.editCount).toBe(1);
  });

  it('ignores out-of-range writes instead of wrapping around', () => {
    const chunk = new Chunk(0, 0);

    // JavaScript writes past the end of a typed array are silently ignored, and a
    // negative index becomes a property rather than an element; both must be
    // rejected explicitly so a broken generator cannot corrupt the chunk.
    expect(chunk.setBlock(-1, 5, 0, BlockId.Stone)).toBe(false);
    expect(chunk.setBlock(CHUNK_SIZE_X, 5, 0, BlockId.Stone)).toBe(false);
    expect(chunk.setBlock(0, -1, 0, BlockId.Stone)).toBe(false);
    expect(chunk.setBlock(0, CHUNK_SIZE_Y, 0, BlockId.Stone)).toBe(false);
    expect(chunk.modified).toBe(false);
  });

  it('returns air outside its bounds', () => {
    const chunk = new Chunk(0, 0);
    expect(chunk.getBlock(-1, 0, 0)).toBe(BlockId.Air);
    expect(chunk.getBlock(0, CHUNK_SIZE_Y, 0)).toBe(BlockId.Air);
  });

  it('grows the height map when a block is added on top', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(3, 10, 4, BlockId.Stone);

    expect(chunk.getHeight(3, 4)).toBe(11);
    expect(chunk.highestNonAir).toBe(10);

    chunk.setBlock(3, 20, 4, BlockId.Stone);
    expect(chunk.getHeight(3, 4)).toBe(21);
    expect(chunk.highestNonAir).toBe(20);
  });

  it('shrinks the height map when the top block is removed', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(3, 10, 4, BlockId.Stone);
    chunk.setBlock(3, 20, 4, BlockId.Stone);

    chunk.setBlock(3, 20, 4, BlockId.Air);

    // The lower block must become the new surface; forgetting to recompute leaves
    // the player floating and trees spawning in mid-air.
    expect(chunk.getHeight(3, 4)).toBe(11);
    expect(chunk.highestNonAir).toBe(10);
  });

  it('empties a column completely', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(3, 10, 4, BlockId.Stone);
    chunk.setBlock(3, 10, 4, BlockId.Air);

    expect(chunk.getHeight(3, 4)).toBe(0);
    expect(chunk.highestNonAir).toBe(-1);
  });

  it('keeps the highest non-air block correct when a middle block is removed', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(1, 5, 1, BlockId.Stone);
    chunk.setBlock(1, 30, 1, BlockId.Stone);

    chunk.setBlock(1, 5, 1, BlockId.Air);

    expect(chunk.highestNonAir).toBe(30);
    expect(chunk.getHeight(1, 1)).toBe(31);
  });

  it('records edits and replays them', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(1, 2, 3, BlockId.Glass);
    chunk.setBlock(4, 5, 6, BlockId.Brick);

    const edits = chunk.getEdits();
    expect(edits).toHaveLength(2);

    const restored = new Chunk(0, 0);
    restored.applyEdits(edits);

    expect(restored.getBlock(1, 2, 3)).toBe(BlockId.Glass);
    expect(restored.getBlock(4, 5, 6)).toBe(BlockId.Brick);
    expect(restored.modified).toBe(true);
    expect(restored.getHeight(4, 6)).toBe(6);
  });

  it('keeps only the final value when a block is edited twice', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(1, 2, 3, BlockId.Stone);
    chunk.setBlock(1, 2, 3, BlockId.Air);

    const edits = chunk.getEdits();
    expect(edits).toHaveLength(1);
    expect(edits[0]?.id).toBe(BlockId.Air);
  });

  it('skips edits that fall outside the chunk when replaying', () => {
    const chunk = new Chunk(0, 0);
    // A save written by a version with a taller world must not throw.
    chunk.applyEdits([
      { index: CHUNK_VOLUME + 10, id: BlockId.Stone },
      { index: -1, id: BlockId.Stone },
      { index: indexInChunk(0, 0, 0), id: BlockId.Bedrock },
    ]);

    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.Bedrock);
  });

  it('recomputes the whole height map when asked', () => {
    const chunk = new Chunk(0, 0);
    chunk.blocks[indexInChunk(2, 9, 2)] = BlockId.Sand;

    chunk.recomputeHeightMap();

    expect(chunk.getHeight(2, 2)).toBe(10);
    expect(chunk.highestNonAir).toBe(9);
  });

  it('tracks the mesh-dirty flag', () => {
    const chunk = new Chunk(0, 0);
    expect(chunk.meshDirty).toBe(true);

    chunk.markMeshClean();
    expect(chunk.meshDirty).toBe(false);

    chunk.setBlock(0, 1, 0, BlockId.Stone);
    expect(chunk.meshDirty).toBe(true);
  });

  it('does not mark generated blocks as edits when asked not to', () => {
    const chunk = new Chunk(0, 0);
    chunk.setBlock(0, 1, 0, BlockId.Stone, false);

    expect(chunk.modified).toBe(false);
    expect(chunk.getBlock(0, 1, 0)).toBe(BlockId.Stone);
  });
});
