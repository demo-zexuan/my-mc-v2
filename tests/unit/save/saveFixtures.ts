/**
 * 存档测试夹具。
 *
 * I. 为什么把夹具抽出来
 *
 * 1. 迁移、`SaveManager` 往返、IndexedDB 存储三条测试路径都要构造"合法存档"；各自手写
 *    会出现"某个测试的数据其实不合法"的假阴性。
 * 2. v1 夹具是**历史格式**，它必须保持"看起来像 2024 年的旧版本"而不是随当前 schema
 *    一起演进，因此单独放在这里并加上注释。
 *
 * @module tests/unit/save/saveFixtures
 */

import { HOTBAR_SLOTS, INVENTORY_SLOTS, type ItemStack } from '@/inventory/types';
import type { PlayerSaveState, SaveWorldInput } from '@/save/saveSchema';
import { DEFAULT_SETTINGS } from '@/settings/types';

/**
 * v1 存档：使用 `version` 字段、内嵌 `blocks`、背包为裸数组 + 顶层 `selectedSlot`。
 */
export const V1_LEGACY_DOCUMENT = {
  version: 1,
  id: 'legacy-world',
  name: '遗留世界',
  seed: 12_345,
  createdAt: 1000,
  updatedAt: 2000,
  player: {
    position: { x: 8, y: 70, z: -4 },
    rotation: { yaw: 0.5, pitch: -0.25 },
    health: 17,
    inventory: [{ item: 1, count: 5 }, null, { item: 9, count: 64 }],
    selectedSlot: 2,
  },
  blocks: [
    { cx: 0, cz: 0, edits: [{ index: 4, id: 9 }] },
    { cx: -1, cz: 2, edits: [{ index: 16, id: 3 }] },
  ],
} as const;

/** 构造一份合法的玩家状态；默认值刻意取非零以暴露"字段没被真正写入"的问题。 */
export function createPlayerState(overrides: Partial<PlayerSaveState> = {}): PlayerSaveState {
  // 槽位数组在构造阶段需要可写；`PlayerSaveState` 中的只读视图在返回时生效。
  const slots: (ItemStack | null)[] = new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null);
  slots[0] = { item: 1, count: 32 };
  slots[HOTBAR_SLOTS] = { item: 9, count: 7 };
  return {
    position: { x: 12.5, y: 68, z: -30.25 },
    rotation: { yaw: 1.25, pitch: -0.4 },
    velocity: { x: 0.1, y: -0.2, z: 0.3 },
    health: 18,
    inventory: { slots, selected: 3 },
    ...overrides,
  };
}

/** 构造一份合法的保存入参。 */
export function createSaveInput(overrides: Partial<SaveWorldInput> = {}): SaveWorldInput {
  return {
    id: 'world-1',
    name: '测试世界',
    seed: 987_654_321,
    gameTime: 4321,
    player: createPlayerState(),
    settings: { ...DEFAULT_SETTINGS, fov: 90, masterVolume: 0.4 },
    chunks: [
      {
        cx: 0,
        cz: 0,
        edits: [
          { index: 4, id: 9 },
          { index: 20, id: 1 },
        ],
      },
    ],
    ...overrides,
  };
}
