/**
 * SaveManager 测试（内存存储）。
 *
 * I. 为什么先用内存存储
 *
 * 1. 这里要验证的是 `SaveManager` 自身的语义：往返、只写被修改过的区块、快照覆盖、
 *    创建时间保持、列表容错、自动保存节流。它们与 IndexedDB 的实现细节无关。
 * 2. IndexedDB 的真实事务/键前缀/升级路径由 `SaveStorage.idb.test.ts` 单独覆盖；
 *    两条路径都保留，各自证明不同的东西。
 *
 * @module tests/unit/save/SaveManager.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemorySaveStorage, type StoredChunkEdits } from '@/save/SaveStorage';
import { SaveManager } from '@/save/SaveManager';
import {
  createWorldDocument,
  parseWorldSaveDocument,
  type SaveWorldInput,
} from '@/save/saveSchema';
import { AppError } from '@/utils/errors';
import { Logger } from '@/utils/logger';
import { chunkKey } from '@/world/coords';

import { V1_LEGACY_DOCUMENT, createPlayerState, createSaveInput } from './saveFixtures';

function silentLogger(): Logger {
  return new Logger({ level: 'silent' });
}

/** 记录写入次数的内存存储。 */
class RecordingStorage extends InMemorySaveStorage {
  public writes = 0;

  public override async writeWorldSnapshot(
    worldId: string,
    document: unknown,
    chunks: readonly StoredChunkEdits[],
  ): Promise<void> {
    this.writes += 1;
    return super.writeWorldSnapshot(worldId, document, chunks);
  }
}

/** 模拟"数据库不可用"的存储。 */
class UnavailableStorage extends InMemorySaveStorage {
  public override writeWorldSnapshot(): Promise<void> {
    return Promise.reject(new AppError('STORAGE_UNAVAILABLE', '模拟数据库不可用'));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SaveManager round trip', () => {
  it('persists and restores the player, settings and chunk edits', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 5000 });

    await manager.saveWorld(createSaveInput());
    const loaded = await manager.loadWorld('world-1');

    expect(loaded.worldId).toBe('world-1');
    expect(loaded.worldName).toBe('测试世界');
    expect(loaded.seed).toBe(987_654_321);
    expect(loaded.gameTime).toBe(4321);
    expect(loaded.player.position).toEqual({ x: 12.5, y: 68, z: -30.25 });
    expect(loaded.player.rotation).toEqual({ yaw: 1.25, pitch: -0.4 });
    expect(loaded.player.health).toBe(18);
    expect(loaded.player.inventory.selected).toBe(3);
    expect(loaded.player.inventory.slots[0]).toEqual({ item: 1, count: 32 });
    expect(loaded.settings.fov).toBe(90);
    expect(loaded.settings.masterVolume).toBeCloseTo(0.4, 6);
    expect(loaded.createdAt).toBe(5000);
  });

  it('restores chunk coordinates and edits exactly', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    const input = createSaveInput({
      chunks: [
        {
          cx: -3,
          cz: 5,
          edits: [
            { index: 0, id: 1 },
            { index: 1234, id: 9 },
          ],
        },
      ],
    });

    await manager.saveWorld(input);
    const loaded = await manager.loadWorld('world-1');

    expect(loaded.chunks).toHaveLength(1);
    expect(loaded.chunks[0]?.cx).toBe(-3);
    expect(loaded.chunks[0]?.cz).toBe(5);
    expect(loaded.chunks[0]?.chunkKey).toBe(chunkKey(-3, 5));
    expect(loaded.chunks[0]?.edits).toEqual([
      { index: 0, id: 1 },
      { index: 1234, id: 9 },
    ]);
  });

  it('keeps the original creation time across re-saves', async () => {
    const storage = new InMemorySaveStorage();
    let clock = 1000;
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => clock });

    await manager.saveWorld(createSaveInput());
    clock = 99_000;
    const summary = await manager.saveWorld(createSaveInput({ gameTime: 9999 }));

    expect(summary.createdAt).toBe(1000);
    expect(summary.updatedAt).toBe(99_000);
    expect((await manager.loadWorld('world-1')).gameTime).toBe(9999);
  });

  it('does not depend on chunk edits being identity-stable between calls', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    const input = createSaveInput();

    await manager.saveWorld(input);
    // 调用方复用同一份 edits 数组时，存储层不应持有它的引用。
    await manager.saveWorld(input);
    const loaded = await manager.loadWorld('world-1');

    expect(loaded.chunks[0]?.edits).toEqual([
      { index: 4, id: 9 },
      { index: 20, id: 1 },
    ]);
  });
});

describe('SaveManager chunk pruning', () => {
  it('only stores chunks that were actually modified', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    const input = createSaveInput({
      chunks: [
        { cx: 0, cz: 0, edits: [{ index: 1, id: 1 }] },
        { cx: 1, cz: 0, edits: [] },
        { cx: 2, cz: 0, edits: [{ index: 2, id: 2 }] },
      ],
    });

    await manager.saveWorld(input);

    const stored = await storage.readChunkEdits('world-1');
    expect(stored).toHaveLength(2);
    expect(stored.map((chunk) => chunk.chunkKey).sort((a, b) => a - b)).toEqual(
      [chunkKey(0, 0), chunkKey(2, 0)].sort((a, b) => a - b),
    );
  });

  it('treats each save as a snapshot and drops stale chunk records', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });

    await manager.saveWorld(
      createSaveInput({
        chunks: [
          { cx: 0, cz: 0, edits: [{ index: 1, id: 1 }] },
          { cx: 4, cz: 4, edits: [{ index: 2, id: 2 }] },
        ],
      }),
    );
    await manager.saveWorld(
      createSaveInput({ chunks: [{ cx: 0, cz: 0, edits: [{ index: 1, id: 9 }] }] }),
    );

    const stored = await storage.readChunkEdits('world-1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.chunkKey).toBe(chunkKey(0, 0));
  });

  it('collapses duplicate chunk entries and duplicate edit indices', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });

    await manager.saveWorld(
      createSaveInput({
        chunks: [
          { cx: 0, cz: 0, edits: [{ index: 1, id: 1 }] },
          { cx: 0, cz: 0, edits: [{ index: 1, id: 9 }] },
        ],
      }),
    );

    const loaded = await manager.loadWorld('world-1');
    expect(loaded.chunks).toHaveLength(1);
    expect(loaded.chunks[0]?.edits).toEqual([{ index: 1, id: 9 }]);
  });

  it('rejects chunk edits with an out-of-range index', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });

    await expect(
      manager.saveWorld(
        createSaveInput({ chunks: [{ cx: 0, cz: 0, edits: [{ index: -1, id: 1 }] }] }),
      ),
    ).rejects.toMatchObject({ code: 'SAVE_CORRUPTED' });
  });
});

describe('SaveManager migrations and legacy data', () => {
  it('merges chunk edits embedded in a v1 document', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    await storage.writeWorldSnapshot('legacy-world', V1_LEGACY_DOCUMENT, []);

    const loaded = await manager.loadWorld('legacy-world');

    expect(loaded.worldName).toBe('遗留世界');
    expect(loaded.chunks).toHaveLength(2);
    const byKey = new Map(loaded.chunks.map((chunk) => [chunk.chunkKey, chunk]));
    expect(byKey.get(chunkKey(0, 0))?.edits).toEqual([{ index: 4, id: 9 }]);
    expect(byKey.get(chunkKey(-1, 2))?.edits).toEqual([{ index: 16, id: 3 }]);
    expect(loaded.player.health).toBe(17);
  });

  it('prefers separate chunk records over legacy embedded data', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    await storage.writeWorldSnapshot('legacy-world', V1_LEGACY_DOCUMENT, [
      { chunkKey: chunkKey(0, 0), edits: [{ index: 4, id: 20 }] },
    ]);

    const loaded = await manager.loadWorld('legacy-world');

    const byKey = new Map(loaded.chunks.map((chunk) => [chunk.chunkKey, chunk]));
    expect(byKey.get(chunkKey(0, 0))?.edits).toEqual([{ index: 4, id: 20 }]);
  });

  it('refuses to load a world created by a newer schema version', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    const document = createWorldDocument(createSaveInput(), 0);
    await storage.writeWorldSnapshot('world-1', { ...document, schemaVersion: 99 }, []);

    await expect(manager.loadWorld('world-1')).rejects.toMatchObject({
      code: 'SAVE_VERSION_UNSUPPORTED',
    });
  });
});

describe('SaveManager corrupt data handling', () => {
  it('reports SAVE_CORRUPTED for a missing world', async () => {
    const manager = new SaveManager({ storage: new InMemorySaveStorage(), logger: silentLogger() });

    await expect(manager.loadWorld('nope')).rejects.toMatchObject({ code: 'SAVE_CORRUPTED' });
  });

  it('reports SAVE_CORRUPTED when a chunk payload is not an edits array', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    await manager.saveWorld(createSaveInput());
    await storage.writeWorldSnapshot(
      'world-1',
      parseWorldSaveDocument(createWorldDocument(createSaveInput(), 0)),
      [{ chunkKey: chunkKey(0, 0), edits: '被外力破坏的数据' }],
    );

    await expect(manager.loadWorld('world-1')).rejects.toMatchObject({ code: 'SAVE_CORRUPTED' });
  });

  it('skips broken worlds when listing instead of failing the whole list', async () => {
    const storage = new InMemorySaveStorage();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new SaveManager({
      storage,
      logger: new Logger({ level: 'warn' }),
      now: () => 0,
    });

    await manager.saveWorld(createSaveInput({ id: 'good', name: '好的世界' }));
    await storage.writeWorldSnapshot('bad', { id: 'bad', schemaVersion: 2, name: '坏世界' }, []);

    const worlds = await manager.listWorlds();

    expect(worlds.map((world) => world.id)).toEqual(['good']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sorts worlds by most recently updated', async () => {
    const storage = new InMemorySaveStorage();
    let clock = 100;
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => clock });

    await manager.saveWorld(createSaveInput({ id: 'older' }));
    clock = 900;
    await manager.saveWorld(createSaveInput({ id: 'newer' }));

    const worlds = await manager.listWorlds();
    expect(worlds.map((world) => world.id)).toEqual(['newer', 'older']);
  });
});

describe('SaveManager delete', () => {
  it('removes the world document and all of its chunk records', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    await manager.saveWorld(createSaveInput());
    expect(await manager.hasWorld('world-1')).toBe(true);

    await manager.deleteWorld('world-1');

    expect(await manager.hasWorld('world-1')).toBe(false);
    expect(await storage.readChunkEdits('world-1')).toEqual([]);
    await expect(manager.loadWorld('world-1')).rejects.toMatchObject({ code: 'SAVE_CORRUPTED' });
  });

  it('does not touch other worlds', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    await manager.saveWorld(createSaveInput({ id: 'keep' }));
    await manager.saveWorld(createSaveInput({ id: 'drop' }));

    await manager.deleteWorld('drop');

    expect((await manager.listWorlds()).map((world) => world.id)).toEqual(['keep']);
  });
});

describe('SaveManager storage availability', () => {
  it('surfaces STORAGE_UNAVAILABLE instead of crashing when IndexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const manager = new SaveManager({ logger: silentLogger() });

    await expect(manager.saveWorld(createSaveInput())).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await expect(manager.listWorlds()).rejects.toBeInstanceOf(AppError);
    manager.dispose();
  });
});

describe('SaveManager autosave throttle', () => {
  it('triggers a save after the configured number of block changes', async () => {
    const storage = new RecordingStorage();
    const manager = new SaveManager({
      storage,
      logger: silentLogger(),
      now: () => 0,
      autosave: { changeThreshold: 10 },
    });
    manager.startAutosave(() => createSaveInput());

    expect(manager.noteChunkModified(9)).toBe(false);
    expect(manager.isDirty).toBe(true);
    expect(manager.noteChunkModified(1)).toBe(true);

    await vi.waitFor(() => {
      expect(storage.writes).toBe(1);
    });
    manager.dispose();
  });

  it('does not save when nothing changed', async () => {
    const storage = new RecordingStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    manager.startAutosave(() => createSaveInput());

    await expect(manager.autosaveNow()).resolves.toBe(false);
    expect(storage.writes).toBe(0);
    manager.dispose();
  });

  it('saves on the interval timer once the interval has elapsed', async () => {
    vi.useFakeTimers();
    const storage = new RecordingStorage();
    let clock = 0;
    const manager = new SaveManager({
      storage,
      logger: silentLogger(),
      now: () => clock,
      autosave: { intervalMs: 20_000, changeThreshold: 1000 },
    });
    manager.startAutosave(() => createSaveInput());
    manager.noteChunkModified(1);

    // 定时器每 20 秒检查一次；第一次检查时注入时钟只走了 19 秒，因此不保存。
    clock = 19_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(storage.writes).toBe(0);

    // 第二次检查时时钟已经超过一个完整间隔。
    clock = 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(storage.writes).toBe(1);

    // 保存后脏标记被清空：下一次检查（时钟只比上次保存晚 19 秒）不再写入。
    clock = 39_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(storage.writes).toBe(1);
    manager.dispose();
  });

  it('autosaveNow ignores the interval but respects dirtiness', async () => {
    const storage = new RecordingStorage();
    const manager = new SaveManager({
      storage,
      logger: silentLogger(),
      now: () => 0,
      autosave: { intervalMs: 60_000 },
    });
    manager.startAutosave(() => createSaveInput());
    manager.noteChunkModified(1);

    await expect(manager.autosaveNow()).resolves.toBe(true);
    expect(storage.writes).toBe(1);
    await expect(manager.autosaveNow()).resolves.toBe(false);
    manager.dispose();
  });

  it('keeps the dirty flag when a save fails, so it retries later', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new SaveManager({
      storage: new UnavailableStorage(),
      logger: new Logger({ level: 'warn' }),
      now: () => 0,
    });
    manager.startAutosave(() => createSaveInput());
    manager.noteChunkModified(1);

    await expect(manager.autosaveNow()).resolves.toBe(false);
    expect(manager.isDirty).toBe(true);
    expect(warn).toHaveBeenCalled();
    manager.dispose();
    warn.mockRestore();
  });

  it('does not autosave while the provider has nothing to save', async () => {
    const storage = new RecordingStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    manager.startAutosave(() => null);
    manager.noteChunkModified(5);

    await expect(manager.autosaveNow()).resolves.toBe(false);
    expect(storage.writes).toBe(0);
    manager.dispose();
  });

  it('stops the timer on stopAutosave and dispose', async () => {
    vi.useFakeTimers();
    const storage = new RecordingStorage();
    let clock = 0;
    const manager = new SaveManager({
      storage,
      logger: silentLogger(),
      now: () => clock,
      autosave: { intervalMs: 1000 },
    });
    manager.startAutosave(() => createSaveInput());
    expect(manager.isAutosaveRunning).toBe(true);

    manager.stopAutosave();
    expect(manager.isAutosaveRunning).toBe(false);

    manager.startAutosave(() => createSaveInput());
    manager.noteChunkModified(1);
    manager.dispose();
    clock = 10_000;
    await vi.advanceTimersByTimeAsync(5000);
    expect(storage.writes).toBe(0);
    expect(manager.noteChunkModified(1)).toBe(false);
  });

  it('flushes a save through the same validation path as saveWorld', async () => {
    const storage = new RecordingStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    const invalid: SaveWorldInput = createSaveInput({ id: '' });
    manager.startAutosave(() => invalid);
    manager.noteChunkModified(1);

    await expect(manager.autosaveNow()).resolves.toBe(false);
    expect(storage.writes).toBe(0);
    manager.dispose();
  });

  it('never throws from noteChunkModified when the storage is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new SaveManager({
      storage: new UnavailableStorage(),
      logger: new Logger({ level: 'warn' }),
      now: () => 0,
      autosave: { changeThreshold: 1 },
    });
    manager.startAutosave(() => createSaveInput());

    expect(() => manager.noteChunkModified(1)).not.toThrow();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    manager.dispose();
    warn.mockRestore();
  });
});

describe('SaveManager settings and player fidelity', () => {
  it('round-trips a full inventory snapshot including empty slots', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    const player = createPlayerState();
    await manager.saveWorld(createSaveInput({ player }));

    const loaded = await manager.loadWorld('world-1');

    expect(loaded.player.inventory).toEqual(player.inventory);
  });

  it('re-normalises persisted settings through normalizeSettings', async () => {
    const storage = new InMemorySaveStorage();
    const manager = new SaveManager({ storage, logger: silentLogger(), now: () => 0 });
    await manager.saveWorld(
      createSaveInput({
        // 故意给出越界值：写入路径必须钳制，读回时也必须是同一个值。
        settings: { ...createSaveInput().settings, fov: 1000, masterVolume: -1 },
      }),
    );

    const loaded = await manager.loadWorld('world-1');

    expect(loaded.settings.fov).toBe(110);
    expect(loaded.settings.masterVolume).toBe(0);
  });
});
