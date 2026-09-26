/**
 * `PlayerInventory` 单元测试。
 *
 * 覆盖：堆叠上限、先补未满堆再占空槽、合并、拆分、移动、丢弃、
 * 快照往返、越界安全。
 */

import { describe, expect, it } from 'vitest';

import { EventBus } from '@/engine/events/EventBus';
import { PlayerInventory } from '@/inventory/Inventory';
import { HOTBAR_SLOTS, INVENTORY_SLOTS, MAX_STACK_SIZE } from '@/inventory/types';
import { BlockId } from '@/world/BlockRegistry';

describe('PlayerInventory 基本形状', () => {
  it('默认有 36 个槽位且全部为空', () => {
    const inventory = new PlayerInventory();
    expect(inventory.size).toBe(INVENTORY_SLOTS);
    expect(inventory.selectedIndex).toBe(0);
    expect(inventory.isEmpty()).toBe(true);
    expect(inventory.snapshot().slots).toHaveLength(INVENTORY_SLOTS);
    expect(inventory.snapshot().slots.every((slot) => slot === null)).toBe(true);
  });
});

describe('PlayerInventory.add', () => {
  it('先占空槽并返回 0 剩余', () => {
    const inventory = new PlayerInventory();
    const remaining = inventory.add(BlockId.Stone, 10);
    expect(remaining).toBe(0);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 10 });
  });

  it('超过堆叠上限时溢出到下一格', () => {
    const inventory = new PlayerInventory();
    expect(inventory.add(BlockId.Stone, MAX_STACK_SIZE + 5)).toBe(0);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: MAX_STACK_SIZE });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Stone, count: 5 });
  });

  it('先补未满堆，再占用空槽', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(3, { item: BlockId.Stone, count: 60 });
    // 槽 0/1 故意留空：正确实现应当先补满槽 3，而不是新开一格。
    expect(inventory.add(BlockId.Stone, 10)).toBe(0);
    expect(inventory.getSlot(3)).toEqual({ item: BlockId.Stone, count: MAX_STACK_SIZE });
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 6 });
    expect(inventory.getSlot(1)).toBeNull();
  });

  it('背包放不下时返回剩余量', () => {
    const inventory = new PlayerInventory({ size: 1 });
    expect(inventory.add(BlockId.Dirt, MAX_STACK_SIZE + 7)).toBe(7);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Dirt, count: MAX_STACK_SIZE });
  });

  it('不同物品不混堆', () => {
    const inventory = new PlayerInventory();
    inventory.add(BlockId.Stone, 10);
    inventory.add(BlockId.Dirt, 10);
    expect(inventory.getSlot(0)?.item).toBe(BlockId.Stone);
    expect(inventory.getSlot(1)?.item).toBe(BlockId.Dirt);
  });

  it('非法数量视为 0', () => {
    const inventory = new PlayerInventory();
    expect(inventory.add(BlockId.Stone, 0)).toBe(0);
    expect(inventory.add(BlockId.Stone, -5)).toBe(0);
    expect(inventory.add(BlockId.Stone, Number.NaN)).toBe(0);
    expect(inventory.isEmpty()).toBe(true);
  });

  it('小数数量向下取整', () => {
    const inventory = new PlayerInventory();
    inventory.add(BlockId.Stone, 3.9);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 3 });
  });
});

describe('PlayerInventory 越界安全', () => {
  it('getSlot/setSlot/dropSlot 对越界下标返回 null 且不抛错', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 1 });

    for (const index of [-1, INVENTORY_SLOTS, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(inventory.getSlot(index)).toBeNull();
      expect(inventory.peek(index)).toBeNull();
      expect(inventory.dropSlot(index)).toBeNull();
      inventory.setSlot(index, { item: BlockId.Dirt, count: 1 });
    }

    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 1 });
    expect(inventory.countItem(BlockId.Dirt)).toBe(0);
  });

  it('setSlot 规范化非法数量', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 0 });
    expect(inventory.getSlot(0)).toBeNull();

    inventory.setSlot(1, { item: BlockId.Stone, count: -3 });
    expect(inventory.getSlot(1)).toBeNull();

    inventory.setSlot(2, { item: BlockId.Stone, count: MAX_STACK_SIZE + 100 });
    expect(inventory.getSlot(2)).toEqual({ item: BlockId.Stone, count: MAX_STACK_SIZE });

    inventory.setSlot(3, { item: BlockId.Stone, count: 12.7 });
    expect(inventory.getSlot(3)).toEqual({ item: BlockId.Stone, count: 12 });

    inventory.setSlot(4, { item: BlockId.Stone, count: Number.NaN });
    expect(inventory.getSlot(4)).toBeNull();
  });
});

describe('PlayerInventory.moveSlot', () => {
  it('移动到空槽', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 12 });
    inventory.moveSlot(0, 5);
    expect(inventory.getSlot(0)).toBeNull();
    expect(inventory.getSlot(5)).toEqual({ item: BlockId.Stone, count: 12 });
  });

  it('同类合并，超出的留在原格', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 60 });
    inventory.setSlot(1, { item: BlockId.Stone, count: 10 });
    inventory.moveSlot(1, 0);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: MAX_STACK_SIZE });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Stone, count: 6 });
  });

  it('同类合并且在原格用尽时清空原格', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 60 });
    inventory.setSlot(1, { item: BlockId.Stone, count: 4 });
    inventory.moveSlot(1, 0);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: MAX_STACK_SIZE });
    expect(inventory.getSlot(1)).toBeNull();
  });

  it('异类交换', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 3 });
    inventory.setSlot(1, { item: BlockId.Dirt, count: 5 });
    inventory.moveSlot(0, 1);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Dirt, count: 5 });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Stone, count: 3 });
  });

  it('源格为空或下标非法时不变', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 3 });
    inventory.moveSlot(4, 0);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 3 });

    inventory.moveSlot(0, 0);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 3 });

    inventory.moveSlot(-1, 2);
    expect(inventory.getSlot(2)).toBeNull();
  });

  it('双方都满时不产生任何变化', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: MAX_STACK_SIZE });
    inventory.setSlot(1, { item: BlockId.Stone, count: MAX_STACK_SIZE });
    inventory.moveSlot(0, 1);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: MAX_STACK_SIZE });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Stone, count: MAX_STACK_SIZE });
  });
});

describe('PlayerInventory.splitSlot', () => {
  it('偶数堆对半', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 64 });
    inventory.splitSlot(0, 1);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 32 });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Stone, count: 32 });
  });

  it('奇数堆保留较大的一半', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 5 });
    inventory.splitSlot(0, 1);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 3 });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Stone, count: 2 });
  });

  it('单个物品无法拆分', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 1 });
    inventory.splitSlot(0, 1);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 1 });
    expect(inventory.getSlot(1)).toBeNull();
  });

  it('目标格非空时不覆盖', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 64 });
    inventory.setSlot(1, { item: BlockId.Dirt, count: 1 });
    inventory.splitSlot(0, 1);
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 64 });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Dirt, count: 1 });
  });
});

describe('PlayerInventory.dropSlot / 查询', () => {
  it('丢弃整格并返回内容', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(2, { item: BlockId.Cobblestone, count: 7 });
    expect(inventory.dropSlot(2)).toEqual({ item: BlockId.Cobblestone, count: 7 });
    expect(inventory.getSlot(2)).toBeNull();
    expect(inventory.dropSlot(2)).toBeNull();
  });

  it('findItem 返回最小下标，countItem 汇总全部槽位', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(4, { item: BlockId.Stone, count: 5 });
    inventory.setSlot(9, { item: BlockId.Stone, count: 6 });
    inventory.setSlot(1, { item: BlockId.Dirt, count: 2 });

    expect(inventory.findItem(BlockId.Stone)).toBe(4);
    expect(inventory.findItem(BlockId.Dirt)).toBe(1);
    expect(inventory.findItem(BlockId.GoldOre)).toBe(-1);
    expect(inventory.countItem(BlockId.Stone)).toBe(11);
    expect(inventory.countItem(BlockId.Dirt)).toBe(2);
    expect(inventory.countItem(BlockId.GoldOre)).toBe(0);
  });

  it('clear 清空所有槽位但不改选中格', () => {
    const inventory = new PlayerInventory();
    inventory.select(3);
    inventory.add(BlockId.Stone, 10);
    inventory.clear();
    expect(inventory.isEmpty()).toBe(true);
    expect(inventory.selectedIndex).toBe(3);
  });
});

describe('PlayerInventory 选中与 consumeSelected', () => {
  it('select 折返任意整数', () => {
    const inventory = new PlayerInventory();
    inventory.select(HOTBAR_SLOTS);
    expect(inventory.selectedIndex).toBe(0);
    inventory.select(-1);
    expect(inventory.selectedIndex).toBe(HOTBAR_SLOTS - 1);
    inventory.select(HOTBAR_SLOTS * 2 + 3);
    expect(inventory.selectedIndex).toBe(3);
    inventory.select(Number.NaN);
    expect(inventory.selectedIndex).toBe(3);
  });

  it('选中变化时广播 hotbar:selection-changed', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.on('hotbar:selection-changed', (payload) => {
      seen.push(payload.index);
    });
    const inventory = new PlayerInventory({ bus });

    inventory.select(2);
    inventory.select(2);
    inventory.select(3);
    expect(seen).toEqual([2, 3]);
  });

  it('selectedStack 与 consumeSelected 的部分/全部取出', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(1, { item: BlockId.Sand, count: 10 });
    inventory.select(1);

    expect(inventory.selectedStack()).toEqual({ item: BlockId.Sand, count: 10 });
    expect(inventory.consumeSelected()).toEqual({ item: BlockId.Sand, count: 1 });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Sand, count: 9 });

    expect(inventory.consumeSelected(4)).toEqual({ item: BlockId.Sand, count: 4 });
    expect(inventory.getSlot(1)).toEqual({ item: BlockId.Sand, count: 5 });

    expect(inventory.consumeSelected(999)).toEqual({ item: BlockId.Sand, count: 5 });
    expect(inventory.getSlot(1)).toBeNull();
    expect(inventory.consumeSelected()).toBeNull();
  });

  it('consumeSelected 数量非法时不消耗', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Sand, count: 10 });
    expect(inventory.consumeSelected(0)).toBeNull();
    expect(inventory.consumeSelected(-1)).toBeNull();
    expect(inventory.consumeSelected(Number.NaN)).toBeNull();
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Sand, count: 10 });
  });
});

describe('PlayerInventory 快照往返', () => {
  it('snapshot → restore 完全一致', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 64 });
    inventory.setSlot(5, { item: BlockId.Dirt, count: 3 });
    inventory.setSlot(35, { item: BlockId.DiamondOre, count: 1 });
    inventory.select(7);

    const snapshot = inventory.snapshot();

    const restored = new PlayerInventory();
    restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);
  });

  it('恢复到更小的背包时只保留能放下的槽位', () => {
    const inventory = new PlayerInventory();
    inventory.setSlot(0, { item: BlockId.Stone, count: 64 });
    inventory.setSlot(2, { item: BlockId.Dirt, count: 3 });
    inventory.setSlot(30, { item: BlockId.DiamondOre, count: 1 });

    const small = new PlayerInventory({ size: 4 });
    small.restore(inventory.snapshot());

    expect(small.size).toBe(4);
    expect(small.snapshot().slots).toHaveLength(4);
    expect(small.getSlot(0)).toEqual({ item: BlockId.Stone, count: 64 });
    expect(small.getSlot(2)).toEqual({ item: BlockId.Dirt, count: 3 });
    expect(small.getSlot(3)).toBeNull();
  });

  it('snapshot 返回副本，外部修改不影响背包', () => {
    const inventory = new PlayerInventory();
    inventory.add(BlockId.Stone, 5);
    const snapshot = inventory.snapshot();
    const mutable = snapshot.slots as (null | { item: BlockId; count: number })[];
    mutable[0] = null;
    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: 5 });
  });

  it('restore 规范化脏快照', () => {
    const inventory = new PlayerInventory();
    inventory.restore({
      slots: [
        { item: BlockId.Stone, count: MAX_STACK_SIZE + 50 },
        { item: BlockId.Dirt, count: -1 },
        { item: BlockId.Sand, count: 2.5 },
      ],
      selected: 99,
    });

    expect(inventory.getSlot(0)).toEqual({ item: BlockId.Stone, count: MAX_STACK_SIZE });
    expect(inventory.getSlot(1)).toBeNull();
    expect(inventory.getSlot(2)).toEqual({ item: BlockId.Sand, count: 2 });
    expect(inventory.getSlot(3)).toBeNull();
    expect(inventory.selectedIndex).toBe(99 % HOTBAR_SLOTS);
  });

  it('restore 接受更短的旧快照', () => {
    const inventory = new PlayerInventory();
    inventory.add(BlockId.Stone, 64);
    inventory.restore({ slots: [], selected: 0 });
    expect(inventory.isEmpty()).toBe(true);
  });
});
