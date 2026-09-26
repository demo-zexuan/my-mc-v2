/**
 * `BlockInteraction` 单元测试：放置拒绝条件全集 + 成功路径的副作用。
 */

import { describe, expect, it } from 'vitest';

import { EventBus, type GameEventMap } from '@/engine/events/EventBus';
import { PlayerInventory } from '@/inventory/Inventory';
import { BlockInteraction, DEFAULT_REACH } from '@/interaction/BlockInteraction';
import { createHit, type AabbLike } from '@/interaction/types';
import { BlockId } from '@/world/BlockRegistry';

import { FakeWorld } from './fake-world';

const UP = { x: 0, y: 1, z: 0 };
/** 远离任何测试方块；需要"与玩家相交"的用例会覆盖它。 */
const FAR_AWAY: AabbLike = {
  minX: 100,
  minY: 100,
  minZ: 100,
  maxX: 100.6,
  maxY: 101.8,
  maxZ: 100.6,
};

interface Harness {
  readonly world: FakeWorld;
  readonly inventory: PlayerInventory;
  readonly bus: EventBus;
  readonly interaction: BlockInteraction;
  readonly placedEvents: GameEventMap['block:placed'][];
  readonly box: { current: AabbLike };
}

function harness(options: { item?: BlockId; count?: number; maxDistance?: number } = {}): Harness {
  const world = new FakeWorld();
  const inventory = new PlayerInventory();
  const item = options.item ?? BlockId.Stone;
  inventory.setSlot(0, { item, count: options.count ?? 10 });
  inventory.select(0);

  const bus = new EventBus();
  const placedEvents: GameEventMap['block:placed'][] = [];
  bus.on('block:placed', (payload) => placedEvents.push(payload));

  const box = { current: FAR_AWAY };
  const interaction = new BlockInteraction({
    world,
    bus,
    inventory,
    getPlayerBox: () => box.current,
    ...(options.maxDistance === undefined ? {} : { maxDistance: options.maxDistance }),
  });

  return { world, inventory, bus, interaction, placedEvents, box };
}

describe('BlockInteraction 成功路径', () => {
  it('按命中面法线计算放置位置并写世界、扣物品、发事件', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);

    const result = h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 3));
    expect(result).toEqual({ ok: true, x: 0, y: 1, z: 0, block: BlockId.Stone });
    expect(h.world.getBlock(0, 1, 0)).toBe(BlockId.Stone);
    expect(h.inventory.countItem(BlockId.Stone)).toBe(9);
    expect(h.placedEvents).toEqual([{ x: 0, y: 1, z: 0, block: BlockId.Stone }]);
  });

  it('侧面法线决定水平偏移，含负方向', () => {
    const h = harness();
    h.world.set(5, 2, 5, BlockId.Stone);

    expect(
      h.interaction.place(createHit(5, 2, 5, BlockId.Stone, { x: 1, y: 0, z: 0 }, 2)),
    ).toMatchObject({
      ok: true,
      x: 6,
      y: 2,
      z: 5,
    });
    expect(
      h.interaction.place(createHit(5, 2, 5, BlockId.Stone, { x: -1, y: 0, z: 0 }, 2)),
    ).toMatchObject({
      ok: true,
      x: 4,
      y: 2,
      z: 5,
    });
    expect(
      h.interaction.place(createHit(5, 2, 5, BlockId.Stone, { x: 0, y: 0, z: 1 }, 2)),
    ).toMatchObject({
      ok: true,
      x: 5,
      y: 2,
      z: 6,
    });
  });

  it('浮点法线被取整到整数方块坐标', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Dirt);
    const result = h.interaction.place(
      createHit(0, 0, 0, BlockId.Dirt, { x: 0.0001, y: 0.9999999, z: -0.0001 }, 2),
    );
    expect(result).toMatchObject({ ok: true, x: 0, y: 1, z: 0 });
  });

  it('恰好等于最大交互距离时允许放置', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    expect(h.interaction.maxDistance).toBe(DEFAULT_REACH);
    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, DEFAULT_REACH)).ok).toBe(true);
  });
});

describe('BlockInteraction 拒绝条件', () => {
  it('没有命中 → no-target，且不消耗物品', () => {
    const h = harness();
    expect(h.interaction.place(null)).toEqual({ ok: false, reason: 'no-target' });
    expect(h.inventory.countItem(BlockId.Stone)).toBe(10);
    expect(h.world.writes).toHaveLength(0);
    expect(h.placedEvents).toHaveLength(0);
  });

  it('超过最大交互距离 → out-of-range', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    expect(
      h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, DEFAULT_REACH + 0.01)),
    ).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
    expect(
      h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, Number.POSITIVE_INFINITY)),
    ).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
    expect(h.world.writes).toHaveLength(0);
  });

  it('自定义最大距离生效', () => {
    const h = harness({ maxDistance: 3 });
    h.world.set(0, 0, 0, BlockId.Stone);
    expect(h.interaction.maxDistance).toBe(3);
    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 3.5))).toEqual({
      ok: false,
      reason: 'out-of-range',
    });
    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2.5)).ok).toBe(true);
  });

  it('手上没有物品 → no-item', () => {
    const h = harness({ item: BlockId.Stone, count: 10 });
    h.inventory.clear();
    h.world.set(0, 0, 0, BlockId.Stone);
    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2))).toEqual({
      ok: false,
      reason: 'no-item',
    });
  });

  it('不可放置的方块（水/空气）→ not-placeable', () => {
    const water = harness({ item: BlockId.Water });
    water.world.set(0, 0, 0, BlockId.Stone);
    expect(water.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2))).toEqual({
      ok: false,
      reason: 'not-placeable',
    });

    const air = harness({ item: BlockId.Air });
    air.world.set(0, 0, 0, BlockId.Stone);
    expect(air.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2))).toEqual({
      ok: false,
      reason: 'not-placeable',
    });

    expect(water.inventory.countItem(BlockId.Water)).toBe(10);
    expect(water.world.writes).toHaveLength(0);
  });

  it('目标位置已被非空气方块占据 → obstructed', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.world.set(0, 1, 0, BlockId.Dirt);

    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2))).toEqual({
      ok: false,
      reason: 'obstructed',
    });
    expect(h.world.getBlock(0, 1, 0)).toBe(BlockId.Dirt);
    expect(h.inventory.countItem(BlockId.Stone)).toBe(10);
  });

  it('放置后与玩家包围盒相交 → intersects-player', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    // 玩家正站在 (0,1,0) 这一格里。
    h.box.current = { minX: 0.2, minY: 1, minZ: 0.2, maxX: 0.8, maxY: 2.8, maxZ: 0.8 };

    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2))).toEqual({
      ok: false,
      reason: 'intersects-player',
    });
    expect(h.world.writes).toHaveLength(0);
    expect(h.inventory.countItem(BlockId.Stone)).toBe(10);
  });

  it('只是"贴着"玩家包围盒（共面）不算相交', () => {
    const h = harness();
    h.world.set(1, 0, 0, BlockId.Stone);
    // 玩家右边界恰好落在 x=1：方块 (0,0,0) 的右面 x=1 与玩家共面。
    h.box.current = { minX: 1, minY: 0, minZ: 0, maxX: 1.6, maxY: 1.8, maxZ: 0.6 };

    expect(
      h.interaction.canPlace(createHit(1, 0, 0, BlockId.Stone, { x: -1, y: 0, z: 0 }, 2)),
    ).toEqual({
      ok: true,
      x: 0,
      y: 0,
      z: 0,
      block: BlockId.Stone,
    });

    // 再往左挪 0.01，就开始真正重叠了。
    h.box.current = { minX: 0.99, minY: 0, minZ: 0, maxX: 1.59, maxY: 1.8, maxZ: 0.6 };
    expect(
      h.interaction.canPlace(createHit(1, 0, 0, BlockId.Stone, { x: -1, y: 0, z: 0 }, 2)),
    ).toEqual({
      ok: false,
      reason: 'intersects-player',
    });
  });

  it('世界拒绝写入 → world-rejected 且不消耗物品', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.world.rejectWrites = true;

    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2))).toEqual({
      ok: false,
      reason: 'world-rejected',
    });
    expect(h.inventory.countItem(BlockId.Stone)).toBe(10);
    expect(h.placedEvents).toHaveLength(0);
  });
});

describe('BlockInteraction.canPlace 是纯判定', () => {
  it('不写世界、不扣物品、不发事件', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);

    expect(h.interaction.canPlace(createHit(0, 0, 0, BlockId.Stone, UP, 2))).toEqual({
      ok: true,
      x: 0,
      y: 1,
      z: 0,
      block: BlockId.Stone,
    });
    expect(h.world.writes).toHaveLength(0);
    expect(h.inventory.countItem(BlockId.Stone)).toBe(10);
    expect(h.placedEvents).toHaveLength(0);
  });

  it('连续放置会逐个扣减，耗尽后拒绝', () => {
    const h = harness({ count: 2 });
    h.world.set(0, 0, 0, BlockId.Stone);
    h.world.set(0, 0, 1, BlockId.Stone);

    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2)).ok).toBe(true);
    expect(h.interaction.place(createHit(0, 0, 1, BlockId.Stone, UP, 2)).ok).toBe(true);
    expect(h.interaction.place(createHit(0, 0, 0, BlockId.Stone, UP, 2))).toEqual({
      ok: false,
      reason: 'no-item',
    });
    expect(h.placedEvents).toHaveLength(2);
  });
});
