/**
 * IndexedDB 存储层测试。
 *
 * I. 为什么用 fake-indexeddb 而不是内存替身
 *
 * 1. 内存替身只能证明"I/O 被调用了"；真正容易出错的是 IndexedDB 的语义：对象仓库的升级
 *    创建、跨仓库事务的提交时机、显式字符串主键与前缀过滤、连接关闭后的重开。
 * 2. `fake-indexeddb` 实现了这些语义，因此这里用真实事务路径验证；`SaveManager` 的
 *    业务语义则由内存存储那条路径覆盖。
 *
 * II. 每个用例一个数据库名
 *
 * fake-indexeddb 的数据库在同一个进程内共享，用例之间必须隔离；数据库名带自增后缀，
 * 用例结束后关闭连接。
 *
 * @module tests/unit/save/SaveStorage.idb.test
 */

import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SaveManager } from '@/save/SaveManager';
import {
  CHUNK_STORE_NAME,
  WORLD_STORE_NAME,
  chunkRecordKey,
  createIndexedDbSaveStorage,
  parseChunkRecordKey,
  type SaveStorage,
} from '@/save/SaveStorage';
import { createWorldDocument, parseWorldSaveDocument } from '@/save/saveSchema';
import { Logger } from '@/utils/logger';
import { chunkKey } from '@/world/coords';

import { createSaveInput } from './saveFixtures';

function silentLogger(): Logger {
  return new Logger({ level: 'silent' });
}

let databaseCounter = 0;
const openedStorages: SaveStorage[] = [];

/** 每个用例使用独立的数据库名，避免相互污染。 */
function createStorage(): { readonly storage: SaveStorage; readonly databaseName: string } {
  databaseCounter += 1;
  const databaseName = `my-mc-v2-test-${databaseCounter}`;
  const storage = createIndexedDbSaveStorage({ databaseName });
  openedStorages.push(storage);
  return { storage, databaseName };
}

afterEach(() => {
  for (const storage of openedStorages.splice(0)) {
    storage.close();
  }
  vi.unstubAllGlobals();
});

/** 直接打开数据库，用于检查升级结果或注入损坏数据。 */
function openDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`打开数据库 ${databaseName} 失败`));
    };
  });
}

/** 绕过存储层，把一个原始值写进 chunks 仓库。 */
async function putRawChunk(databaseName: string, key: string, value: unknown): Promise<void> {
  const db = await openDatabase(databaseName);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE_NAME, 'readwrite');
    tx.objectStore(CHUNK_STORE_NAME).put(value, key);
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('写入损坏数据失败'));
    };
  });
  db.close();
}

describe('chunk record keys', () => {
  it('composes and parses keys, including negative chunk coordinates', () => {
    expect(chunkRecordKey('w', 5)).toBe('w:5');
    expect(parseChunkRecordKey('w:5', 'w')).toBe(5);
    expect(parseChunkRecordKey('w:-3', 'w')).toBe(-3);
  });

  it('rejects keys from other worlds and malformed suffixes', () => {
    expect(parseChunkRecordKey('other:5', 'w')).toBeNull();
    expect(parseChunkRecordKey('w:abc', 'w')).toBeNull();
    expect(parseChunkRecordKey('w:1.5', 'w')).toBeNull();
    expect(parseChunkRecordKey('w:', 'w')).toBeNull();
  });

  it('round-trips world ids that contain a colon', () => {
    const worldId = 'ns:player-1';
    expect(parseChunkRecordKey(chunkRecordKey(worldId, 7), worldId)).toBe(7);
  });
});

describe('IndexedDbSaveStorage', () => {
  it('creates both object stores on first use', async () => {
    const { storage, databaseName } = createStorage();

    await storage.writeWorldSnapshot('w1', { id: 'w1', schemaVersion: 2 }, []);

    const db = await openDatabase(databaseName);
    expect(db.objectStoreNames.contains(WORLD_STORE_NAME)).toBe(true);
    expect(db.objectStoreNames.contains(CHUNK_STORE_NAME)).toBe(true);
    db.close();
  });

  it('round-trips world documents and chunk edits', async () => {
    const { storage } = createStorage();
    const document = createWorldDocument(createSaveInput(), 0);
    const edits = [
      { index: 1, id: 1 },
      { index: 4096, id: 20 },
    ];

    await storage.writeWorldSnapshot('world-1', document, [
      { chunkKey: chunkKey(0, 0), edits },
      { chunkKey: chunkKey(-2, 3), edits: [{ index: 5, id: 9 }] },
    ]);

    const raw = await storage.readWorldDocument('world-1');
    expect(raw).not.toBeNull();
    expect(parseWorldSaveDocument(raw).id).toBe('world-1');

    const chunks = await storage.readChunkEdits('world-1');
    expect(chunks).toHaveLength(2);
    const byKey = new Map(chunks.map((chunk) => [chunk.chunkKey, chunk.edits]));
    expect(byKey.get(chunkKey(0, 0))).toEqual(edits);
    expect(byKey.get(chunkKey(-2, 3))).toEqual([{ index: 5, id: 9 }]);

    const all = await storage.listWorldDocuments();
    expect(all).toHaveLength(1);
  });

  it('returns null for a missing world and no chunks for a missing world id', async () => {
    const { storage } = createStorage();

    expect(await storage.readWorldDocument('ghost')).toBeNull();
    expect(await storage.readChunkEdits('ghost')).toEqual([]);
    expect(await storage.listWorldDocuments()).toEqual([]);
  });

  it('replaces the previous snapshot instead of accumulating stale chunks', async () => {
    const { storage } = createStorage();
    const document = createWorldDocument(createSaveInput(), 0);

    await storage.writeWorldSnapshot('world-1', document, [
      { chunkKey: chunkKey(0, 0), edits: [{ index: 1, id: 1 }] },
      { chunkKey: chunkKey(9, 9), edits: [{ index: 1, id: 2 }] },
    ]);
    await storage.writeWorldSnapshot('world-1', document, [
      { chunkKey: chunkKey(0, 0), edits: [{ index: 1, id: 3 }] },
    ]);

    const chunks = await storage.readChunkEdits('world-1');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunkKey).toBe(chunkKey(0, 0));
    expect(chunks[0]?.edits).toEqual([{ index: 1, id: 3 }]);
  });

  it('keeps worlds isolated from each other', async () => {
    const { storage } = createStorage();
    const first = createWorldDocument(createSaveInput({ id: 'alpha' }), 0);
    const second = createWorldDocument(createSaveInput({ id: 'beta' }), 0);

    await storage.writeWorldSnapshot('alpha', first, [
      { chunkKey: chunkKey(0, 0), edits: [{ index: 1, id: 1 }] },
    ]);
    await storage.writeWorldSnapshot('beta', second, [
      { chunkKey: chunkKey(0, 0), edits: [{ index: 1, id: 2 }] },
      { chunkKey: chunkKey(0, 1), edits: [{ index: 1, id: 3 }] },
    ]);

    expect(await storage.readChunkEdits('alpha')).toHaveLength(1);
    expect(await storage.readChunkEdits('beta')).toHaveLength(2);

    await storage.deleteWorld('alpha');

    expect(await storage.readWorldDocument('alpha')).toBeNull();
    expect(await storage.readChunkEdits('alpha')).toEqual([]);
    expect(await storage.readChunkEdits('beta')).toHaveLength(2);
    expect(await storage.readWorldDocument('beta')).not.toBeNull();
  });

  it('keeps working after the connection is closed and re-opened', async () => {
    const { storage } = createStorage();
    const document = createWorldDocument(createSaveInput(), 0);
    await storage.writeWorldSnapshot('world-1', document, []);

    storage.close();
    expect(await storage.readWorldDocument('world-1')).not.toBeNull();

    storage.close();
  });

  it('reports STORAGE_UNAVAILABLE when the environment has no IndexedDB', () => {
    vi.stubGlobal('indexedDB', undefined);

    expect(() => createIndexedDbSaveStorage()).toThrowError(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    );
  });
});

describe('SaveManager over IndexedDB', () => {
  it('saves and loads a world end to end', async () => {
    const { storage } = createStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 4242 });

    await manager.saveWorld(createSaveInput());
    const loaded = await manager.loadWorld('world-1');

    expect(loaded.worldName).toBe('测试世界');
    expect(loaded.createdAt).toBe(4242);
    expect(loaded.chunks).toHaveLength(1);
    expect(loaded.chunks[0]?.edits).toEqual([
      { index: 4, id: 9 },
      { index: 20, id: 1 },
    ]);
    expect(loaded.player.inventory.slots[0]).toEqual({ item: 1, count: 32 });

    manager.dispose();
  });

  it('reports SAVE_CORRUPTED when a stored chunk payload was corrupted', async () => {
    const { storage, databaseName } = createStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    await manager.saveWorld(createSaveInput());
    await putRawChunk(databaseName, chunkRecordKey('world-1', chunkKey(0, 0)), '被外力破坏');

    await expect(manager.loadWorld('world-1')).rejects.toMatchObject({ code: 'SAVE_CORRUPTED' });
    manager.dispose();
  });

  it('lists and deletes worlds through the real store', async () => {
    const { storage } = createStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    await manager.saveWorld(createSaveInput({ id: 'keep' }));
    await manager.saveWorld(createSaveInput({ id: 'drop' }));

    expect((await manager.listWorlds()).map((world) => world.id).sort()).toEqual(['drop', 'keep']);

    await manager.deleteWorld('drop');

    expect((await manager.listWorlds()).map((world) => world.id)).toEqual(['keep']);
    manager.dispose();
  });
});
