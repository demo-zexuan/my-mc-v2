/**
 * 体素射线检测（Amanatides & Woo 的 DDA 算法）。
 *
 * I. 为什么不能用 `THREE.Raycaster` 逐方块检测
 *
 * 1. 逐方块做法需要为每个候选方块构造 Mesh/Matrix 再调 `intersectObject`，一次
 *    5 格距离的选中检测要遍历上百个方块并产生大量临时对象；而这段代码在玩家
 *    转动视角时每个渲染帧都要跑一次。
 * 2. DDA 直接在体素网格上步进：每次迭代只做几次比较、加法和一次数组读取，
 *    无需分配、无需矩阵运算，复杂度与射线长度成正比（5 格最多约 15 次迭代）。
 *
 * II. 算法要点
 *
 * 1. 射线所处的体素按整数坐标 `floor(origin)` 确定，方向向量决定三个轴的步进方向。
 * 2. 每个轴维护"下一次跨过体素边界所需的射线参数 `tMax`"与"跨一格所需的参数
 *    增量 `tDelta`"；每次取三者中最小者前进一格，前进的轴即为命中面的法线轴。
 * 3. `tMax` 使用**射线参数 t**（单位方向上的距离），因此返回的 `distance` 就是
 *    世界单位距离，无需再除以方向长度。
 *
 * III. 边界情形
 *
 * 1. 方向分量为 0：该轴 `tDelta` 与 `tMax` 均为 `Infinity`，永不被选中。
 * 2. 起点恰好落在体素边界上：边界体素由 `floor` 确定，若射线指向边界外侧，
 *    `tMax` 为 0，第一步就在 `t = 0` 进入相邻体素——这正是"贴着方块表面放置/
 *    破坏"时必须命中的情况，不能靠 `t > 0` 之类的过滤把它丢掉。
 * 3. 射线恰好穿过体素棱/角（两个轴 `tMax` 相等）：比较使用 `<=`，平局时按
 *    X → Y → Z 的优先级让步进。每一步只前进一格且命中距离取两轴共同的 t，
 *    因此不会跳过任何体素，也不会原地死循环（被选中的轴前进后 `tMax` 立即加上
 *    `tDelta`）。
 *
 * @module physics/VoxelRaycast
 */

import { BlockId } from '@/world/BlockRegistry';

import { createVec3, type Vec3 } from './Vec3';

/**
 * 射线检测所需的最小方块查询接口。
 *
 * 只需要 `getBlock`：判定"什么算命中"由 {@link BlockPredicate} 表达，物理层不必
 * 关心方块注册表的语义。
 */
export interface VoxelBlockSource {
  getBlock(x: number, y: number, z: number): number;
}

/**
 * 命中判定谓词。
 *
 * @param blockId - 该体素的方块 id。
 * @param x - 体素 X。
 * @param y - 体素 Y。
 * @param z - 体素 Z。
 * @returns 该体素是否算作命中。
 */
export type BlockPredicate = (blockId: number, x: number, y: number, z: number) => boolean;

/** 默认命中判定：任何非空气方块。 */
export const DEFAULT_BLOCK_PREDICATE: BlockPredicate = (blockId) => blockId !== BlockId.Air;

/** 交互默认触及距离（格），与玩家手臂长度一致。 */
export const DEFAULT_INTERACTION_DISTANCE = 5;

/** 射线检测选项。 */
export interface VoxelRaycastOptions {
  /** 命中判定，默认 {@link DEFAULT_BLOCK_PREDICATE}。 */
  readonly predicate?: BlockPredicate;
  /** 迭代次数上限，防止病态输入导致长时间循环；默认 1024 次。 */
  readonly maxSteps?: number;
}

/** 射线检测结果。 */
export interface VoxelRaycastHit {
  /** 是否命中。为 false 时其余字段只反映射线终点，不可当作命中结果使用。 */
  readonly hit: boolean;
  /** 命中体素的整数坐标（未命中时为射线经过的最后一个体素）。 */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 命中面法线，指向射线来源一侧；未命中时为 `(0, 0, 0)`。 */
  readonly normal: Vec3;
  /** 从起点到命中点（或到最大距离）的世界单位距离。 */
  readonly distance: number;
}

/** 默认迭代上限。 */
const DEFAULT_MAX_STEPS = 1024;

/**
 * 沿射线步进并返回第一个命中的体素。
 *
 * I. 参数约定
 *
 * 1. `direction` 不必归一化；内部会归一化，因此 `maxDistance` 与返回的 `distance`
 *    始终是**世界单位（格）**，而不是步数。
 * 2. 起点所在的体素会先被检测：若玩家头部卡在方块里，`distance` 为 0，法线取与
 *    射线方向最相反的那个轴面。
 * 3. 未命中时返回 `{ hit: false, distance: maxDistance }`，坐标字段仅为调试用途。
 *
 * @param source - 方块查询来源（`World` 结构化满足）。
 * @param origin - 射线起点（通常为相机位置）。
 * @param direction - 射线方向，任意长度。
 * @param maxDistance - 最大触及距离，单位为格。
 * @param options - 命中谓词与迭代上限。
 */
export function raycastVoxels(
  source: VoxelBlockSource,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number = DEFAULT_INTERACTION_DISTANCE,
  options: VoxelRaycastOptions = {},
): VoxelRaycastHit {
  const predicate = options.predicate ?? DEFAULT_BLOCK_PREDICATE;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;

  // I. 方向归一化；长度为 0 或非有限值直接判为未命中。
  const length = Math.sqrt(
    direction.x * direction.x + direction.y * direction.y + direction.z * direction.z,
  );
  if (!(length > 1e-8) || !Number.isFinite(length) || !(maxDistance > 0)) {
    return {
      hit: false,
      x: Math.floor(origin.x),
      y: Math.floor(origin.y),
      z: Math.floor(origin.z),
      normal: createVec3(0, 0, 0),
      distance: 0,
    };
  }
  const dirX = direction.x / length;
  const dirY = direction.y / length;
  const dirZ = direction.z / length;

  // II. 当前体素与三个轴的步进参数。
  // 1. step 用显式比较而不是 Math.sign：后者对 -0 返回 -0，会让 tMax 计算失去意义。
  const stepX = dirX > 0 ? 1 : dirX < 0 ? -1 : 0;
  const stepY = dirY > 0 ? 1 : dirY < 0 ? -1 : 0;
  const stepZ = dirZ > 0 ? 1 : dirZ < 0 ? -1 : 0;

  const tDeltaX = stepX === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dirX);
  const tDeltaY = stepY === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dirY);
  const tDeltaZ = stepZ === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dirZ);

  let voxelX = Math.floor(origin.x);
  let voxelY = Math.floor(origin.y);
  let voxelZ = Math.floor(origin.z);

  let tMaxX = firstBoundaryDistance(origin.x, voxelX, stepX, dirX);
  let tMaxY = firstBoundaryDistance(origin.y, voxelY, stepY, dirY);
  let tMaxZ = firstBoundaryDistance(origin.z, voxelZ, stepZ, dirZ);

  // III. 起点所在体素：命中即 distance = 0。
  if (predicate(source.getBlock(voxelX, voxelY, voxelZ), voxelX, voxelY, voxelZ)) {
    return {
      hit: true,
      x: voxelX,
      y: voxelY,
      z: voxelZ,
      normal: inwardNormalFor(dirX, dirY, dirZ),
      distance: 0,
    };
  }

  // IV. DDA 主循环。
  for (let stepIndex = 0; stepIndex < maxSteps; stepIndex += 1) {
    // 1. 选择参数最小的轴前进一格；平局顺序（X → Y → Z 的比较写法）保证只前进一格。
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;
    let travelled: number;

    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      voxelX += stepX;
      travelled = tMaxX;
      tMaxX += tDeltaX;
      normalX = -stepX;
    } else if (tMaxY <= tMaxZ) {
      voxelY += stepY;
      travelled = tMaxY;
      tMaxY += tDeltaY;
      normalY = -stepY;
    } else {
      voxelZ += stepZ;
      travelled = tMaxZ;
      tMaxZ += tDeltaZ;
      normalZ = -stepZ;
    }

    // 2. 超过最大距离即截断：这一步进入的体素不再判定，否则会出现"隔着 5 格选中"。
    if (travelled > maxDistance) {
      break;
    }

    // 3. 命中判定。
    if (predicate(source.getBlock(voxelX, voxelY, voxelZ), voxelX, voxelY, voxelZ)) {
      return {
        hit: true,
        x: voxelX,
        y: voxelY,
        z: voxelZ,
        normal: createVec3(normalX, normalY, normalZ),
        distance: travelled,
      };
    }
  }

  // V. 未命中：返回终点信息，`hit` 为 false，调用方必须先判断命中。
  return {
    hit: false,
    x: voxelX,
    y: voxelY,
    z: voxelZ,
    normal: createVec3(0, 0, 0),
    distance: maxDistance,
  };
}

/**
 * 起点到该轴上第一个体素边界的射线参数。
 *
 * @param coordinate - 起点在该轴上的坐标。
 * @param voxel - 起点所在体素的整数坐标。
 * @param step - `-1 / 0 / 1`。
 * @param direction - 归一化后的方向分量。
 * @returns 到达边界所需的 t；该轴不步进时为 `Infinity`。
 */
function firstBoundaryDistance(
  coordinate: number,
  voxel: number,
  step: number,
  direction: number,
): number {
  if (step > 0) {
    return (voxel + 1 - coordinate) / direction;
  }
  if (step < 0) {
    return (coordinate - voxel) / -direction;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * 起点已在方块内部时，取与射线方向最相反的那个轴面作为法线。
 *
 * 该情形下"命中面"在几何上是任意的（射线起点就在体素内部），选择主轴面可以让
 * 放置逻辑得到最接近直觉的结果。
 */
function inwardNormalFor(dirX: number, dirY: number, dirZ: number): Vec3 {
  const ax = Math.abs(dirX);
  const ay = Math.abs(dirY);
  const az = Math.abs(dirZ);
  if (ax >= ay && ax >= az) {
    return createVec3(dirX > 0 ? -1 : 1, 0, 0);
  }
  if (ay >= az) {
    return createVec3(0, dirY > 0 ? -1 : 1, 0);
  }
  return createVec3(0, 0, dirZ > 0 ? -1 : 1);
}

/**
 * 由命中结果推导方块的放置位置：命中方块沿法线方向外移一格。
 *
 * @param hit - 射线检测结果。
 * @returns 放置坐标；未命中时返回 `null`。
 */
export function placementPosition(hit: VoxelRaycastHit): Vec3 | null {
  if (!hit.hit) {
    return null;
  }
  return createVec3(hit.x + hit.normal.x, hit.y + hit.normal.y, hit.z + hit.normal.z);
}
