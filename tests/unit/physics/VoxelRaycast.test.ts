import { describe, expect, it } from 'vitest';

import { createVec3, type Vec3 } from '@/physics/Vec3';
import {
  placementPosition,
  raycastVoxels,
  type BlockPredicate,
  type VoxelBlockSource,
} from '@/physics/VoxelRaycast';

/** 手写的方块来源：只记录"哪里有方块"，方块 id 由调用方决定。 */
class FakeBlocks implements VoxelBlockSource {
  readonly #blocks = new Map<string, number>();

  public set(x: number, y: number, z: number, id = 1): this {
    this.#blocks.set(`${x},${y},${z}`, id);
    return this;
  }

  public getBlock(x: number, y: number, z: number): number {
    return this.#blocks.get(`${x},${y},${z}`) ?? 0;
  }
}

function direction(x: number, y: number, z: number): Vec3 {
  return createVec3(x, y, z);
}

describe('physics/VoxelRaycast DDA 体素射线', () => {
  it('沿 +X 命中：返回方块坐标、法线与距离', () => {
    const world = new FakeBlocks().set(3, 0, 0);
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5);

    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([3, 0, 0]);
    expect(hit.normal).toEqual({ x: -1, y: 0, z: 0 });
    expect(hit.distance).toBeCloseTo(2.5, 10);
  });

  it('沿 -X 命中时法线指向 +X', () => {
    const world = new FakeBlocks().set(0, 0, 0);
    const hit = raycastVoxels(world, createVec3(3.5, 0.5, 0.5), direction(-1, 0, 0), 5);

    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([0, 0, 0]);
    expect(hit.normal).toEqual({ x: 1, y: 0, z: 0 });
    expect(hit.distance).toBeCloseTo(2.5, 10);
  });

  it('沿 +Y 命中时法线指向 -Y', () => {
    const world = new FakeBlocks().set(0, 4, 0);
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(0, 1, 0), 6);

    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([0, 4, 0]);
    expect(hit.normal).toEqual({ x: 0, y: -1, z: 0 });
    expect(hit.distance).toBeCloseTo(3.5, 10);
  });

  it('沿 -Z 命中时法线指向 +Z', () => {
    const world = new FakeBlocks().set(0, 0, 0);
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 3.5), direction(0, 0, -1), 5);

    expect(hit.hit).toBe(true);
    expect(hit.normal).toEqual({ x: 0, y: 0, z: 1 });
    expect(hit.distance).toBeCloseTo(2.5, 10);
  });

  it('方向向量不必归一化：距离始终以格为单位', () => {
    const world = new FakeBlocks().set(3, 0, 0);
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(7, 0, 0), 5);

    expect(hit.hit).toBe(true);
    expect(hit.distance).toBeCloseTo(2.5, 10);
  });

  it('最大距离截断：超出范围判为未命中', () => {
    const world = new FakeBlocks().set(6, 0, 0);

    const tooFar = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5);
    expect(tooFar.hit).toBe(false);
    expect(tooFar.distance).toBe(5);

    // 恰好落在最大距离上（t = 5.5 进入方块 x = 6）时应当命中：边界取闭区间。
    const exactly = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5.5);
    expect(exactly.hit).toBe(true);
    expect(exactly.distance).toBeCloseTo(5.5, 10);
  });

  it('空世界返回未命中', () => {
    const hit = raycastVoxels(new FakeBlocks(), createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5);

    expect(hit.hit).toBe(false);
    expect(hit.normal).toEqual({ x: 0, y: 0, z: 0 });
    expect(hit.distance).toBe(5);
  });

  it('命中起点所在方块时距离为 0，法线与射线方向相反', () => {
    const world = new FakeBlocks().set(0, 0, 0);
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5);

    expect(hit.hit).toBe(true);
    expect(hit.distance).toBe(0);
    expect(hit.normal).toEqual({ x: -1, y: 0, z: 0 });
  });

  it('起点恰好落在体素边界且方向朝边界外：立即进入相邻体素（t = 0）', () => {
    const world = new FakeBlocks().set(0, 0, 0);
    const hit = raycastVoxels(world, createVec3(1, 0.5, 0.5), direction(-1, 0, 0), 5);

    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([0, 0, 0]);
    expect(hit.distance).toBe(0);
    expect(hit.normal).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('起点落在边界且方向朝内：先走满一整格再跨界', () => {
    const world = new FakeBlocks().set(4, 0, 0);
    const hit = raycastVoxels(world, createVec3(1, 0.5, 0.5), direction(1, 0, 0), 5);

    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([4, 0, 0]);
    // x = 1.0 是体素 1 的最小面，跨过 x = 2 / 3 / 4 分别需要 1 / 2 / 3 格。
    expect(hit.distance).toBeCloseTo(3, 10);
  });

  it('对角线恰好穿过体素棱边时不跳格、不死循环', () => {
    const world = new FakeBlocks().set(1, 0, 1);
    // 方向 (1, 0, 1)：两个轴的边界在同一个 t 上跨过，必须逐格前进。
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 1), 5);

    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([1, 0, 1]);
    expect(hit.distance).toBeCloseTo(Math.SQRT1_2, 10);
    expect(hit.normal).toEqual({ x: 0, y: 0, z: -1 });
  });

  it('第一个命中的方块即为结果，不会穿透到更远的方块', () => {
    const world = new FakeBlocks().set(1, 0, 0).set(3, 0, 0);
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5);

    expect([hit.x, hit.y, hit.z]).toEqual([1, 0, 0]);
    expect(hit.distance).toBeCloseTo(0.5, 10);
  });

  it('自定义谓词可以忽略水等不可交互方块', () => {
    const world = new FakeBlocks().set(1, 0, 0, 5).set(2, 0, 0, 1);
    const onlyStone: BlockPredicate = (blockId) => blockId === 1;

    const withWater = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5);
    expect([withWater.x, withWater.y, withWater.z]).toEqual([1, 0, 0]);

    const ignoringWater = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5, {
      predicate: onlyStone,
    });
    expect([ignoringWater.x, ignoringWater.y, ignoringWater.z]).toEqual([2, 0, 0]);
    expect(ignoringWater.distance).toBeCloseTo(1.5, 10);
  });

  it('零方向或非正的最大距离返回未命中而不是抛错', () => {
    const world = new FakeBlocks().set(1, 0, 0);

    expect(raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(0, 0, 0), 5).hit).toBe(false);
    expect(raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 0).hit).toBe(false);
  });

  it('负坐标区域（floor 语义）同样正确', () => {
    const world = new FakeBlocks().set(-4, 0, -3);
    const hit = raycastVoxels(world, createVec3(-0.5, 0.5, -0.5), direction(-1, 0, -1), 10);

    // 45 度对角线在负坐标区域同样逐格前进（x 与 z 交替递减，平局时先走 X）：
    // (-1,0,-1) → (-2,0,-1) → (-2,0,-2) → (-3,0,-2) → (-3,0,-3) → (-4,0,-3)。
    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([-4, 0, -3]);
    expect(hit.normal).toEqual({ x: 1, y: 0, z: 0 });
    // 从 x = -0.5 走到 x = -4.0 共 3.5 格，45 度方向下参数 t = 3.5 / cos45° = 2.5√2。
    expect(hit.distance).toBeCloseTo(2.5 * Math.SQRT2, 10);
  });

  it('placementPosition 返回沿法线外移一格的坐标', () => {
    const world = new FakeBlocks().set(3, 0, 0);
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0), 5);

    expect(placementPosition(hit)).toEqual({ x: 2, y: 0, z: 0 });
    expect(placementPosition({ ...hit, hit: false })).toBeNull();
  });

  it('斜向射线命中侧面时法线为被穿过的那一面', () => {
    const world = new FakeBlocks().set(2, 0, 1);
    // 接近 +X 方向的斜射线：先跨 x = 1、x = 2，再跨 z = 1 命中 (2, 0, 1) 的 -Z 面。
    const hit = raycastVoxels(world, createVec3(0.5, 0.5, 0.5), direction(1, 0, 0.3), 10);

    expect(hit.hit).toBe(true);
    expect([hit.x, hit.y, hit.z]).toEqual([2, 0, 1]);
    expect(hit.normal).toEqual({ x: 0, y: 0, z: -1 });
    expect(hit.distance).toBeCloseTo(0.5 / (0.3 / Math.hypot(1, 0.3)), 10);
  });
});
