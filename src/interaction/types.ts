/**
 * 交互层共用的结构化类型。
 *
 * I. 为什么不直接 import 物理层的射线实现
 *
 * 1. 射线检测（`src/physics/VoxelRaycast.ts`）与玩家控制器由并行的另一条工作流开发，
 *    交互层若依赖它的**具体类型**，任何字段改名都会让三个文件同时报错，
 *    并且把"交互逻辑可在没有玩家模块的情况下单测"这一性质彻底破坏。
 * 2. 这里只声明交互真正需要的信息（命中坐标、方块、命中面法线、距离），
 *    装配层做一次显式映射即可。结构化的鸭子类型也让测试可以直接构造命中结果。
 *
 * II. 为什么不 import `src/physics/AABB`
 *
 * 玩家包围盒同理：交互层只需要"当前玩家占哪一块空间"这一个查询，
 * 用回调注入后，交互层既不需要玩家的构造顺序，也不需要在测试里摆一个完整的玩家。
 *
 * @module interaction/types
 */

import type { BlockId } from '@/world/BlockRegistry';

/** 只读三维向量。 */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 可写三维向量；实体内部使用，避免每次积分都分配新对象。 */
export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/** 轴对齐包围盒，供"放置后是否与玩家相交"判定使用。 */
export interface AabbLike {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/**
 * 一次方块命中。
 *
 * I. 坐标语义
 *
 * `x/y/z` 是**方块整数坐标**（不是浮点世界坐标），`normal` 是命中面的外法线
 * （每个分量取值 -1 / 0 / 1），`distance` 是相机到命中点的距离（米/方块）。
 */
export interface InteractionHit {
  /** 命中方块的整数 X。 */
  readonly x: number;
  /** 命中方块的整数 Y。 */
  readonly y: number;
  /** 命中方块的整数 Z。 */
  readonly z: number;
  /** 命中方块的 id。 */
  readonly block: BlockId;
  /** 命中面的外法线。 */
  readonly normal: Vec3Like;
  /** 相机到命中点的距离。 */
  readonly distance: number;
}

/**
 * 交互层需要的最小世界接口。
 *
 * `World`（`src/world/World.ts`）在结构上天然满足这个接口，
 * 因此装配层可以直接把 `World` 实例传进来，不需要适配器。
 */
export interface BlockAccessor {
  /** 读取方块 id。 */
  getBlock(x: number, y: number, z: number): BlockId;
  /** 写入方块 id；返回世界是否真的发生变化。 */
  setBlock(x: number, y: number, z: number, id: BlockId, recordEdit?: boolean): boolean;
  /** 该位置是否有碰撞体积。 */
  isSolidAt(x: number, y: number, z: number): boolean;
}

/**
 * 由命中面法线推出放置位置。
 *
 * 法线分量理论上已经是 -1/0/1，这里仍然取整：射线实现可能返回浮点法线，
 * 而方块坐标必须是整数，否则 `getBlock` 会落在两个方块之间。
 *
 * @param hit - 命中结果。
 * @returns 放置目标的整数坐标。
 */
export function placementPositionOf(hit: InteractionHit): { x: number; y: number; z: number } {
  return {
    x: hit.x + Math.round(hit.normal.x),
    y: hit.y + Math.round(hit.normal.y),
    z: hit.z + Math.round(hit.normal.z),
  };
}

/**
 * 方块体（单位立方体）与包围盒是否相交。
 *
 * I. 为什么用严格不等号
 *
 * 玩家站在方块顶面上时 `box.minY === voxelY + 1`：这是"贴着"而不是"相交"。
 * 用 `<=` 会把站在地面上放脚下的方块也判成自封，玩家永远无法在自己脚下搭方块。
 *
 * @param box - 包围盒。
 * @param x - 方块整数 X。
 * @param y - 方块整数 Y。
 * @param z - 方块整数 Z。
 */
export function boxIntersectsVoxel(box: AabbLike, x: number, y: number, z: number): boolean {
  return (
    box.minX < x + 1 &&
    box.maxX > x &&
    box.minY < y + 1 &&
    box.maxY > y &&
    box.minZ < z + 1 &&
    box.maxZ > z
  );
}

/** 构造一个命中结果，供测试与装配层使用。 */
export function createHit(
  x: number,
  y: number,
  z: number,
  block: BlockId,
  normal: Vec3Like,
  distance: number,
): InteractionHit {
  return { x, y, z, block, normal, distance };
}

/**
 * 把 `{ min, max }` 形式的包围盒转成扁平的 {@link AabbLike}。
 *
 * 物理层的 `AabbBounds` 用嵌套向量表达角点，而交互层只需要六个端点值。
 * 提供一个共享转换函数，避免装配层与测试各自手写一遍、各自写错一次。
 *
 * @param bounds - 角点形式的包围盒。
 */
export function aabbFromBounds(bounds: {
  readonly min: Vec3Like;
  readonly max: Vec3Like;
}): AabbLike {
  return {
    minX: bounds.min.x,
    minY: bounds.min.y,
    minZ: bounds.min.z,
    maxX: bounds.max.x,
    maxY: bounds.max.y,
    maxZ: bounds.max.z,
  };
}
