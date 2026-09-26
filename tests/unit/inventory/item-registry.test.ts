/**
 * `ItemRegistry` 单元测试：方块 → 物品的颜色/名称/掉落映射。
 */

import { describe, expect, it } from 'vitest';

import {
  blockColorOf,
  blockItemInfo,
  clearItemInfoCache,
  colorToHex,
  isPlaceableBlock,
  itemForBlock,
  itemInfoFor,
} from '@/inventory/ItemRegistry';
import { BlockId, texturesOf } from '@/world/BlockRegistry';

describe('ItemRegistry 展示信息', () => {
  it('颜色取自侧面贴图 baseColor', () => {
    clearItemInfoCache();
    for (const id of [BlockId.Stone, BlockId.Dirt, BlockId.Grass, BlockId.Lamp, BlockId.Brick]) {
      expect(itemInfoFor(id).color).toBe(texturesOf(id).side.baseColor);
    }
  });

  it('草方块用侧面色而不是顶面色（物品图标应与场景外观一致）', () => {
    expect(texturesOf(BlockId.Grass).top.baseColor).toBe(0x6cae4a);
    expect(itemInfoFor(BlockId.Grass).color).toBe(0x7a5a3a);
  });

  it('石头与萤石灯的具体颜色', () => {
    expect(itemInfoFor(BlockId.Stone).color).toBe(0x8a8a8f);
    expect(blockColorOf(BlockId.Lamp)).toBe(0xffd98a);
  });

  it('中文显示名与机器名来自方块定义', () => {
    const stone = itemInfoFor(BlockId.Stone);
    expect(stone.name).toBe('stone');
    expect(stone.displayName).toBe('石头');
    expect(stone.kind).toBe('block');
    expect(stone.id).toBe(BlockId.Stone);
  });

  it('colorHex 与 color 一致', () => {
    const info = itemInfoFor(BlockId.DiamondOre);
    expect(info.colorHex).toBe(colorToHex(info.color));
    expect(info.colorHex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('未知 id 回退到兜底信息而不是抛错', () => {
    expect(blockItemInfo(200 as BlockId)).toBeNull();
    const fallback = itemInfoFor(200 as BlockId);
    expect(fallback.name).toBe('unknown');
    expect(fallback.id).toBe(200);
  });

  it('缓存返回同一个不可变对象', () => {
    clearItemInfoCache();
    const first = blockItemInfo(BlockId.Stone);
    const second = blockItemInfo(BlockId.Stone);
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });
});

describe('ItemRegistry 掉落与可放置性', () => {
  it('默认掉落自身', () => {
    expect(itemForBlock(BlockId.Stone)).toBe(BlockId.Stone);
    expect(itemForBlock(BlockId.Cobblestone)).toBe(BlockId.Cobblestone);
  });

  it('草方块掉落泥土（覆盖 drop 字段）', () => {
    expect(itemForBlock(BlockId.Grass)).toBe(BlockId.Dirt);
  });

  it('玻璃/冰/基岩/水/空气不掉落任何东西', () => {
    expect(itemForBlock(BlockId.Glass)).toBeNull();
    expect(itemForBlock(BlockId.Ice)).toBeNull();
    expect(itemForBlock(BlockId.Bedrock)).toBeNull();
    expect(itemForBlock(BlockId.Water)).toBeNull();
    expect(itemForBlock(BlockId.Air)).toBeNull();
  });

  it('空气与液体不可放置，普通方块可放置', () => {
    expect(isPlaceableBlock(BlockId.Air)).toBe(false);
    expect(isPlaceableBlock(BlockId.Water)).toBe(false);
    expect(isPlaceableBlock(200 as BlockId)).toBe(false);
    expect(isPlaceableBlock(BlockId.Stone)).toBe(true);
    expect(isPlaceableBlock(BlockId.Glass)).toBe(true);
    expect(isPlaceableBlock(BlockId.Leaves)).toBe(true);
    expect(isPlaceableBlock(BlockId.Bedrock)).toBe(true);
  });
});

describe('colorToHex', () => {
  it('格式化为 6 位小写十六进制', () => {
    expect(colorToHex(0x8a8a8f)).toBe('#8a8a8f');
    expect(colorToHex(0x000000)).toBe('#000000');
    expect(colorToHex(0xffffff)).toBe('#ffffff');
  });

  it('越界值被钳制而不是产生非法字符串', () => {
    expect(colorToHex(-1)).toBe('#000000');
    expect(colorToHex(0x1ffffff)).toBe('#ffffff');
  });
});
