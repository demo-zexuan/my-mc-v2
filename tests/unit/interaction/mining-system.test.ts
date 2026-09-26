/**
 * `MiningSystem` 单元测试：硬度与进度、目标切换重置、事件与方块移除。
 */

import { describe, expect, it } from 'vitest';

import { EventBus, type GameEventMap } from '@/engine/events/EventBus';
import { MiningSystem } from '@/interaction/MiningSystem';
import { createHit } from '@/interaction/types';
import { BlockId, hardnessOf } from '@/world/BlockRegistry';

import { FakeWorld } from './fake-world';

const UP = { x: 0, y: 1, z: 0 };

interface Harness {
  readonly world: FakeWorld;
  readonly bus: EventBus;
  readonly system: MiningSystem;
  readonly progressEvents: GameEventMap['mining:progress'][];
  readonly brokenEvents: GameEventMap['block:broken'][];
}

function harness(options: { speed?: number } = {}): Harness {
  const world = new FakeWorld();
  const bus = new EventBus();
  const progressEvents: GameEventMap['mining:progress'][] = [];
  const brokenEvents: GameEventMap['block:broken'][] = [];
  bus.on('mining:progress', (payload) => progressEvents.push(payload));
  bus.on('block:broken', (payload) => brokenEvents.push(payload));

  const system = new MiningSystem(
    options.speed === undefined ? { world, bus } : { world, bus, speed: options.speed },
  );
  return { world, bus, system, progressEvents, brokenEvents };
}

describe('MiningSystem 进度与硬度', () => {
  it('进度按 hardness 秒推进', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));

    h.system.tick(0.5, true);
    expect(h.system.progress).toBeCloseTo(0.5 / hardnessOf(BlockId.Stone), 10);
    h.system.tick(0.25, true);
    expect(h.system.progress).toBeCloseTo(0.75 / hardnessOf(BlockId.Stone), 10);
    expect(h.brokenEvents).toHaveLength(0);
  });

  it('每 tick 发一次 mining:progress，且 progress 单调不减、不超过 1', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));

    h.system.tick(0.1, true);
    h.system.tick(0.1, true);
    h.system.tick(0.1, true);

    expect(h.progressEvents).toHaveLength(3);
    const values = h.progressEvents.map((event) => event.progress);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(h.progressEvents[0]).toMatchObject({ x: 0, y: 0, z: 0, block: BlockId.Stone });
  });

  it('累计到硬度秒数时破坏方块并发 block:broken', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));

    // 石头硬度 1.5 秒：三次 0.5 秒恰好到达（用秒数累加避免浮点误差）。
    h.system.tick(0.5, true);
    h.system.tick(0.5, true);
    h.system.tick(0.5, true);

    expect(h.brokenEvents).toEqual([{ x: 0, y: 0, z: 0, block: BlockId.Stone }]);
    expect(h.world.getBlock(0, 0, 0)).toBe(BlockId.Air);
    expect(h.world.writes).toContainEqual({ x: 0, y: 0, z: 0, id: BlockId.Air });
    expect(h.system.progress).toBe(0);
  });

  it('破坏后继续按住不会重复破坏（世界已是空气）', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Dirt);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Dirt, UP, 2));
    h.system.tick(1, true);

    expect(h.brokenEvents).toHaveLength(1);
    h.system.tick(1, true);
    h.system.tick(1, true);
    expect(h.brokenEvents).toHaveLength(1);
    expect(h.progressEvents).toHaveLength(1);
  });

  it('手速倍率缩短所需时间', () => {
    const h = harness({ speed: 3 });
    h.world.set(0, 0, 0, BlockId.Stone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));

    h.system.tick(0.25, true);
    h.system.tick(0.25, true);
    // 0.25 + 0.25 秒 × 3 倍速 = 1.5 秒等效，恰好挖穿 1.5 硬度的石头。
    expect(h.brokenEvents).toHaveLength(1);
    expect(h.system.speed).toBe(3);
    expect(h.system.timeToBreak(BlockId.Stone)).toBeCloseTo(hardnessOf(BlockId.Stone) / 3, 10);
  });

  it('deltaSeconds 非法时不会污染进度', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));

    h.system.tick(Number.NaN, true);
    h.system.tick(-1, true);
    expect(h.system.progress).toBe(0);
    expect(h.brokenEvents).toHaveLength(0);
  });
});

describe('MiningSystem 目标切换与取消', () => {
  it('看向别处立即重置进度', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.world.set(0, 0, 1, BlockId.Cobblestone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));

    h.system.tick(1, true);
    expect(h.system.progress).toBeGreaterThan(0.5);

    expect(h.system.setTarget(createHit(0, 0, 1, BlockId.Cobblestone, UP, 2))).toBe(true);
    expect(h.system.progress).toBe(0);
  });

  it('同一目标重复 setTarget 不清零进度', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));
    h.system.tick(1, true);
    const before = h.system.progress;

    expect(h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 1.5))).toBe(false);
    expect(h.system.progress).toBe(before);
  });

  it('setTarget(null) 与松手都会重置', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));

    h.system.tick(1, true);
    h.system.tick(1 / 60, false);
    expect(h.system.progress).toBe(0);

    h.system.tick(1, true);
    expect(h.system.progress).toBeGreaterThan(0);
    h.system.setTarget(null);
    expect(h.system.progress).toBe(0);
    expect(h.system.target).toBeNull();

    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));
    h.system.tick(1, true);
    h.system.cancel();
    expect(h.system.progress).toBe(0);

    h.system.tick(1, true);
    h.system.reset();
    expect(h.system.progress).toBe(0);
    expect(h.system.target).toBeNull();
  });

  it('没有目标时 tick 什么都不做', () => {
    const h = harness();
    h.system.tick(1, true);
    expect(h.progressEvents).toHaveLength(0);
    expect(h.brokenEvents).toHaveLength(0);
  });
});

describe('MiningSystem 不可破坏与过期目标', () => {
  it('基岩没有任何进度与事件', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Bedrock);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Bedrock, UP, 2));

    h.system.tick(10, true);
    h.system.tick(10, true);

    expect(h.system.progress).toBe(0);
    expect(h.progressEvents).toHaveLength(0);
    expect(h.brokenEvents).toHaveLength(0);
    expect(h.world.getBlock(0, 0, 0)).toBe(BlockId.Bedrock);
    expect(h.system.timeToBreak(BlockId.Bedrock)).toBe(Number.POSITIVE_INFINITY);
  });

  it('世界里的方块已被替换时不推进进度（幽灵挖掘防护）', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Stone);
    h.system.setTarget(createHit(0, 0, 0, BlockId.Stone, UP, 2));
    h.world.set(0, 0, 0, BlockId.Air);

    h.system.tick(1, true);
    expect(h.progressEvents).toHaveLength(0);
    expect(h.brokenEvents).toHaveLength(0);
  });

  it('世界拒绝写入（区块卸载）时不广播 block:broken', () => {
    const h = harness();
    h.world.set(0, 0, 0, BlockId.Dirt);
    h.world.rejectWrites = true;
    h.system.setTarget(createHit(0, 0, 0, BlockId.Dirt, UP, 2));

    h.system.tick(1, true);
    expect(h.brokenEvents).toHaveLength(0);
    expect(h.system.progress).toBe(0);
  });
});
