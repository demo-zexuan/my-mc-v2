import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerResponse } from '@/workers/protocol';
import { WorkerPool, defaultWorkerCount } from '@/workers/WorkerPool';
import { type TerrainGeneratorFactory } from '@/terrain/types';
import { BlockId } from '@/world/BlockRegistry';
import { CHUNK_VOLUME, indexInChunk } from '@/world/coords';

import { FakeTerrainGenerator } from '../../support/fakeTerrain';

/** Minimal stand-in for a module worker. */
class FakeWorker {
  public static readonly instances: FakeWorker[] = [];
  public readonly posted: unknown[] = [];
  public terminated = false;
  readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

  public constructor() {
    FakeWorker.instances.push(this);
  }

  public addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }

  public postMessage(message: unknown): void {
    this.posted.push(message);
  }

  public terminate(): void {
    this.terminated = true;
  }

  /** Simulates a message from the worker. */
  public respond(response: WorkerResponse): void {
    for (const listener of this.#listeners.get('message') ?? []) {
      listener({ data: response });
    }
  }

  /** Simulates a worker-level crash. */
  public fail(message: string): void {
    for (const listener of this.#listeners.get('error') ?? []) {
      listener({ message });
    }
  }

  /** The `init` message the pool sent, if any. */
  public get initMessage(): unknown {
    return this.posted[0];
  }

  /** The last `generate-chunk` request the pool sent. */
  public get lastRequest(): { requestId: number; cx: number; cz: number } | undefined {
    const requests = this.posted.filter(
      (message): message is { type: string; requestId: number; cx: number; cz: number } =>
        typeof message === 'object' && message !== null && 'requestId' in message,
    );
    return requests[requests.length - 1];
  }
}

const generatorFactory: TerrainGeneratorFactory = (seed) => new FakeTerrainGenerator(seed);

describe('WorkerPool', () => {
  beforeEach(() => {
    FakeWorker.instances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('when workers are unavailable', () => {
    it('generates on the calling thread', async () => {
      // Node has no `Worker` global, which is exactly the degraded environment
      // the fallback exists for.
      const pool = new WorkerPool({ seed: 5, generatorFactory });

      expect(pool.usingFallback).toBe(true);
      expect(pool.workerCount).toBe(0);

      const blocks = await pool.request({ cx: 0, cz: 0 });

      expect(blocks).not.toBeNull();
      expect(blocks?.length).toBe(CHUNK_VOLUME);
      expect(blocks?.[indexInChunk(0, 0, 0)]).toBe(BlockId.Bedrock);

      pool.dispose();
    });

    it('builds the fallback generator once', async () => {
      let created = 0;
      const counting: TerrainGeneratorFactory = (seed) => {
        created += 1;
        return new FakeTerrainGenerator(seed);
      };
      const pool = new WorkerPool({ seed: 5, generatorFactory: counting });

      await pool.request({ cx: 0, cz: 0 });
      await pool.request({ cx: 1, cz: 0 });

      expect(created).toBe(1);
      pool.dispose();
    });
  });

  describe('with workers', () => {
    beforeEach(() => {
      vi.stubGlobal('Worker', FakeWorker);
    });

    it('initialises every worker with the seed', () => {
      const pool = new WorkerPool({
        seed: 99,
        generatorFactory,
        createWorker: () => new FakeWorker() as unknown as Worker,
        maxWorkers: 2,
      });

      expect(pool.workerCount).toBe(2);
      expect(FakeWorker.instances).toHaveLength(2);
      expect(FakeWorker.instances[0]?.initMessage).toEqual({
        type: 'init',
        seed: 99,
        options: undefined,
      });

      pool.dispose();
    });

    it('resolves a request when the worker answers', async () => {
      const pool = new WorkerPool({
        seed: 1,
        generatorFactory,
        createWorker: () => new FakeWorker() as unknown as Worker,
        maxWorkers: 1,
      });

      const promise = pool.request({ cx: 4, cz: -2 });
      const worker = FakeWorker.instances[0];
      const request = worker?.lastRequest;
      expect(request).toMatchObject({ cx: 4, cz: -2 });
      expect(pool.inFlight).toBe(1);

      const blocks = new Uint8Array(CHUNK_VOLUME);
      blocks[indexInChunk(0, 3, 0)] = BlockId.Lamp;
      worker?.respond({
        type: 'chunk-generated',
        requestId: request?.requestId ?? 0,
        cx: 4,
        cz: -2,
        blocks,
      });

      const result = await promise;
      expect(result?.[indexInChunk(0, 3, 0)]).toBe(BlockId.Lamp);
      expect(pool.inFlight).toBe(0);

      pool.dispose();
    });

    it('resolves with null when a chunk fails', async () => {
      const pool = new WorkerPool({
        seed: 1,
        generatorFactory,
        createWorker: () => new FakeWorker() as unknown as Worker,
        maxWorkers: 1,
      });

      const promise = pool.request({ cx: 0, cz: 0 });
      const request = FakeWorker.instances[0]?.lastRequest ?? { requestId: 0, cx: 0, cz: 0 };
      FakeWorker.instances[0]?.respond({
        type: 'chunk-failed',
        requestId: request.requestId,
        cx: 0,
        cz: 0,
        message: 'out of memory',
      });

      await expect(promise).resolves.toBeNull();
      pool.dispose();
    });

    it('fails the pending work of a crashed worker instead of hanging', async () => {
      const pool = new WorkerPool({
        seed: 1,
        generatorFactory,
        createWorker: () => new FakeWorker() as unknown as Worker,
        maxWorkers: 1,
      });

      const promise = pool.request({ cx: 0, cz: 0 });
      FakeWorker.instances[0]?.fail('worker script failed to load');

      // A request that never settles would stall the streaming queue forever.
      await expect(promise).resolves.toBeNull();
      expect(pool.inFlight).toBe(0);
      pool.dispose();
    });

    it('spreads work over the least loaded worker', () => {
      const pool = new WorkerPool({
        seed: 1,
        generatorFactory,
        createWorker: () => new FakeWorker() as unknown as Worker,
        maxWorkers: 2,
      });

      void pool.request({ cx: 0, cz: 0 });
      void pool.request({ cx: 1, cz: 0 });

      // Both workers must receive one request rather than the first worker
      // receiving both and the second idling.
      const first = FakeWorker.instances[0]?.lastRequest;
      const second = FakeWorker.instances[1]?.lastRequest;
      expect(first?.cx).toBe(0);
      expect(second?.cx).toBe(1);

      pool.dispose();
    });

    it('terminates workers and settles pending requests on dispose', async () => {
      const pool = new WorkerPool({
        seed: 1,
        generatorFactory,
        createWorker: () => new FakeWorker() as unknown as Worker,
        maxWorkers: 1,
      });

      const promise = pool.request({ cx: 0, cz: 0 });
      pool.dispose();

      await expect(promise).resolves.toBeNull();
      expect(FakeWorker.instances[0]?.terminated).toBe(true);
      expect(pool.inFlight).toBe(0);
    });

    it('ignores new requests after dispose', async () => {
      const pool = new WorkerPool({
        seed: 1,
        generatorFactory,
        createWorker: () => new FakeWorker() as unknown as Worker,
        maxWorkers: 1,
      });
      pool.dispose();

      await expect(pool.request({ cx: 0, cz: 0 })).resolves.toBeNull();
    });
  });
});

describe('defaultWorkerCount', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves one core for the main thread and caps at four', () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    expect(defaultWorkerCount()).toBe(1);

    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
    expect(defaultWorkerCount()).toBe(4);

    vi.stubGlobal('navigator', { hardwareConcurrency: 16 });
    expect(defaultWorkerCount()).toBe(4);
  });

  it('assumes four cores when the browser does not say', () => {
    vi.stubGlobal('navigator', {});
    expect(defaultWorkerCount()).toBe(3);
  });
});
