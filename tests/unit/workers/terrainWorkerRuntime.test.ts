import { describe, expect, it } from 'vitest';

import type { WorkerRequest, WorkerResponse } from '@/workers/protocol';
import {
  generateChunkBlocks,
  installTerrainWorker,
  type WorkerScope,
} from '@/workers/terrainWorkerRuntime';
import { BlockId } from '@/world/BlockRegistry';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_VOLUME, indexInChunk } from '@/world/coords';

import { FakeTerrainGenerator } from '../../support/fakeTerrain';

/** Records everything a worker would post back. */
class RecordingScope implements WorkerScope {
  public readonly messages: WorkerResponse[] = [];
  public readonly transfers: (Transferable[] | undefined)[] = [];
  public listener: ((event: { readonly data: WorkerRequest }) => void) | null = null;

  public postMessage(message: WorkerResponse, transfer?: Transferable[]): void {
    this.messages.push(message);
    this.transfers.push(transfer);
  }

  public addEventListener(
    _type: 'message',
    listener: (event: { readonly data: WorkerRequest }) => void,
  ): void {
    this.listener = listener;
  }

  public send(data: WorkerRequest): void {
    if (this.listener === null) {
      throw new Error('installTerrainWorker did not register a listener');
    }
    this.listener({ data });
  }
}

describe('generateChunkBlocks', () => {
  it('fills a buffer of exactly one chunk', () => {
    const blocks = generateChunkBlocks(new FakeTerrainGenerator(3), 0, 0);

    expect(blocks).toBeInstanceOf(Uint8Array);
    expect(blocks.length).toBe(CHUNK_VOLUME);
    expect(blocks[indexInChunk(0, 0, 0)]).toBe(BlockId.Bedrock);
    expect(blocks[indexInChunk(0, 8, 0)]).toBe(BlockId.Grass);
  });

  it('produces different data for different chunks', () => {
    const generator = new FakeTerrainGenerator(3);
    const first = generateChunkBlocks(generator, 0, 0);
    const second = generateChunkBlocks(generator, 1, 0);

    expect(Array.from(first)).not.toEqual(Array.from(second));
  });

  it('clips writes outside the chunk instead of wrapping around', () => {
    // Writing past the end of a typed array is silently ignored in JavaScript, so
    // a decoration feature writing at lx = -1 would otherwise land at the end of
    // the array and corrupt a completely unrelated block.
    const blocks = generateChunkBlocks(new FakeTerrainGenerator(3), 0, 0);

    const surfaceY = 8;
    expect(blocks[indexInChunk(CHUNK_SIZE_X - 1, surfaceY + 2, 0)]).not.toBe(BlockId.Lamp);
    expect(blocks[blocks.length - 1]).not.toBe(BlockId.Lamp);
    void CHUNK_SIZE_Y;
  });
});

describe('installTerrainWorker', () => {
  it('answers a generation request with a transferable buffer', () => {
    const scope = new RecordingScope();
    installTerrainWorker(scope, (seed) => new FakeTerrainGenerator(seed));

    scope.send({ type: 'init', seed: 42 });
    expect(scope.messages[0]).toEqual({ type: 'ready' });

    scope.send({ type: 'generate-chunk', requestId: 7, cx: 2, cz: -3 });

    const response = scope.messages[1];
    expect(response?.type).toBe('chunk-generated');
    if (response?.type !== 'chunk-generated') {
      throw new Error('expected a generated chunk');
    }
    expect(response.requestId).toBe(7);
    expect(response.cx).toBe(2);
    expect(response.cz).toBe(-3);
    expect(response.blocks.length).toBe(CHUNK_VOLUME);

    // The buffer must be transferred, not cloned: a chunk is 32 KB and cloning it
    // per request is exactly the cost this design removes.
    expect(scope.transfers[1]).toEqual([response.blocks.buffer]);
  });

  it('refuses generation before init', () => {
    const scope = new RecordingScope();
    installTerrainWorker(scope, (seed) => new FakeTerrainGenerator(seed));

    scope.send({ type: 'generate-chunk', requestId: 1, cx: 0, cz: 0 });

    expect(scope.messages[0]).toMatchObject({ type: 'chunk-failed', requestId: 1 });
  });

  it('reports a factory failure with the unusable-worker sentinel', () => {
    const scope = new RecordingScope();
    installTerrainWorker(scope, () => {
      throw new Error('seed rejected');
    });

    scope.send({ type: 'init', seed: -1 });

    // A worker that cannot build its generator must say so, otherwise the pool
    // would queue requests against it forever.
    expect(scope.messages[0]).toMatchObject({
      type: 'chunk-failed',
      requestId: 0,
      message: 'seed rejected',
    });

    // And it must stay unusable rather than accepting work it cannot do.
    scope.send({ type: 'generate-chunk', requestId: 5, cx: 0, cz: 0 });
    expect(scope.messages[1]).toMatchObject({ type: 'chunk-failed', requestId: 5 });
  });

  it('reports a failure raised while generating a chunk', () => {
    const scope = new RecordingScope();
    installTerrainWorker(scope, (seed) => {
      const base = new FakeTerrainGenerator(seed);
      return {
        seed: base.seed,
        options: base.options,
        surfaceHeightAt: (x: number, z: number): number => base.surfaceHeightAt(x, z),
        biomeAt: (x: number, z: number) => base.biomeAt(x, z),
        generate: (): void => {
          throw new Error('noise exploded');
        },
      };
    });

    scope.send({ type: 'init', seed: 1 });
    scope.send({ type: 'generate-chunk', requestId: 3, cx: 0, cz: 0 });

    expect(scope.messages[1]).toMatchObject({
      type: 'chunk-failed',
      requestId: 3,
      message: 'noise exploded',
    });
  });
});
