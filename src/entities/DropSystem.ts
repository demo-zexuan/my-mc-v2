/**
 * 掉落物系统：破坏方块 → 生成掉落 → 落地 → 被玩家捡起。
 *
 * I. 为什么由事件驱动而不是挖掘系统直接调用
 *
 * 除了玩家挖掘，方块还会因为爆炸、水流、其他实体而消失。让每一种原因各自调用
 * "生成掉落物"意味着每加一种破坏方式都要记得加一次调用；订阅 `block:broken`
 * 则让所有破坏来源自动获得一致的掉落行为（并且 `dropOf()` 的映射只存在一处）。
 *
 * II. 为什么在生成时就尝试合并
 *
 * 挖一条矿道会在几秒内产生十几个相邻的掉落物。逐个渲染是浪费，
 * 更糟的是玩家靠近时会出现十几个 `item:collected` 事件刷屏。
 * 生成时把 0.75 格内、同类且不超上限的掉落物合并成一个，成本只有一次线性扫描
 * （实体数量有硬上限），却让事件数量与渲染实例数都降了一个量级。
 *
 * III. 拾取判定为什么是"水平圆 + 垂直容差"而不是球
 *
 * `getPlayerPosition()` 由装配层提供，既可能是脚底也可能是眼睛。
 * 用球体判定的话，眼睛高度（约 1.62）会让玩家脚边的掉落物永远差 0.12 格够不着——
 * 这类"看起来明明踩在上面却捡不起来"的 bug 极难排查。因此水平方向严格用拾取半径，
 * 垂直方向给一个宽松容差，把"玩家位置代表身体哪一点"这件事从判定中去掉。
 *
 * @module entities/DropSystem
 */

import type { EventBus, Unsubscribe } from '@/engine/events/EventBus';
import { MAX_STACK_SIZE, type Inventory } from '@/inventory/types';
import type { Vec3Like } from '@/interaction/types';
import { dropOf, type BlockId } from '@/world/BlockRegistry';

import { ItemEntity, type SolidQuery } from './ItemEntity';

/** 默认拾取半径（水平，方块）。 */
export const DEFAULT_PICKUP_RADIUS = 1.5;

/** 默认垂直拾取容差。 */
export const DEFAULT_PICKUP_VERTICAL_TOLERANCE = 2.0;

/** 默认掉落物数量上限；超过后新的掉落直接被忽略，保证内存有界。 */
export const DEFAULT_MAX_ENTITIES = 256;

/** 生成时尝试合并的半径。 */
export const MERGE_RADIUS = 0.75;

/** 单次物理积分的最长步长（秒）：防止大 dt 时掉落物穿过地面。 */
export const MAX_SUB_STEP = 1 / 30;

/** 构造参数。 */
export interface DropSystemOptions {
  /** 只读世界查询，用于掉落物的重力落地。 */
  readonly world: SolidQuery;
  /** 事件总线：订阅 `block:broken`，发出 `item:collected`。 */
  readonly bus: EventBus;
  /** 背包；拾取时调用 `add()`，返回的剩余量继续留在地上。 */
  readonly inventory: Inventory;
  /** 玩家位置查询（脚底或眼睛均可）。 */
  readonly getPlayerPosition: () => Vec3Like;
  /** 拾取半径（水平），默认 1.5。 */
  readonly pickupRadius?: number;
  /** 垂直拾取容差，默认 2.0。 */
  readonly pickupVerticalTolerance?: number;
  /** 掉落物数量上限，默认 256。 */
  readonly maxEntities?: number;
}

export class DropSystem {
  readonly #world: SolidQuery;
  readonly #bus: EventBus;
  readonly #inventory: Inventory;
  readonly #getPlayerPosition: () => Vec3Like;
  readonly #pickupRadius: number;
  readonly #verticalTolerance: number;
  readonly #maxEntities: number;

  readonly #entities: ItemEntity[] = [];
  #nextId = 1;
  #unsubscribe: Unsubscribe | null = null;

  public constructor(options: DropSystemOptions) {
    this.#world = options.world;
    this.#bus = options.bus;
    this.#inventory = options.inventory;
    this.#getPlayerPosition = options.getPlayerPosition;
    this.#pickupRadius = positiveOr(options.pickupRadius, DEFAULT_PICKUP_RADIUS);
    this.#verticalTolerance = positiveOr(
      options.pickupVerticalTolerance,
      DEFAULT_PICKUP_VERTICAL_TOLERANCE,
    );
    this.#maxEntities = Math.max(
      1,
      Math.floor(positiveOr(options.maxEntities, DEFAULT_MAX_ENTITIES)),
    );

    this.#unsubscribe = options.bus.on('block:broken', (payload) => {
      this.#onBlockBroken(payload.x, payload.y, payload.z, payload.block);
    });
  }

  /** 当前存活的地面掉落物（只读视图，供渲染同步）。 */
  public get entities(): readonly ItemEntity[] {
    return this.#entities;
  }

  /** 当前掉落物数量。 */
  public get count(): number {
    return this.#entities.length;
  }

  /** 拾取半径。 */
  public get pickupRadius(): number {
    return this.#pickupRadius;
  }

  /**
   * 在指定位置生成掉落物。
   *
   * @param item - 物品 id。
   * @param count - 数量，钳制到 `1 .. MAX_STACK_SIZE`。
   * @param position - 生成位置（实体中心）。
   * @returns 生成或合并到的实体；池已满时返回 `null`（调用方无需处理，掉落被丢弃）。
   */
  public spawnDrop(item: BlockId, count: number, position: Vec3Like): ItemEntity | null {
    const merged = this.#tryMerge(item, count, position);
    if (merged !== null) {
      return merged;
    }
    if (this.#entities.length >= this.#maxEntities) {
      return null;
    }

    const id = this.#nextId;
    this.#nextId += 1;
    const entity = new ItemEntity({
      id,
      item,
      count,
      position,
      velocity: popVelocity(id),
    });
    this.#entities.push(entity);
    return entity;
  }

  /**
   * 推进一帧：物理 + 拾取 + 回收。
   *
   * I. 为什么这里要自己分子步
   *
   * 一次卡顿（标签页切回来、区块生成、GC）可能给出 0.3 秒以上的 dt。
   * 单步积分会让掉落物一帧内穿过地面，然后永远掉出世界——
   * 表现为"挖出来的东西过一会儿就不见了"，且只在偶发卡顿时复现。
   * 把 dt 切成不超过 1/30 秒的子步，物理表现与稳定帧率下完全一致。
   *
   * II. 拾取判定只在帧末做一次
   *
   * 子步只负责物理。拾取放在最后，避免同一帧内多次触发 `item:collected`，
   * 也让"这一帧结束时玩家离得够近"成为唯一判定依据。
   *
   * @param deltaSeconds - 距上一帧的秒数。
   */
  public update(deltaSeconds: number): void {
    const total = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    if (total > 0) {
      const substeps = Math.max(1, Math.ceil(total / MAX_SUB_STEP));
      const dt = total / substeps;
      for (let s = 0; s < substeps; s += 1) {
        for (const entity of this.#entities) {
          entity.update(dt, this.#world);
        }
      }
    }

    const player = this.#getPlayerPosition();
    const radiusSquared = this.#pickupRadius * this.#pickupRadius;

    for (const entity of this.#entities) {
      if (!entity.canBePickedUp()) {
        continue;
      }
      if (!isWithinPickupRange(entity, player, radiusSquared, this.#verticalTolerance)) {
        continue;
      }
      this.#pickUp(entity);
    }

    this.#compact();
  }

  /** 移除所有掉落物。 */
  public clear(): void {
    this.#entities.length = 0;
  }

  /** 取消事件订阅并清空。 */
  public dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.clear();
  }

  #onBlockBroken(x: number, y: number, z: number, block: BlockId): void {
    const item = dropOf(block);
    if (item === null) {
      // 玻璃、冰等方块不掉落任何东西。
      return;
    }
    // 生成在方块中心稍上方：既不会立刻与地面相交，又能被玩家看见弹起。
    this.spawnDrop(item, 1, { x: x + 0.5, y: y + 0.35, z: z + 0.5 });
  }

  #pickUp(entity: ItemEntity): void {
    const remaining = this.#inventory.add(entity.item, entity.count);
    const gained = entity.count - remaining;
    if (gained > 0) {
      this.#bus.emit('item:collected', { item: entity.item, count: gained });
    }
    if (remaining <= 0) {
      entity.alive = false;
      return;
    }
    // 背包装不下：剩余量继续留在地上，玩家腾出空间后还能捡。
    entity.count = remaining;
  }

  #tryMerge(item: BlockId, count: number, position: Vec3Like): ItemEntity | null {
    const radiusSquared = MERGE_RADIUS * MERGE_RADIUS;
    const adding = clampCount(count);
    for (const entity of this.#entities) {
      if (!entity.alive || entity.item !== item) {
        continue;
      }
      if (entity.distanceSquaredTo(position) > radiusSquared) {
        continue;
      }
      if (entity.count + adding > MAX_STACK_SIZE) {
        continue;
      }
      entity.count += adding;
      return entity;
    }
    return null;
  }

  /** 就地压缩数组，避免每帧 filter 产生新数组。 */
  #compact(): void {
    let write = 0;
    for (const entity of this.#entities) {
      if (entity.alive) {
        this.#entities[write] = entity;
        write += 1;
      }
    }
    this.#entities.length = write;
  }
}

/**
 * 生成时的初速度。
 *
 * 用 id 推导方向而不是 `Math.random()`：同一个世界状态下重复播放的掉落表现一致，
 * 单元测试也不需要注入随机源。
 */
function popVelocity(id: number): Vec3Like {
  const angle = (id * 2.399963) % (Math.PI * 2);
  return { x: Math.cos(angle) * 0.6, y: 2.4, z: Math.sin(angle) * 0.6 };
}

function isWithinPickupRange(
  entity: ItemEntity,
  player: Vec3Like,
  radiusSquared: number,
  verticalTolerance: number,
): boolean {
  const dx = entity.position.x - player.x;
  const dz = entity.position.z - player.z;
  if (dx * dx + dz * dz > radiusSquared) {
    return false;
  }
  return Math.abs(entity.position.y - player.y) <= verticalTolerance;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * 把任意输入收敛为合法的堆叠数量。
 *
 * `Math.min` / `Math.max` 对 NaN 全部返回 NaN，会让 NaN 顺着合并逻辑污染整个实体，
 * 因此必须先做有限性判断再钳制。
 */
function clampCount(value: number): number {
  const count = Math.floor(value);
  if (!Number.isFinite(count)) {
    return 1;
  }
  return Math.min(MAX_STACK_SIZE, Math.max(1, count));
}
