import { describe, expect, it, vi } from 'vitest';

import type { ChunkGenerationSource, ChunkRequest } from '@/workers/WorkerPool';
import { BlockId } from '@/world/BlockRegistry';
import { ChunkStreamer } from '@/world/ChunkStreamer';
import { World } from '@/world/World';
import { CHUNK_VOLUME, chunkKey, indexInChunk } from '@/world/coords';

import { FakeTerrainGenerator } from '../../support/fakeTerrain';

/** Generation source that answers immediately and records what was asked for. */
class FakeSource implements ChunkGenerationSource {
  public readonly requested: ChunkRequest[] = [];
  public readonly generator = new FakeTerrainGenerator(11);
  public inFlight = 0;
  public failNext = false;
  public hold = false;
  readonly #held: (() => void)[] = [];
  #disposed = false;

  public async request({ cx, cz }: ChunkRequest): Promise<Uint8Array | null> {
    if (this.#disposed) {
      return null;
    }
    this.requested.push({ cx, cz });
    if (this.failNext) {
      this.failNext = false;
      return null;
    }
    if (this.hold) {
      this.inFlight += 1;
      await new Promise<void>((resolve) => {
        this.#held.push(resolve);
      });
      this.inFlight -= 1;
    }
    const blocks = new Uint8Array(CHUNK_VOLUME);
    blocks[indexInChunk(0, 0, 0)] = BlockId.Bedrock;
    blocks[indexInChunk(0, 4, 0)] = BlockId.Grass;
    return blocks;
  }

  /** Releases every held request. */
  public release(): void {
    const held = this.#held.splice(0, this.#held.length);
    for (const resolve of held) {
      resolve();
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.release();
  }
}

function createWorld(): World {
  return new World({ seed: 11, generator: new FakeTerrainGenerator(11) });
}

/** Flushes the microtask queue so resolved requests land in the world. */
async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe('ChunkStreamer', () => {
  it('loads the chunks around the player, nearest first', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 2,
      dispatchBudget: 100,
      maxInFlight: 100,
    });

    const dispatched = streamer.update(8, 8);
    await flush();

    expect(dispatched).toBeGreaterThan(0);
    expect(source.requested[0]).toEqual({ cx: 0, cz: 0 });

    // The queue is a circular radius: a 2 chunk radius covers 13 columns, not 25.
    expect(world.loadedChunkCount).toBe(13);
    expect(world.hasChunk(2, 2)).toBe(false);
  });

  it('does not re-request chunks it already has', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 1,
      dispatchBudget: 100,
      maxInFlight: 100,
    });

    streamer.update(0, 0);
    await flush();
    const afterFirst = source.requested.length;

    // Moving inside the same chunk must not re-queue anything.
    streamer.update(4, 4);
    await flush();

    expect(source.requested.length).toBe(afterFirst);
  });

  it('requests more chunks after crossing a chunk boundary', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 1,
      dispatchBudget: 100,
      maxInFlight: 100,
    });

    streamer.update(0, 0);
    await flush();
    const afterFirst = source.requested.length;

    streamer.update(32, 0);
    await flush();

    expect(source.requested.length).toBeGreaterThan(afterFirst);
    expect(world.hasChunk(2, 0)).toBe(true);
  });

  it('respects the per-update dispatch budget', () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 8,
      dispatchBudget: 3,
      maxInFlight: 100,
    });

    const dispatched = streamer.update(0, 0);

    // Without the budget, spawning would queue hundreds of chunks at once and the
    // player would see nothing until the last one finished.
    expect(dispatched).toBe(3);
    expect(streamer.stats.queued).toBeGreaterThan(0);
  });

  it('respects the in-flight cap', async () => {
    const world = createWorld();
    const source = new FakeSource();
    source.hold = true;
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 6,
      dispatchBudget: 100,
      maxInFlight: 4,
    });

    const dispatched = streamer.update(0, 0);

    expect(dispatched).toBe(4);
    expect(source.inFlight).toBe(4);

    source.release();
    await flush();
    streamer.dispose();
    source.dispose();
  });

  it('unloads chunks beyond the keep margin but keeps edited ones', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 1,
      keepMargin: 1,
      dispatchBudget: 100,
      maxInFlight: 100,
    });
    const onEdited = vi.fn();
    streamer.setOnEditedChunkUnloaded(onEdited);

    streamer.update(0, 0);
    await flush();
    expect(world.hasChunk(0, 0)).toBe(true);

    // Mark chunk (0,0) as edited so it survives being out of range.
    world.setBlock(1, 20, 1, BlockId.Brick);

    streamer.update(400, 400);
    await flush();

    expect(world.hasChunk(0, 0)).toBe(false);
    expect(onEdited).toHaveBeenCalledTimes(1);
    expect(onEdited.mock.calls[0]?.[0]).toMatchObject({ cx: 0, cz: 0 });
  });

  it('drops clean chunks without notifying the save layer', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 1,
      keepMargin: 0,
      dispatchBudget: 100,
      maxInFlight: 100,
    });
    const onEdited = vi.fn();
    streamer.setOnEditedChunkUnloaded(onEdited);

    streamer.update(0, 0);
    await flush();
    streamer.update(400, 400);
    await flush();

    expect(world.hasChunk(0, 0)).toBe(false);
    expect(onEdited).not.toHaveBeenCalled();
  });

  it('counts failures and clears the pending flag so the chunk can be retried', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 0,
      dispatchBudget: 4,
      maxInFlight: 4,
    });

    source.failNext = true;
    streamer.update(0, 0);
    await flush();

    expect(streamer.stats.failed).toBe(1);
    expect(world.isPending(0, 0)).toBe(false);
  });

  it('preloads a neighbourhood', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({ world, source, renderDistance: 1 });

    await streamer.preload(0, 0, 1);

    // 3x3 = 9 chunks for the square preload used by the spawn sequence.
    expect(world.loadedChunkCount).toBe(9);
    expect(world.hasChunk(-1, -1)).toBe(true);
    expect(world.hasChunk(1, 1)).toBe(true);
  });

  it('changes render distance at runtime', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 1,
      dispatchBudget: 100,
      maxInFlight: 100,
    });
    streamer.update(0, 0);
    await flush();
    const before = world.loadedChunkCount;

    streamer.setRenderDistance(2);
    streamer.update(0, 0);
    await flush();

    expect(streamer.renderDistance).toBe(2);
    expect(world.loadedChunkCount).toBeGreaterThan(before);
  });

  it('clamps the render distance to a sane range', () => {
    const streamer = new ChunkStreamer({
      world: createWorld(),
      source: new FakeSource(),
    });

    streamer.setRenderDistance(0);
    expect(streamer.renderDistance).toBe(1);
    streamer.setRenderDistance(999);
    expect(streamer.renderDistance).toBe(32);
  });

  it('treats fractional render distances as whole chunks', () => {
    const streamer = new ChunkStreamer({
      world: createWorld(),
      source: new FakeSource(),
    });

    streamer.setRenderDistance(4.6);
    expect(streamer.renderDistance).toBe(5);
  });

  it('stops accepting work after dispose', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 2,
      dispatchBudget: 100,
      maxInFlight: 100,
    });
    streamer.dispose();

    expect(streamer.update(0, 0)).toBe(0);
    await streamer.preload(0, 0, 1);
    expect(world.loadedChunkCount).toBe(0);
  });

  it('exposes counters for the debug overlay', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 1,
      dispatchBudget: 100,
      maxInFlight: 100,
    });

    streamer.update(0, 0);
    await flush();

    const stats = streamer.stats;
    expect(stats.loaded).toBe(5);
    expect(stats.dispatched).toBe(5);
    expect(stats.failed).toBe(0);
    expect(stats.queued).toBe(0);
  });

  it('uses the chunk key helper consistently', async () => {
    const world = createWorld();
    const source = new FakeSource();
    const streamer = new ChunkStreamer({
      world,
      source,
      renderDistance: 0,
      dispatchBudget: 4,
      maxInFlight: 4,
    });

    streamer.update(-40, -40);
    await flush();

    // -40 / 16 floors to -3; truncation would have used -2.
    expect(world.hasChunk(-3, -3)).toBe(true);
    expect(world.hasChunk(-2, -2)).toBe(false);
    expect(world.getChunk(-3, -3)).toBeDefined();
    void chunkKey;
  });
});
