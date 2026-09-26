/**
 * Worker message protocol.
 *
 * I. Why the protocol is a separate module
 *
 * Both sides of the boundary — the pool on the main thread and the worker entry
 * — need the same message shapes. Declaring them once means a renamed field is a
 * compile error on both sides instead of a silent `undefined` that only shows up
 * as a chunk full of air.
 *
 * II. Why blocks travel as a transferable `Uint8Array`
 *
 * A chunk is 32,768 bytes. Posting it as part of a structured-clone message
 * would copy the buffer; listing it in the transfer list moves ownership for
 * free. The worker therefore allocates a fresh buffer per request and never
 * reuses it after posting.
 *
 * @module workers/protocol
 */

import type { TerrainOptions } from '@/terrain/types';

/** Initialises a worker with the world seed. Sent once per worker. */
export interface InitRequest {
  readonly type: 'init';
  readonly seed: number;
  readonly options?: TerrainOptions;
}

/** Asks the worker to generate one chunk. */
export interface GenerateChunkRequest {
  readonly type: 'generate-chunk';
  /** Monotonic id used to match the response; the pool may have several in flight. */
  readonly requestId: number;
  readonly cx: number;
  readonly cz: number;
}

/** Every message the main thread may send. */
export type WorkerRequest = InitRequest | GenerateChunkRequest;

/** Confirms that the worker is ready to accept generation requests. */
export interface InitResponse {
  readonly type: 'ready';
}

/** Successful chunk generation. */
export interface GeneratedChunkResponse {
  readonly type: 'chunk-generated';
  readonly requestId: number;
  readonly cx: number;
  readonly cz: number;
  /** Flat block array of `CHUNK_VOLUME` bytes, transferred. */
  readonly blocks: Uint8Array;
}

/** Generation failed; the pool falls back to the synchronous path. */
export interface ChunkFailedResponse {
  readonly type: 'chunk-failed';
  readonly requestId: number;
  readonly cx: number;
  readonly cz: number;
  readonly message: string;
}

/** Every message a worker may send back. */
export type WorkerResponse = InitResponse | GeneratedChunkResponse | ChunkFailedResponse;

/** Buffers that should be transferred rather than copied. */
export function transferablesFor(response: WorkerResponse): Transferable[] {
  return response.type === 'chunk-generated' ? [response.blocks.buffer as ArrayBuffer] : [];
}
