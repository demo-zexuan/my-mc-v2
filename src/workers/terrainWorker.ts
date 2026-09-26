/**
 * Terrain generation worker entry.
 *
 * I. Responsibilities
 *
 * This file exists only to connect the worker global scope to
 * {@link installTerrainWorker}. All protocol logic lives in
 * `terrainWorkerRuntime.ts` so that it can be unit tested in Node; nothing
 * decision-making belongs here.
 *
 * II. Module workers
 *
 * The worker is declared as `type: 'module'` by the pool, which lets it import
 * the same TypeScript sources as the main bundle. Vite bundles the worker
 * separately and rewrites the URL at build time.
 *
 * @module workers/terrainWorker
 */

import { createTerrainGenerator } from '@/terrain/TerrainGenerator';

import { installTerrainWorker, type WorkerScope } from './terrainWorkerRuntime';

// The DOM lib types `self` as `Window`, which has a different `postMessage`
// signature than a worker scope. Casting through the narrow facade keeps the
// runtime honest without pulling the whole `WebWorker` lib into the app project
// (which would conflict with `DOM`).
const scope = self as unknown as WorkerScope;

installTerrainWorker(scope, createTerrainGenerator);
