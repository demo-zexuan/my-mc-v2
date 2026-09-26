/**
 * 交互层测试用的最小世界桩。
 *
 * I. 为什么不直接构造真实的 `World`
 *
 * 真实世界需要地形生成器与区块加载，只为验证"放置被拒时背包不扣物品"而引入
 * 一整条生成链，会让交互测试的失败原因变得难以定位。这里用一个显式坐标表
 * 表达"世界里有什么"，并允许注入写入失败，专门覆盖区块未加载这一类分支。
 *
 * @module tests/unit/interaction/fake-world
 */

import { BlockId, isSolid, type BlockId as BlockIdType } from '@/world/BlockRegistry';

/** 记录一次写入。 */
export interface WriteRecord {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly id: BlockIdType;
}

export class FakeWorld {
  /** 显式指定的方块；未指定的位置是空气。 */
  readonly #blocks = new Map<string, BlockIdType>();
  /** 所有写入尝试（含被拒绝的）。 */
  public readonly writes: WriteRecord[] = [];
  /** 置为 `true` 模拟"区块未加载"：`setBlock` 一律返回 `false`。 */
  public rejectWrites = false;

  /** 直接放置一个方块（不记录到 `writes`）。 */
  public set(x: number, y: number, z: number, id: BlockIdType): this {
    this.#blocks.set(key(x, y, z), id);
    return this;
  }

  /** 铺一层方块；用于搭出地面。 */
  public fillLayer(y: number, id: BlockIdType, from = -8, to = 8): this {
    for (let x = from; x <= to; x += 1) {
      for (let z = from; z <= to; z += 1) {
        this.set(x, y, z, id);
      }
    }
    return this;
  }

  public getBlock(x: number, y: number, z: number): BlockIdType {
    return this.#blocks.get(key(x, y, z)) ?? BlockId.Air;
  }

  public setBlock(x: number, y: number, z: number, id: BlockIdType, _recordEdit = true): boolean {
    this.writes.push({ x, y, z, id });
    if (this.rejectWrites) {
      return false;
    }
    this.#blocks.set(key(x, y, z), id);
    return true;
  }

  public isSolidAt(x: number, y: number, z: number): boolean {
    return isSolid(this.getBlock(x, y, z));
  }
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}
