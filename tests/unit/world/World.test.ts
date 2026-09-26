import { describe, expect, it } from 'vitest';

import { BlockId } from '@/world/BlockRegistry';
import { World } from '@/world/World';
import { CHUNK_SIZE_Y, chunkKey } from '@/world/coords';

import { FakeTerrainGenerator, markerFor } from '../../support/fakeTerrain';

function createWorld(seed = 7): World {
  return new World({ seed, generator: new FakeTerrainGenerator(seed) });
}

describe('World', () => {
  it('generates a chunk synchronously on request', () => {
    const world = createWorld();
    const chunk = world.generateChunkNow(0, 0);

    expect(world.loadedChunkCount).toBe(1);
    expect(world.hasChunk(0, 0)).toBe(true);
    expect(chunk.getBlock(0, 0, 0)).toBe(BlockId.Bedrock);
    expect(chunk.getBlock(0, 8, 0)).toBe(BlockId.Grass);
    expect(chunk.getBlock(0, 9, 0)).toBe(markerFor(0, 0));
  });

  it('returns the existing chunk instead of regenerating it', () => {
    const world = createWorld();
    const chunk = world.generateChunkNow(1, 2);

    expect(world.generateChunkNow(1, 2)).toBe(chunk);
    expect(world.loadedChunkCount).toBe(1);
  });

  it('clips out-of-chunk writes coming from the generator', () => {
    // The fake generator deliberately writes at lx = -1 and lx = 16.
    const world = createWorld();
    expect(() => world.generateChunkNow(0, 0)).not.toThrow();

    const chunk = world.getChunk(0, 0);
    expect(chunk?.getBlock(-1, 10, 0)).toBe(BlockId.Air);
    expect(chunk?.getBlock(16, 10, 0)).toBe(BlockId.Air);
  });

  it('reads air outside loaded chunks', () => {
    const world = createWorld();
    expect(world.getBlock(9999, 40, 9999)).toBe(BlockId.Air);
  });

  it('reports bedrock below the world so nothing can fall out of it', () => {
    const world = createWorld();
    world.generateChunkNow(0, 0);

    expect(world.getBlock(4, -1, 4)).toBe(BlockId.Bedrock);
    expect(world.getBlock(4, -100, 4)).toBe(BlockId.Bedrock);
    expect(world.getBlock(4, CHUNK_SIZE_Y, 4)).toBe(BlockId.Air);
    expect(world.getBlock(4, 500, 4)).toBe(BlockId.Air);
  });

  it('converts world coordinates to the right chunk, including negatives', () => {
    const world = createWorld();
    // Generating 0,0 and -1,-1 lets the test prove the lookup lands in the right
    // chunk: a floor/truncate mistake here would read chunk 0 for x = -1.
    world.generateChunkNow(0, 0);
    world.generateChunkNow(-1, -1);

    expect(world.getBlock(0, 9, 0)).toBe(markerFor(0, 0));
    // The fake generator caps every column with grass at y = 8.
    expect(world.getBlock(-1, 8, -1)).toBe(BlockId.Grass);
    expect(world.getBlock(-16, 9, -16)).toBe(markerFor(-1, -1));
  });

  it('writes blocks in world coordinates', () => {
    const world = createWorld();
    world.generateChunkNow(0, 0);

    expect(world.setBlock(5, 30, 6, BlockId.Brick)).toBe(true);
    expect(world.getBlock(5, 30, 6)).toBe(BlockId.Brick);
    expect(world.getChunk(0, 0)?.modified).toBe(true);
  });

  it('writes through the positive/negative boundary correctly', () => {
    const world = createWorld();
    world.generateChunkNow(-1, -1);

    expect(world.setBlock(-1, 40, -1, BlockId.Lamp)).toBe(true);
    expect(world.getBlock(-1, 40, -1)).toBe(BlockId.Lamp);
    expect(world.getChunk(-1, -1)?.modified).toBe(true);
  });

  it('marks the neighbouring chunk dirty when a border block changes', () => {
    const world = createWorld();
    world.generateChunkNow(0, 0);
    world.generateChunkNow(1, 0);
    world.generateChunkNow(0, 1);

    const east = world.getChunk(1, 0);
    const north = world.getChunk(0, 1);
    east?.markMeshClean();
    north?.markMeshClean();

    // x = 15 is the last column of chunk 0.
    world.setBlock(15, 40, 5, BlockId.Glass);

    // Without this, digging at a chunk boundary shows a hole from one side only.
    expect(east?.meshDirty).toBe(true);
    expect(north?.meshDirty).toBe(false);
  });

  it('marks both neighbours dirty at a chunk corner', () => {
    const world = createWorld();
    for (const [cx, cz] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ] as const) {
      world.generateChunkNow(cx, cz);
    }

    const east = world.getChunk(1, 0);
    const north = world.getChunk(0, 1);
    east?.markMeshClean();
    north?.markMeshClean();

    world.setBlock(15, 40, 15, BlockId.Glass);

    expect(east?.meshDirty).toBe(true);
    expect(north?.meshDirty).toBe(true);
  });

  it('refuses writes outside the world height', () => {
    const world = createWorld();
    world.generateChunkNow(0, 0);

    expect(world.setBlock(1, -1, 1, BlockId.Stone)).toBe(false);
    expect(world.setBlock(1, CHUNK_SIZE_Y, 1, BlockId.Stone)).toBe(false);
  });

  it('refuses writes into an unloaded chunk', () => {
    const world = createWorld();
    expect(world.setBlock(5000, 40, 5000, BlockId.Stone)).toBe(false);
  });

  it('tracks the pending flag so a chunk is never queued twice', () => {
    const world = createWorld();

    expect(world.beginGeneration(3, 3)).toBe(true);
    expect(world.beginGeneration(3, 3)).toBe(false);
    expect(world.isPending(3, 3)).toBe(true);

    world.cancelGeneration(3, 3);
    expect(world.isPending(3, 3)).toBe(false);
    expect(world.beginGeneration(3, 3)).toBe(true);
  });

  it('clears the pending flag when a generated chunk arrives', () => {
    const world = createWorld();
    world.beginGeneration(0, 0);
    world.adoptGeneratedChunk(0, 0, new Uint8Array(CHUNK_SIZE_Y * 256));

    expect(world.isPending(0, 0)).toBe(false);
    expect(world.hasChunk(0, 0)).toBe(true);
  });

  it('hands back edited chunks on unload and drops clean ones', () => {
    const world = createWorld();
    world.generateChunkNow(0, 0);
    world.generateChunkNow(1, 0);
    world.setBlock(5, 40, 5, BlockId.Brick);

    // Losing an edited chunk would delete the player's build.
    const edited = world.unloadChunk(0, 0);
    expect(edited).not.toBeNull();
    expect(edited?.modified).toBe(true);

    expect(world.unloadChunk(1, 0)).toBeNull();
    expect(world.loadedChunkCount).toBe(0);
  });

  it('iterates only edited chunks', () => {
    const world = createWorld();
    world.generateChunkNow(0, 0);
    world.generateChunkNow(1, 0);
    world.setBlock(5, 40, 5, BlockId.Brick);

    const edited = [...world.editedChunks()];
    expect(edited).toHaveLength(1);
    expect(edited[0]?.cx).toBe(0);
  });

  it('trims unedited chunks but keeps edited ones', () => {
    const world = new World({
      seed: 1,
      generator: new FakeTerrainGenerator(1),
      maxLoadedChunks: 3,
    });
    for (let cx = 0; cx < 6; cx += 1) {
      world.generateChunkNow(cx, 0);
    }
    world.setBlock(1, 40, 1, BlockId.Brick);

    const dropped = world.trimToCapacity();

    expect(dropped).toBeGreaterThan(0);
    expect(world.loadedChunkCount).toBeLessThanOrEqual(3);
    expect(world.hasChunk(0, 0)).toBe(true);
  });

  it('honours protected keys while trimming', () => {
    const world = new World({
      seed: 1,
      generator: new FakeTerrainGenerator(1),
      maxLoadedChunks: 2,
    });
    for (let cx = 0; cx < 4; cx += 1) {
      world.generateChunkNow(cx, 0);
    }

    world.trimToCapacity(new Set([chunkKey(3, 0)]));

    expect(world.hasChunk(3, 0)).toBe(true);
  });

  it('reports statistics for the debug overlay', () => {
    const world = createWorld();
    world.generateChunkNow(0, 0);
    world.setBlock(1, 40, 1, BlockId.Brick);

    const stats = world.stats();
    expect(stats.loadedChunks).toBe(1);
    expect(stats.editedChunks).toBe(1);
    expect(stats.pendingChunks).toBe(0);
  });

  it('falls back to the generator for unloaded surface queries', () => {
    const world = createWorld();
    expect(world.surfaceHeightAt(1234, 5678)).toBe(10);

    world.generateChunkNow(0, 0);
    // Once the chunk exists the cached height map wins. Column (5,5) is plain
    // terrain (grass at y = 8), while (0,0) carries the marker block the fake
    // generator writes at y = 9.
    expect(world.surfaceHeightAt(5, 5)).toBe(9);
    expect(world.surfaceHeightAt(0, 0)).toBe(10);
  });

  it('clears everything when the world is closed', () => {
    const world = createWorld();
    world.generateChunkNow(0, 0);
    world.beginGeneration(1, 1);

    world.clear();

    expect(world.loadedChunkCount).toBe(0);
    expect(world.isPending(1, 1)).toBe(false);
  });
});
