/**
 * 右键放置方块。
 *
 * I. 为什么所有拒绝条件必须集中在 `canPlace`
 *
 * 放置是这个游戏里唯一"能改变玩家自身处境"的操作：放错一格可能把玩家封死在
 * 石头里，或者把唯一的方块浪费在虚空里。把判定与副作用拆开后，
 * 准星、音效、教程提示都可以调用同一个纯判定（`canPlace`）而不产生副作用，
 * `place` 只是"判定通过 → 写世界 → 扣物品 → 发事件"的薄壳。
 *
 * II. 写世界的顺序
 *
 * 先 `setBlock` 再扣物品。反过来的话，写入失败（区块被卸载、超出世界高度）时
 * 玩家的方块已经被扣掉但世界里什么都没出现——凭空消失比"操作没生效"糟糕得多。
 *
 * @module interaction/BlockInteraction
 */

import type { EventBus } from '@/engine/events/EventBus';
import { isPlaceableBlock } from '@/inventory/ItemRegistry';
import type { Inventory } from '@/inventory/types';
import { BlockId } from '@/world/BlockRegistry';

import {
  boxIntersectsVoxel,
  placementPositionOf,
  type AabbLike,
  type BlockAccessor,
  type InteractionHit,
} from './types';

/** 默认最大交互距离（方块数）。 */
export const DEFAULT_REACH = 5.0;

/** 放置被拒绝的原因。 */
export type PlacementRejection =
  /** 没有瞄准任何方块。 */
  | 'no-target'
  /** 超过最大交互距离（客户端预测被服务端式校验拒绝）。 */
  | 'out-of-range'
  /** 手上没有可放置的物品。 */
  | 'no-item'
  /** 该方块不可放置（水、空气）。 */
  | 'not-placeable'
  /** 目标位置已被非空气方块占据。 */
  | 'obstructed'
  /** 放置后会与玩家包围盒相交（会把自己封住）。 */
  | 'intersects-player'
  /** 世界拒绝写入（区块未加载或超出世界高度）。 */
  | 'world-rejected';

/** 放置判定结果。 */
export type PlacementResult =
  | {
      readonly ok: true;
      /** 放置位置（命中方块 + 法线）。 */
      readonly x: number;
      readonly y: number;
      readonly z: number;
      /** 被放置的方块 id。 */
      readonly block: BlockId;
    }
  | { readonly ok: false; readonly reason: PlacementRejection };

/** 构造参数。 */
export interface BlockInteractionOptions {
  /** 世界读写接口。 */
  readonly world: BlockAccessor;
  /** 事件总线。 */
  readonly bus: EventBus;
  /** 背包；放置的方块来自当前选中槽位，成功后扣掉 1 个。 */
  readonly inventory: Inventory;
  /**
   * 玩家包围盒查询。
   *
   * I. 为什么是回调而不是 AABB 实例
   *
   * 玩家包围盒由物理层持有并每帧更新，交互层只需要"此刻"的值。
   * 传实例会造成对象身份耦合（谁负责更新？交互层缓存了旧位置怎么办？），
   * 回调则永远读到最新值，同时让测试可以随时改变"玩家在哪"。
   */
  readonly getPlayerBox: () => AabbLike;
  /** 最大交互距离，默认 {@link DEFAULT_REACH}。 */
  readonly maxDistance?: number;
}

export class BlockInteraction {
  readonly #world: BlockAccessor;
  readonly #bus: EventBus;
  readonly #inventory: Inventory;
  readonly #getPlayerBox: () => AabbLike;
  readonly #maxDistance: number;

  public constructor(options: BlockInteractionOptions) {
    this.#world = options.world;
    this.#bus = options.bus;
    this.#inventory = options.inventory;
    this.#getPlayerBox = options.getPlayerBox;
    const maxDistance = options.maxDistance ?? DEFAULT_REACH;
    this.#maxDistance =
      Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance : DEFAULT_REACH;
  }

  /** 最大交互距离。 */
  public get maxDistance(): number {
    return this.#maxDistance;
  }

  /**
   * 纯判定：这次放置会不会成功，以及失败原因。
   *
   * I. 判定顺序（先便宜后昂贵，且保证错误原因最贴近玩家直觉）
   *
   * 1. 有没有瞄到方块。
   * 2. 距离是否超限。
   * 3. 手上有没有东西、东西能不能放。
   * 4. 目标格是不是空的。
   * 5. 会不会与玩家相交。
   *
   * @param hit - 本帧命中结果。
   */
  public canPlace(hit: InteractionHit | null): PlacementResult {
    // 1. 没有命中。
    if (hit === null) {
      return { ok: false, reason: 'no-target' };
    }

    // 2. 距离超限。恰好等于上限时允许（"够得着"包含边界）。
    if (!Number.isFinite(hit.distance) || hit.distance > this.#maxDistance) {
      return { ok: false, reason: 'out-of-range' };
    }

    // 3. 手上物品。
    const stack = this.#inventory.selectedStack();
    if (stack === null) {
      return { ok: false, reason: 'no-item' };
    }
    if (!isPlaceableBlock(stack.item)) {
      return { ok: false, reason: 'not-placeable' };
    }

    // 4. 目标位置必须已经被"挖空"，否则会覆盖玩家看到的那一格。
    const target = placementPositionOf(hit);
    const occupied = this.#world.getBlock(target.x, target.y, target.z);
    if (occupied !== BlockId.Air) {
      return { ok: false, reason: 'obstructed' };
    }

    // 5. 不能把自己封住。
    if (boxIntersectsVoxel(this.#getPlayerBox(), target.x, target.y, target.z)) {
      return { ok: false, reason: 'intersects-player' };
    }

    return { ok: true, x: target.x, y: target.y, z: target.z, block: stack.item };
  }

  /**
   * 执行放置。
   *
   * @param hit - 本帧命中结果。
   * @returns 成功时返回放置位置与方块；失败时返回原因，且世界与背包都不变。
   */
  public place(hit: InteractionHit | null): PlacementResult {
    const verdict = this.canPlace(hit);
    if (!verdict.ok) {
      return verdict;
    }

    const changed = this.#world.setBlock(verdict.x, verdict.y, verdict.z, verdict.block);
    if (!changed) {
      return { ok: false, reason: 'world-rejected' };
    }

    this.#inventory.consumeSelected(1);
    this.#bus.emit('block:placed', {
      x: verdict.x,
      y: verdict.y,
      z: verdict.z,
      block: verdict.block,
    });
    return verdict;
  }
}
