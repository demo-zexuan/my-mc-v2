/**
 * 存档结构与版本迁移测试。
 *
 * I. 覆盖重点
 *
 * 1. 迁移链：v1 → 当前版本，逐字段检查升级结果（背包形状、新增默认值、内嵌区块）。
 * 2. 版本过高 → `SAVE_VERSION_UNSUPPORTED`；版本缺失/非法/过旧 → `SAVE_CORRUPTED`。
 * 3. 结构损坏：根节点不是对象、字段类型错误、区块 edits 非法。
 * 4. 规范化：背包长度、堆叠数量、生命值、选中槽位、设置钳制与默认回退。
 *
 * @module tests/unit/save/migrations.test
 */

import { describe, expect, it } from 'vitest';

import { HOTBAR_SLOTS, INVENTORY_SLOTS, MAX_STACK_SIZE } from '@/inventory/types';
import {
  FIRST_SUPPORTED_SCHEMA_VERSION,
  MAX_HEALTH,
  SAVE_SCHEMA_VERSION,
  createWorldDocument,
  migrate,
  parseChunkEdits,
  parseWorldSaveDocument,
  readWorldId,
} from '@/save/saveSchema';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '@/settings/types';
import { AppError, type AppErrorCode } from '@/utils/errors';
import { CHUNK_VOLUME } from '@/world/coords';

import { V1_LEGACY_DOCUMENT, createSaveInput } from './saveFixtures';

/** 执行一段代码并返回其抛出的 AppError 错误码；没有抛错时返回 `'NO_ERROR'`。 */
function appErrorCodeOf(run: () => unknown): AppErrorCode | 'NO_ERROR' {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }
    throw error;
  }
  return 'NO_ERROR';
}

describe('migrate', () => {
  it('upgrades a v1 document to the current schema version', () => {
    const document = parseWorldSaveDocument(V1_LEGACY_DOCUMENT);

    expect(document.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    expect(document.id).toBe('legacy-world');
    expect(document.name).toBe('遗留世界');
    expect(document.seed).toBe(12_345);
    expect(document.createdAt).toBe(1000);
    expect(document.updatedAt).toBe(2000);
  });

  it('adds fields that did not exist in v1', () => {
    const document = parseWorldSaveDocument(V1_LEGACY_DOCUMENT);

    expect(document.gameTime).toBe(0);
    expect(document.player.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(document.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('converts the v1 bare inventory array into a sized snapshot', () => {
    const document = parseWorldSaveDocument(V1_LEGACY_DOCUMENT);
    const { slots, selected } = document.player.inventory;

    expect(slots).toHaveLength(INVENTORY_SLOTS);
    expect(slots[0]).toEqual({ item: 1, count: 5 });
    expect(slots[1]).toBeNull();
    expect(slots[2]).toEqual({ item: 9, count: 64 });
    expect(selected).toBe(2);
  });

  it('keeps v1 embedded chunk edits so the player does not lose their build', () => {
    const document = parseWorldSaveDocument(V1_LEGACY_DOCUMENT);

    expect(document.legacyChunks).toHaveLength(2);
    expect(document.legacyChunks[0]).toEqual({ cx: 0, cz: 0, edits: [{ index: 4, id: 9 }] });
    expect(document.legacyChunks[1]).toEqual({ cx: -1, cz: 2, edits: [{ index: 16, id: 3 }] });
  });

  it('accepts the legacy "version" field as well as "schemaVersion"', () => {
    const migrated = migrate({ ...V1_LEGACY_DOCUMENT });

    expect(migrated['schemaVersion']).toBe(SAVE_SCHEMA_VERSION);
  });

  it('is idempotent on a current-version document', () => {
    const current = createWorldDocument(createSaveInput(), 5000);

    const migrated = migrate(current);

    expect(migrated['schemaVersion']).toBe(SAVE_SCHEMA_VERSION);
    expect(migrated['id']).toBe('world-1');
  });

  it('rejects a document written by a newer game version', () => {
    const newer = { ...V1_LEGACY_DOCUMENT, schemaVersion: SAVE_SCHEMA_VERSION + 1 };

    expect(appErrorCodeOf(() => migrate(newer))).toBe('SAVE_VERSION_UNSUPPORTED');
  });

  it('rejects documents without a version field', () => {
    expect(appErrorCodeOf(() => migrate({ id: 'x', name: 'x' }))).toBe('SAVE_CORRUPTED');
  });

  it('rejects a non-integer or too-old version', () => {
    expect(appErrorCodeOf(() => migrate({ schemaVersion: 1.5 }))).toBe('SAVE_CORRUPTED');
    expect(
      appErrorCodeOf(() => migrate({ schemaVersion: FIRST_SUPPORTED_SCHEMA_VERSION - 1 })),
    ).toBe('SAVE_CORRUPTED');
  });

  it('rejects a root value that is not an object', () => {
    expect(appErrorCodeOf(() => migrate(null))).toBe('SAVE_CORRUPTED');
    expect(appErrorCodeOf(() => migrate([1, 2, 3]))).toBe('SAVE_CORRUPTED');
    expect(appErrorCodeOf(() => migrate('存档'))).toBe('SAVE_CORRUPTED');
  });
});

describe('parseWorldSaveDocument', () => {
  it('rejects a structurally broken current-version document', () => {
    const current = createWorldDocument(createSaveInput(), 5000);

    expect(
      appErrorCodeOf(() =>
        parseWorldSaveDocument({ ...current, player: { ...current.player, position: '远处' } }),
      ),
    ).toBe('SAVE_CORRUPTED');
    expect(appErrorCodeOf(() => parseWorldSaveDocument({ ...current, id: '' }))).toBe(
      'SAVE_CORRUPTED',
    );
    expect(appErrorCodeOf(() => parseWorldSaveDocument({ ...current, seed: { bad: true } }))).toBe(
      'SAVE_CORRUPTED',
    );
  });

  it('falls back to defaults for unreadable settings without losing the world', () => {
    const current = createWorldDocument(createSaveInput(), 5000);

    const document = parseWorldSaveDocument({ ...current, settings: 'not-json' });

    expect(document.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps out-of-range settings instead of rejecting the save', () => {
    const current = createWorldDocument(createSaveInput(), 5000);

    const document = parseWorldSaveDocument({
      ...current,
      settings: { fov: 5000, masterVolume: -2, renderDistance: 99, invertY: 'yes' },
    });

    expect(document.settings.fov).toBe(SETTINGS_LIMITS.fov.max);
    expect(document.settings.masterVolume).toBe(SETTINGS_LIMITS.masterVolume.min);
    expect(document.settings.renderDistance).toBe(SETTINGS_LIMITS.renderDistance.max);
    // 非布尔值回退默认，而不是抛错。
    expect(document.settings.invertY).toBe(DEFAULT_SETTINGS.invertY);
  });

  it('pads and truncates the inventory to the fixed slot count', () => {
    const current = createWorldDocument(createSaveInput(), 5000);
    const tooMany = new Array(INVENTORY_SLOTS + 5).fill({ item: 1, count: 1 });
    const document = parseWorldSaveDocument({
      ...current,
      player: { ...current.player, inventory: { slots: tooMany, selected: 0 } },
    });

    expect(document.player.inventory.slots).toHaveLength(INVENTORY_SLOTS);

    const tooFew = parseWorldSaveDocument({
      ...current,
      player: {
        ...current.player,
        inventory: { slots: [{ item: 1, count: 1 }], selected: 0 },
      },
    });
    expect(tooFew.player.inventory.slots).toHaveLength(INVENTORY_SLOTS);
    expect(tooFew.player.inventory.slots[1]).toBeNull();
  });

  it('clamps stack counts and wraps the selected hotbar slot', () => {
    const current = createWorldDocument(createSaveInput(), 5000);
    const document = parseWorldSaveDocument({
      ...current,
      player: {
        ...current.player,
        inventory: {
          slots: [{ item: 1, count: 9999 }, null, null, null, null, null, null, null, null],
          selected: HOTBAR_SLOTS * 3 + 2,
        },
      },
    });

    expect(document.player.inventory.slots[0]).toEqual({ item: 1, count: MAX_STACK_SIZE });
    expect(document.player.inventory.selected).toBe(2);
  });

  it('clamps the health value into range', () => {
    const current = createWorldDocument(createSaveInput(), 5000);

    const high = parseWorldSaveDocument({
      ...current,
      player: { ...current.player, health: 1000 },
    });
    const low = parseWorldSaveDocument({
      ...current,
      player: { ...current.player, health: -50 },
    });

    expect(high.player.health).toBe(MAX_HEALTH);
    expect(low.player.health).toBe(0);
  });
});

describe('parseChunkEdits', () => {
  it('accepts a valid edits payload and de-duplicates by index', () => {
    const edits = parseChunkEdits(
      [
        { index: 1, id: 1 },
        { index: 2, id: 2 },
        { index: 1, id: 9 },
      ],
      'w:0',
    );

    expect(edits).toEqual([
      { index: 1, id: 9 },
      { index: 2, id: 2 },
    ]);
  });

  it('rejects a payload that is not an array', () => {
    expect(appErrorCodeOf(() => parseChunkEdits({ edits: [] }, 'w:0'))).toBe('SAVE_CORRUPTED');
    expect(appErrorCodeOf(() => parseChunkEdits(null, 'w:0'))).toBe('SAVE_CORRUPTED');
  });

  it('rejects out-of-range indices and block ids', () => {
    expect(appErrorCodeOf(() => parseChunkEdits([{ index: CHUNK_VOLUME, id: 1 }], 'w:0'))).toBe(
      'SAVE_CORRUPTED',
    );
    expect(appErrorCodeOf(() => parseChunkEdits([{ index: -1, id: 1 }], 'w:0'))).toBe(
      'SAVE_CORRUPTED',
    );
    expect(appErrorCodeOf(() => parseChunkEdits([{ index: 0, id: 999 }], 'w:0'))).toBe(
      'SAVE_CORRUPTED',
    );
    expect(appErrorCodeOf(() => parseChunkEdits([{ index: 0.5, id: 1 }], 'w:0'))).toBe(
      'SAVE_CORRUPTED',
    );
  });

  it('names the offending chunk in the error message', () => {
    try {
      parseChunkEdits([{ index: -3, id: 1 }], 'world-1:42');
      throw new Error('预期抛出 SAVE_CORRUPTED');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).message).toContain('world-1:42');
    }
  });
});

describe('createWorldDocument', () => {
  it('produces a document that can be parsed back unchanged', () => {
    const document = createWorldDocument(createSaveInput(), 5000);

    const reparsed = parseWorldSaveDocument(document);

    expect(reparsed).toEqual(document);
  });

  it('uses the injected clock for new documents', () => {
    const document = createWorldDocument(createSaveInput(), 777_000);

    expect(document.createdAt).toBe(777_000);
    expect(document.updatedAt).toBe(777_000);
  });

  it('rejects an empty world id', () => {
    expect(appErrorCodeOf(() => createWorldDocument(createSaveInput({ id: '  ' }), 0))).toBe(
      'SAVE_CORRUPTED',
    );
  });
});

describe('readWorldId', () => {
  it('extracts the id when present and returns null otherwise', () => {
    expect(readWorldId({ id: 'a' })).toBe('a');
    expect(readWorldId({ id: '' })).toBeNull();
    expect(readWorldId({})).toBeNull();
    expect(readWorldId(null)).toBeNull();
    expect(readWorldId('a')).toBeNull();
  });
});
