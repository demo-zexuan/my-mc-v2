/**
 * `ItemEntity` / `DropSystem` 单元测试：掉落生成、重力落地、拾取延迟与剩余量。
 */

import { describe, expect, it } from 'vitest';

import { EventBus, type GameEventMap } from '@/engine/events/EventBus';
import { DropSystem } from '@/entities/DropSystem';
import { ITEM_HALF_SIZE, ITEM_LIFETIME, PICKUP_DELAY, ItemEntity } from '@/entities/ItemEntity';
import { PlayerInventory } from '@/inventory/Inventory';
import { MAX_STACK_SIZE } from '@/inventory/types';
import type { MutableVec3, Vec3Like } from '@/interaction/types';
import { BlockId } from '@/world/BlockRegistry';

import { FakeWorld } from './fake-world';

const FAR: Vec3Like = { x: 100, y: 100, z: 100 };

function entityAt(x: number, y: number, z: number, count = 1): ItemEntity {
  return new ItemEntity({ id: 1, item: BlockId.Stone, count, position: { x, y, z } });
}

function step(entity: ItemEntity, world: FakeWorld, seconds: number, stepSize = 1 / 60): void {
  const steps = Math.max(1, Math.round(seconds / stepSize));
  for (let i = 0; i < steps; i += 1) {
    entity.update(stepSize, world);
  }
}

describe('ItemEntity 物理', () => {
  it('受重力下落并吸附到地面顶面', () => {
    const world = new FakeWorld().fillLayer(0, BlockId.Stone);
    const entity = entityAt(0.5, 4, 0.5);

    step(entity, world, 2);

    expect(entity.onGround).toBe(true);
    expect(entity.position.y).toBeCloseTo(1 + ITEM_HALF_SIZE, 6);
  });

  it('被卡在方块里时向上推出', () => {
    const world = new FakeWorld().set(2, 2, 2, BlockId.Stone);
    const entity = entityAt(2.5, 2.5, 2.5);

    entity.update(1 / 60, world);

    expect(entity.position.y).toBeCloseTo(3 + ITEM_HALF_SIZE, 6);
    expect(entity.onGround).toBe(true);
  });

  it('水平方向被墙挡住时速度归零', () => {
    const world = new FakeWorld().fillLayer(0, BlockId.Stone).set(2, 1, 0, BlockId.Stone);
    const entity = new ItemEntity({
      id: 2,
      item: BlockId.Dirt,
      count: 1,
      position: { x: 0.5, y: 1.125, z: 0.5 },
      velocity: { x: 6, y: 0, z: 0 },
    });

    step(entity, world, 3);

    expect(entity.position.x).toBeLessThan(2);
    expect(entity.velocity.x).toBe(0);
    expect(world.isSolidAt(2, 1, 0)).toBe(true);
  });

  it('超过存活时间后自动消失', () => {
    const world = new FakeWorld().fillLayer(0, BlockId.Stone);
    const entity = entityAt(0.5, 2, 0.5);
    expect(entity.alive).toBe(true);

    entity.update(ITEM_LIFETIME, world);
    expect(entity.alive).toBe(false);
  });

  it('掉出世界底部后消失', () => {
    const world = new FakeWorld();
    const entity = entityAt(0.5, -200, 0.5);

    entity.update(1 / 60, world);
    expect(entity.alive).toBe(false);
  });

  it('非法 deltaSeconds 不改变状态', () => {
    const world = new FakeWorld().fillLayer(0, BlockId.Stone);
    const entity = entityAt(0.5, 2, 0.5);
    const before = { ...entity.position };

    entity.update(Number.NaN, world);
    entity.update(-5, world);

    expect(entity.position).toEqual(before);
    expect(entity.age).toBe(0);
  });

  it('旋转与浮动动画随时间变化', () => {
    const entity = entityAt(0, 0, 0);
    const firstSpin = entity.spinAngle();
    const firstBob = entity.bobOffset();
    entity.age = 1.5;
    expect(entity.spinAngle()).not.toBe(firstSpin);
    expect(entity.bobOffset()).not.toBe(firstBob);
  });
});

describe('ItemEntity 拾取与合并数据', () => {
  it('拾取延迟为 0.5 秒', () => {
    const entity = entityAt(0, 0, 0);
    expect(entity.canBePickedUp()).toBe(false);
    entity.age = PICKUP_DELAY;
    expect(entity.canBePickedUp()).toBe(true);
  });

  it('距离用平方比较', () => {
    const entity = entityAt(3, 4, 5);
    expect(entity.distanceSquaredTo({ x: 3, y: 4, z: 5 })).toBe(0);
    expect(entity.distanceSquaredTo({ x: 0, y: 4, z: 5 })).toBe(9);
  });

  it('同类且不超上限才能合并', () => {
    const a = entityAt(0, 0, 0, 60);
    const b = entityAt(0, 0, 0, 4);
    const c = entityAt(0, 0, 0, 8);
    const other = new ItemEntity({
      id: 9,
      item: BlockId.Dirt,
      count: 1,
      position: { x: 0, y: 0, z: 0 },
    });

    expect(a.canMergeWith(b)).toBe(true);
    expect(a.canMergeWith(c)).toBe(false);
    expect(a.canMergeWith(other)).toBe(false);
    expect(a.canMergeWith(a)).toBe(false);

    a.absorb(b);
    expect(a.count).toBe(MAX_STACK_SIZE);
    expect(b.alive).toBe(false);
    expect(b.count).toBe(0);
  });

  it('数量被钳制到合法区间', () => {
    expect(entityAt(0, 0, 0, 0).count).toBe(1);
    expect(entityAt(0, 0, 0, 999).count).toBe(MAX_STACK_SIZE);
    // NaN/Infinity 必须先被有限性判断拦住，否则会污染合并与拾取判定。
    expect(entityAt(0, 0, 0, Number.NaN).count).toBe(1);
    expect(entityAt(0, 0, 0, Number.POSITIVE_INFINITY).count).toBe(1);
  });
});

interface Harness {
  readonly world: FakeWorld;
  readonly bus: EventBus;
  readonly inventory: PlayerInventory;
  readonly player: MutableVec3;
  readonly system: DropSystem;
  readonly collected: GameEventMap['item:collected'][];
}

function harness(options: { size?: number; maxEntities?: number } = {}): Harness {
  const world = new FakeWorld().fillLayer(0, BlockId.Stone);
  const bus = new EventBus();
  const inventory = new PlayerInventory(options.size === undefined ? {} : { size: options.size });
  const player: MutableVec3 = { ...FAR };
  const collected: GameEventMap['item:collected'][] = [];
  bus.on('item:collected', (payload) => collected.push(payload));

  const system = new DropSystem({
    world,
    bus,
    inventory,
    getPlayerPosition: () => player,
    ...(options.maxEntities === undefined ? {} : { maxEntities: options.maxEntities }),
  });

  return { world, bus, inventory, player, system, collected };
}

describe('DropSystem 掉落生成', () => {
  it('破坏方块后按其掉落物生成实体', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });

    expect(h.system.count).toBe(1);
    const entity = h.system.entities[0];
    expect(entity?.item).toBe(BlockId.Stone);
    expect(entity?.count).toBe(1);
  });

  it('草方块掉落泥土', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Grass });
    expect(h.system.entities[0]?.item).toBe(BlockId.Dirt);
  });

  it('不掉落的方块不生成实体', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Glass });
    h.bus.emit('block:broken', { x: 1, y: 1, z: 0, block: BlockId.Bedrock });
    expect(h.system.count).toBe(0);
  });

  it('同一位置连续破坏会合并成一个实体', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });

    expect(h.system.count).toBe(1);
    expect(h.system.entities[0]?.count).toBe(3);
  });

  it('相隔较远的掉落物不合并', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.bus.emit('block:broken', { x: 20, y: 1, z: 20, block: BlockId.Stone });
    expect(h.system.count).toBe(2);
  });

  it('掉落物数量有硬上限', () => {
    const h = harness({ maxEntities: 1 });
    expect(h.system.spawnDrop(BlockId.Stone, 1, { x: 0.5, y: 3, z: 0.5 })).not.toBeNull();
    expect(h.system.spawnDrop(BlockId.Stone, 1, { x: 20.5, y: 3, z: 20.5 })).toBeNull();
    expect(h.system.count).toBe(1);
  });

  it('dispose 后不再响应破坏事件', () => {
    const h = harness();
    h.system.dispose();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    expect(h.system.count).toBe(0);
  });
});

describe('DropSystem 落地与拾取', () => {
  it('掉落物会落到地面上', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 3, z: 0, block: BlockId.Stone });

    for (let i = 0; i < 180; i += 1) {
      h.system.update(1 / 60);
    }

    expect(h.system.count).toBe(1);
    expect(h.system.entities[0]?.onGround).toBe(true);
    expect(h.system.entities[0]?.position.y).toBeCloseTo(1 + ITEM_HALF_SIZE, 6);
  });

  it('生成后 0.5 秒内不会被拾取', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.player.x = 0.5;
    h.player.y = 1.2;
    h.player.z = 0.5;

    h.system.update(0.1);
    expect(h.system.count).toBe(1);
    expect(h.inventory.isEmpty()).toBe(true);

    h.system.update(0.5);
    expect(h.system.count).toBe(0);
    expect(h.inventory.countItem(BlockId.Stone)).toBe(1);
    expect(h.collected).toEqual([{ item: BlockId.Stone, count: 1 }]);
  });

  it('超出拾取半径不会被拾取', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.player.x = 10;
    h.player.y = 1.2;
    h.player.z = 10;

    for (let i = 0; i < 60; i += 1) {
      h.system.update(1 / 60);
    }
    expect(h.system.count).toBe(1);
    expect(h.inventory.isEmpty()).toBe(true);
  });

  it('垂直方向差异过大不会被拾取（例如站在方块正上方）', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.player.x = 0.5;
    h.player.y = 40;
    h.player.z = 0.5;

    h.system.update(1);
    expect(h.system.count).toBe(1);
  });

  it('拾取合并后的整堆只发一次事件', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.player.x = 0.5;
    h.player.y = 1.2;
    h.player.z = 0.5;

    h.system.update(1);
    expect(h.collected).toEqual([{ item: BlockId.Stone, count: 2 }]);
    expect(h.inventory.countItem(BlockId.Stone)).toBe(2);
  });

  it('背包放不下时剩余量留在地上', () => {
    const h = harness({ size: 1 });
    h.inventory.setSlot(0, { item: BlockId.Stone, count: MAX_STACK_SIZE });
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.player.x = 0.5;
    h.player.y = 1.2;
    h.player.z = 0.5;

    h.system.update(1);

    expect(h.system.count).toBe(1);
    expect(h.system.entities[0]?.count).toBe(2);
    expect(h.collected).toEqual([]);
    expect(h.inventory.countItem(BlockId.Stone)).toBe(MAX_STACK_SIZE);
  });

  it('部分放入背包时只把成功的那部分算作拾取', () => {
    const h = harness({ size: 1 });
    h.inventory.setSlot(0, { item: BlockId.Stone, count: MAX_STACK_SIZE - 1 });
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.player.x = 0.5;
    h.player.y = 1.2;
    h.player.z = 0.5;

    h.system.update(1);

    expect(h.collected).toEqual([{ item: BlockId.Stone, count: 1 }]);
    expect(h.system.entities[0]?.count).toBe(1);
  });

  it('clear 清空全部掉落物', () => {
    const h = harness();
    h.bus.emit('block:broken', { x: 0, y: 1, z: 0, block: BlockId.Stone });
    h.system.clear();
    expect(h.system.count).toBe(0);
  });
});
