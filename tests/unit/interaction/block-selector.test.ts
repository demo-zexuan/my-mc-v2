/**
 * `BlockSelector` 单元测试：目标切换必须"恰好一次"地广播。
 */

import { describe, expect, it } from 'vitest';

import { EventBus, type GameEventMap } from '@/engine/events/EventBus';
import { BlockSelector } from '@/interaction/BlockSelector';
import { createHit } from '@/interaction/types';
import { BlockId, type BlockId as BlockIdType } from '@/world/BlockRegistry';

const UP = { x: 0, y: 1, z: 0 };

function collect(bus: EventBus): GameEventMap['mining:target-changed'][] {
  const seen: GameEventMap['mining:target-changed'][] = [];
  bus.on('mining:target-changed', (payload) => {
    seen.push(payload);
  });
  return seen;
}

describe('BlockSelector', () => {
  it('初始没有目标', () => {
    const selector = new BlockSelector(new EventBus());
    expect(selector.current).toBeNull();
    expect(selector.hasTarget).toBe(false);
  });

  it('首次命中广播坐标与方块', () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const selector = new BlockSelector(bus);

    expect(selector.update(createHit(3, 4, 5, BlockId.Stone, UP, 2.5))).toBe(true);
    expect(seen).toEqual([{ x: 3, y: 4, z: 5, block: BlockId.Stone }]);
    expect(selector.hasTarget).toBe(true);
  });

  it('同一目标即使距离变化也不重复广播，但存量数据被刷新', () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const selector = new BlockSelector(bus);

    selector.update(createHit(3, 4, 5, BlockId.Stone, UP, 2.5));
    expect(selector.update(createHit(3, 4, 5, BlockId.Stone, UP, 2.1))).toBe(false);

    expect(seen).toHaveLength(1);
    expect(selector.current?.distance).toBe(2.1);
  });

  it('位置或方块变化时广播', () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const selector = new BlockSelector(bus);

    selector.update(createHit(3, 4, 5, BlockId.Stone, UP, 2.5));
    selector.update(createHit(3, 5, 5, BlockId.Stone, UP, 2.5));
    selector.update(createHit(3, 5, 5, BlockId.Dirt, UP, 2.5));

    expect(seen).toEqual([
      { x: 3, y: 4, z: 5, block: BlockId.Stone },
      { x: 3, y: 5, z: 5, block: BlockId.Stone },
      { x: 3, y: 5, z: 5, block: BlockId.Dirt },
    ]);
  });

  it('目标消失时广播 null，且不会重复广播 null', () => {
    const bus = new EventBus();
    const seen = collect(bus);
    const selector = new BlockSelector(bus);

    selector.update(null);
    expect(seen).toEqual([]);

    selector.update(createHit(1, 2, 3, BlockId.Dirt, UP, 1));
    selector.update(null);
    selector.update(null);
    selector.clear();

    expect(seen).toEqual([{ x: 1, y: 2, z: 3, block: BlockId.Dirt }, null]);
    expect(selector.hasTarget).toBe(false);
  });

  it('复制命中对象：射线实现复用同一结果对象也不会污染 current', () => {
    const selector = new BlockSelector(new EventBus());
    // 刻意用可变对象模拟射线实现复用同一个结果实例。
    const reusable: {
      x: number;
      y: number;
      z: number;
      block: BlockIdType;
      normal: { x: number; y: number; z: number };
      distance: number;
    } = {
      x: 1,
      y: 2,
      z: 3,
      block: BlockId.Stone,
      normal: { x: 0, y: 1, z: 0 },
      distance: 1.5,
    };

    selector.update(reusable);
    reusable.x = 99;
    reusable.block = BlockId.Dirt;

    expect(selector.current?.x).toBe(1);
    expect(selector.current?.block).toBe(BlockId.Stone);
  });
});
