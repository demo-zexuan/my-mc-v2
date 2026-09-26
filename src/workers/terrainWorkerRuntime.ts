/**
 * Terrain worker logic, independent of the worker API.
 *
 * I. Why the handler is not written directly in the worker entry
 *
 * A module worker entry runs in a scope that jsdom cannot provide, so any logic
 * placed there is effectively untestable. Splitting the message handling into a
 * plain function that takes a minimal `scope` facade means the whole protocol —
 * init, generation, error reporting, buffer transfer — can be unit tested in
 * Node with a stub scope.
 *
 * II. Buffer reuse
 *
 * Each request allocates exactly one buffer and hands ownership to the main
 * thread. Reusing a scratch buffer would require copying it back, which is the
 * cost this design exists to avoid.
 *
 * @module workers/terrainWorkerRuntime
 */

import type { TerrainGenerator, TerrainGeneratorFactory } from '@/terrain/types';
import {
  CHUNK_SIZE_X,
  CHUNK_SIZE_Y,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  indexInChunk,
} from '@/world/coords';

import type { WorkerRequest, WorkerResponse } from './protocol';
import { transferablesFor } from './protocol';

/** Minimal view of a `DedicatedWorkerGlobalScope`. */
export interface WorkerScope {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: WorkerRequest }) => void,
  ): void;
}

/**
 * Wires the terrain protocol onto a worker scope.
 *
 * @param scope - Worker global scope (or a stub in tests).
 * @param createGenerator - Factory creating the deterministic generator.
 */
export function installTerrainWorker(
  scope: WorkerScope,
  createGenerator: TerrainGeneratorFactory,
): void {
  let generator: TerrainGenerator | null = null;

  scope.addEventListener('message', (event) => {
    const request = event.data;

    if (request.type === 'init') {
      // A worker is initialised exactly once; re-initialising would discard the
      // generator the pool already relies on.
      try {
        generator = createGenerator(request.seed, request.options);
        scope.postMessage({ type: 'ready' });
      } catch (error) {
        // A generator that cannot be built is a programming error, but it must
        // not leave the pool waiting forever. Request id 0 is a sentinel the pool
        // never issues, which it reads as "this worker is unusable".
        generator = null;
        scope.postMessage({
          type: 'chunk-failed',
          requestId: 0,
          cx: 0,
          cz: 0,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (generator === null) {
      scope.postMessage({
        type: 'chunk-failed',
        requestId: request.requestId,
        cx: request.cx,
        cz: request.cz,
        message: 'Worker received a generation request before init.',
      });
      return;
    }

    try {
      const blocks = generateChunkBlocks(generator, request.cx, request.cz);
      const response: WorkerResponse = {
        type: 'chunk-generated',
        requestId: request.requestId,
        cx: request.cx,
        cz: request.cz,
        blocks,
      };
      scope.postMessage(response, transferablesFor(response));
    } catch (error) {
      scope.postMessage({
        type: 'chunk-failed',
        requestId: request.requestId,
        cx: request.cx,
        cz: request.cz,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * Generates one chunk into a fresh buffer.
 *
 * Exported so the synchronous fallback path in `WorkerPool` can reuse exactly the
 * same code, which guarantees the two paths cannot diverge.
 *
 * @param generator - Deterministic terrain source.
 * @param cx - Chunk X.
 * @param cz - Chunk Z.
 * @returns Flat block array of `CHUNK_VOLUME` bytes.
 */
export function generateChunkBlocks(
  generator: TerrainGenerator,
  cx: number,
  cz: number,
): Uint8Array {
  const blocks = new Uint8Array(CHUNK_VOLUME);
  generator.generate(cx, cz, {
    setBlock: (lx, y, lz, id): void => {
      // Bounds are re-checked here as well as in the generator: a decoration
      // feature writing one block outside the chunk must be clipped, and
      // silently writing past the end of a typed array would wrap around in
      // JavaScript instead of throwing.
      if (
        lx < 0 ||
        lx >= CHUNK_SIZE_X ||
        lz < 0 ||
        lz >= CHUNK_SIZE_Z ||
        y < 0 ||
        y >= CHUNK_SIZE_Y
      ) {
        return;
      }
      blocks[indexInChunk(lx, y, lz)] = id;
    },
  });
  return blocks;
}
