/**
 * Chunk generation pool.
 *
 * I. Why a pool instead of one worker or the main thread
 *
 * Terrain generation costs roughly a few milliseconds per chunk and the streaming
 * layer requests dozens of chunks whenever the player crosses a boundary. On the
 * main thread that is a visible hitch every time the player walks; a single
 * worker serialises the burst and stalls behind the queue. A small pool spread
 * over the available cores keeps the frame time flat, and the pool size is capped
 * because each worker holds its own copy of the generator's noise permutation
 * tables.
 *
 * II. Why there is a synchronous fallback
 *
 * `Worker` is unavailable in a few real environments: hardened browsers that
 * block module workers, and any context where the CSP forbids `blob:` or
 * `worker-src`. A voxel game that cannot start at all is worse than one that
 * hitches, so the pool detects the failure, logs it once, and serves requests
 * from the main thread using exactly the same generation code.
 *
 * @module workers/WorkerPool
 */

import type { TerrainGenerator, TerrainGeneratorFactory, TerrainOptions } from '@/terrain/types';

import { logger } from '@/utils/logger';

import type { WorkerResponse } from './protocol';
import { generateChunkBlocks } from './terrainWorkerRuntime';

const log = logger.child('workers');

/** Request shape the pool accepts from the streaming layer. */
export interface ChunkRequest {
  readonly cx: number;
  readonly cz: number;
}

/** Source of generated chunk data. */
export interface ChunkGenerationSource {
  /**
   * Requests one chunk.
   *
   * @param request - Chunk coordinates.
   * @returns The flat block array, or `null` when generation failed.
   */
  request(request: ChunkRequest): Promise<Uint8Array | null>;
  /** Number of requests currently in flight. */
  readonly inFlight: number;
  /** Releases every worker. */
  dispose(): void;
}

export interface WorkerPoolOptions {
  /** World seed forwarded to every worker. */
  readonly seed: number;
  /** Terrain options forwarded to every worker. */
  readonly options?: TerrainOptions;
  /** Factory used both by the workers and by the synchronous fallback. */
  readonly generatorFactory: TerrainGeneratorFactory;
  /** Creates the worker instance; injected so tests can substitute a stub. */
  readonly createWorker?: () => Worker;
  /** Upper bound on workers. Defaults to `min(4, hardwareConcurrency - 1)`. */
  readonly maxWorkers?: number;
}

interface PendingRequest {
  readonly requestId: number;
  readonly cx: number;
  readonly cz: number;
  readonly resolve: (blocks: Uint8Array | null) => void;
  readonly reject: (error: unknown) => void;
}

interface PoolSlot {
  readonly worker: Worker | null;
  readonly pending: Map<number, PendingRequest>;
  /** Set when the worker can no longer answer; it is skipped when dispatching. */
  dead: boolean;
}

/**
 * Default worker factory.
 *
 * Vite rewrites the `new URL(..., import.meta.url)` form at build time, which is
 * why the worker entry is referenced this way rather than by a string path.
 */
function defaultCreateWorker(): Worker {
  return new Worker(new URL('./terrainWorker.ts', import.meta.url), {
    type: 'module',
    name: 'terrain-generator',
  });
}

export class WorkerPool implements ChunkGenerationSource {
  readonly #slots: PoolSlot[] = [];
  readonly #queue: PendingRequest[] = [];
  readonly #generatorFactory: TerrainGeneratorFactory;
  readonly #seed: number;
  readonly #options: TerrainOptions | undefined;
  #nextRequestId = 1;
  #disposed = false;
  #workersUnavailable = false;

  public constructor(options: WorkerPoolOptions) {
    this.#seed = options.seed;
    this.#options = options.options;
    this.#generatorFactory = options.generatorFactory;

    const target = options.maxWorkers ?? defaultWorkerCount();

    // I. Try to start workers.
    // 1. A failure to construct any worker degrades the whole pool; partial
    //    degradation would be more surprising than falling back entirely.
    if (typeof Worker !== 'undefined') {
      const create = options.createWorker ?? defaultCreateWorker;
      try {
        for (let index = 0; index < target; index += 1) {
          const worker = create();
          worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
            this.#handleResponse(index, event.data);
          });
          worker.addEventListener('error', (event) => {
            log.warn(`worker ${index} reported an error`, event.message);
            // A crashed worker never answers, and a request that never settles
            // would stall the streaming queue permanently. Draining it here turns
            // a hard failure into a retryable one.
            this.#drainSlot(index);
          });
          worker.postMessage({ type: 'init', seed: this.#seed, options: this.#options });
          this.#slots.push({ worker, pending: new Map(), dead: false });
        }
      } catch (error) {
        log.warn('module workers unavailable, falling back to main-thread generation', error);
        this.#workersUnavailable = true;
        this.#slots.length = 0;
      }
    } else {
      this.#workersUnavailable = true;
    }

    if (this.#workersUnavailable) {
      // The fallback slot has no worker; `#pumpFallback` drives it.
      this.#slots.push({ worker: null, pending: new Map(), dead: false });
    }
  }

  public get inFlight(): number {
    let total = 0;
    for (const slot of this.#slots) {
      total += slot.pending.size;
    }
    return total;
  }

  /** Number of workers actually started. */
  public get workerCount(): number {
    return this.#workersUnavailable ? 0 : this.#slots.length;
  }

  /** True when generation runs on the main thread. */
  public get usingFallback(): boolean {
    return this.#workersUnavailable;
  }

  /** Number of queued requests not yet dispatched to a worker. */
  public get queuedCount(): number {
    return this.#queue.length;
  }

  public request({ cx, cz }: ChunkRequest): Promise<Uint8Array | null> {
    if (this.#disposed) {
      return Promise.resolve(null);
    }

    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;

    return new Promise<Uint8Array | null>((resolve, reject) => {
      this.#queue.push({ requestId, cx, cz, resolve, reject });
      this.#dispatch();
    });
  }

  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    // Pending callers must not be left hanging; a resolved `null` lets the
    // streaming layer drop the request quietly during teardown.
    const pending = [...this.#queue];
    this.#queue.length = 0;
    for (const request of pending) {
      request.resolve(null);
    }

    for (const slot of this.#slots) {
      for (const request of slot.pending.values()) {
        request.resolve(null);
      }
      slot.pending.clear();
      slot.worker?.terminate();
    }
    this.#slots.length = 0;
  }

  #dispatch(): void {
    if (this.#disposed || this.#queue.length === 0) {
      return;
    }

    if (this.#workersUnavailable) {
      this.#pumpFallback();
      return;
    }

    // I. Hand each queued request to the least loaded worker.
    // 1. Round-robin would be simpler but would stall behind a slow request while
    //    another worker idles.
    while (this.#queue.length > 0) {
      const slot = this.#leastLoadedSlot();
      if (slot === null) {
        return;
      }
      const request = this.#queue.shift();
      if (request === undefined) {
        return;
      }
      slot.pending.set(request.requestId, request);
      slot.worker?.postMessage({
        type: 'generate-chunk',
        requestId: request.requestId,
        cx: request.cx,
        cz: request.cz,
      });
    }
  }

  #leastLoadedSlot(): PoolSlot | null {
    let best: PoolSlot | null = null;
    for (const slot of this.#slots) {
      if (slot.worker === null || slot.dead) {
        continue;
      }
      if (best === null || slot.pending.size < best.pending.size) {
        best = slot;
      }
    }
    return best;
  }

  #pumpFallback(): void {
    const slot = this.#slots[0];
    if (slot === undefined) {
      return;
    }

    while (this.#queue.length > 0) {
      const request = this.#queue.shift();
      if (request === undefined) {
        break;
      }
      try {
        const generator = this.#getFallbackGenerator();
        const blocks = generateChunkBlocks(generator, request.cx, request.cz);
        request.resolve(blocks);
      } catch (error) {
        log.error(`synchronous generation failed for chunk (${request.cx},${request.cz})`, error);
        request.resolve(null);
      }
    }
  }

  /**
   * Generator used by the synchronous fallback path.
   *
   * Created lazily because the permutation tables are not free, and a pool that
   * starts workers never needs it.
   */
  #fallbackGeneratorInstance: TerrainGenerator | null = null;

  #getFallbackGenerator(): TerrainGenerator {
    if (this.#fallbackGeneratorInstance === null) {
      this.#fallbackGeneratorInstance = this.#generatorFactory(this.#seed, this.#options);
    }
    return this.#fallbackGeneratorInstance;
  }

  /**
   * Fails every request owned by a worker that can no longer answer.
   *
   * @param slotIndex - Index of the affected slot.
   */
  #drainSlot(slotIndex: number): void {
    const slot = this.#slots[slotIndex];
    if (slot === undefined) {
      return;
    }
    for (const request of slot.pending.values()) {
      request.resolve(null);
    }
    slot.pending.clear();
    slot.dead = true;
    // Anything still queued can go to the remaining healthy workers.
    this.#dispatch();
  }

  #handleResponse(slotIndex: number, response: WorkerResponse): void {
    if (response.type === 'ready') {
      return;
    }

    const slot = this.#slots[slotIndex];
    if (slot === undefined) {
      return;
    }
    const request = slot.pending.get(response.requestId);
    if (request === undefined) {
      // The sentinel id 0 (or an id from a disposed request) means the worker is
      // unusable rather than that a single chunk failed.
      const detail = response.type === 'chunk-failed' ? response.message : 'unexpected response';
      log.warn(`worker ${slotIndex} is unusable: ${detail}`);
      this.#drainSlot(slotIndex);
      return;
    }
    slot.pending.delete(response.requestId);

    if (response.type === 'chunk-generated') {
      request.resolve(response.blocks);
    } else {
      log.warn(`chunk (${response.cx},${response.cz}) failed: ${response.message}`);
      request.resolve(null);
    }

    // A finished request frees a slot, so anything queued behind it can go now.
    this.#dispatch();
  }
}

/**
 * Chooses a sensible worker count.
 *
 * One core is left for the main thread: the renderer, the input handling and the
 * mesh uploads all run there, and starving them costs more than the extra chunk
 * throughput buys.
 *
 * @returns Worker count in `1 .. 4`.
 */
export function defaultWorkerCount(): number {
  if (typeof navigator === 'undefined') {
    return 1;
  }
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, cores - 1));
}
