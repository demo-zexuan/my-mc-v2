import { describe, expect, it } from 'vitest';

import {
  bodyBounds,
  boundsIntersectBlock,
  isInsideSolid,
  isOnGround,
  moveBody,
  resolveOverlap,
  type CollisionBody,
  type SolidWorld,
} from '@/physics/AABB';
import { createVec3, type Vec3 } from '@/physics/Vec3';

/**
 * 手写的最小假世界。
 *
 * I. 为什么不复用 `World`
 *
 * 1. 碰撞求解只依赖 `isSolidAt`，用真实的 `World` 还要构造生成器与区块，测试的
 *    失败原因会被噪声掩盖。
 * 2. `y < 0` 返回实体方块与 `World.getBlock` 的语义一致（世界底部之下视为基岩），
 *    因此"玩家不会从世界底部掉出去"这一行为在假世界里同样被覆盖。
 */
class FakeWorld implements SolidWorld {
  readonly #blocks = new Set<string>();

  public set(x: number, y: number, z: number): this {
    this.#blocks.add(`${x},${y},${z}`);
    return this;
  }

  public fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): this {
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let z = z0; z <= z1; z += 1) {
          this.set(x, y, z);
        }
      }
    }
    return this;
  }

  public isSolidAt(x: number, y: number, z: number): boolean {
    if (y < 0) {
      return true;
    }
    return this.#blocks.has(`${x},${y},${z}`);
  }
}

/** 玩家尺寸：0.6 x 1.8 x 0.6。 */
const HALF_WIDTH = 0.3;
const HEIGHT = 1.8;
/** 步行速度下的单步位移（4.317 格/秒 ÷ 60）。 */
const WALK_STEP = 4.317 / 60;

function bodyAt(x: number, y: number, z: number): CollisionBody {
  return { position: createVec3(x, y, z), halfWidth: HALF_WIDTH, height: HEIGHT };
}

describe('physics/AABB 逐轴碰撞求解', () => {
  it('落地后停在方块顶面，并连续多步保持完全一致（不抖动）', () => {
    const world = new FakeWorld().fill(-4, 0, -4, 4, 0, 4);
    const body = bodyAt(0.5, 4, 0.5);
    const fall = createVec3(0, -0.14, 0);

    const heights: number[] = [];
    let result = moveBody(world, body, fall);
    for (let step = 0; step < 120; step += 1) {
      result = moveBody(world, { ...body, position: result.position }, fall);
      heights.push(result.position.y);
    }

    expect(result.position.y).toBe(1);
    expect(result.onGround).toBe(true);

    // 最后 60 步（已经落地）的高度必须逐位相同：任何一位的变化都意味着抖动。
    const settled = new Set(heights.slice(-60));
    expect(settled.size).toBe(1);
    expect([...settled]).toEqual([1]);
  });

  it('走向墙壁不会穿透，且停在墙面前一个半宽处', () => {
    const world = new FakeWorld().fill(-4, 0, -4, 4, 0, 4).fill(4, 1, -4, 4, 3, 4);
    const step = createVec3(WALK_STEP, -0.1, 0);

    let position: Vec3 = createVec3(0.5, 1, 0.5);
    let blocked = false;
    for (let index = 0; index < 200; index += 1) {
      const result = moveBody(world, { position, halfWidth: HALF_WIDTH, height: HEIGHT }, step);
      position = result.position;
      blocked = blocked || result.blockedX;
      // 每一步都必须处在自由空间：任何一次重叠都意味着穿透。
      expect(isInsideSolid(world, { position, halfWidth: HALF_WIDTH, height: HEIGHT })).toBe(false);
    }

    expect(blocked).toBe(true);
    expect(position.x).toBe(4 - HALF_WIDTH);
    expect(position.y).toBe(1);
  });

  it('斜向撞进角落时不会被卡住，改变方向后可以正常离开', () => {
    const world = new FakeWorld()
      .fill(-4, 0, -4, 4, 0, 4)
      .fill(4, 1, -4, 4, 3, 4)
      .fill(-4, 1, 4, 4, 3, 4);

    // I. 斜向推进：两个轴都被阻挡，玩家应当贴着角落停下。
    const diagonal = createVec3(WALK_STEP, -0.1, WALK_STEP);
    let position: Vec3 = createVec3(0.5, 1, 0.5);
    for (let index = 0; index < 200; index += 1) {
      position = moveBody(
        world,
        { position, halfWidth: HALF_WIDTH, height: HEIGHT },
        diagonal,
      ).position;
    }
    expect(position.x).toBe(4 - HALF_WIDTH);
    expect(position.z).toBe(4 - HALF_WIDTH);
    expect(isInsideSolid(world, { position, halfWidth: HALF_WIDTH, height: HEIGHT })).toBe(false);

    // II. 只沿 -X 推进：角落不应该锁死任何一条轴。
    for (let index = 0; index < 60; index += 1) {
      position = moveBody(
        world,
        { position, halfWidth: HALF_WIDTH, height: HEIGHT },
        createVec3(-WALK_STEP, -0.1, 0),
      ).position;
    }
    expect(position.x).toBeLessThan(3);
    expect(position.z).toBe(4 - HALF_WIDTH);
  });

  it('单步位移超过 1 格时按子步推进，不会穿过 1 格厚的墙', () => {
    const world = new FakeWorld().fill(-4, 0, -4, 4, 0, 4).fill(3, 1, -4, 3, 3, 4);
    const body = bodyAt(0.5, 1, 0.5);

    // 3 格/步相当于坠落终速下的位移量级；若没有子步切分就会直接穿过去。
    const result = moveBody(world, body, createVec3(3, -0.1, 0));

    expect(result.blockedX).toBe(true);
    expect(result.position.x).toBe(3 - HALF_WIDTH);
  });

  it('即使调用方传入过大的子步长度，也不会穿过薄墙', () => {
    const world = new FakeWorld().fill(-4, 0, -4, 4, 0, 4).fill(3, 1, -4, 3, 3, 4);
    const body = bodyAt(0.5, 1, 0.5);

    // 5 格/段足以跨过整面墙；求解器必须把子步长度夹到 1 格以内。
    const result = moveBody(world, body, createVec3(3, 0, 0), { maxSubStepLength: 5 });

    expect(result.blockedX).toBe(true);
    expect(result.position.x).toBe(3 - HALF_WIDTH);
  });

  it('极细的碰撞体也不会穿墙（负坐标区域同样成立）', () => {
    const world = new FakeWorld().fill(-8, 0, -8, 8, 0, 8).fill(-3, 1, -8, -3, 3, 8);
    const thin: CollisionBody = {
      position: createVec3(-5.5, 1, 0.5),
      halfWidth: 0.05,
      height: 1.8,
    };

    // 单次 2.6 格的位移足以跨过 1 格厚的墙；不切分就会穿过去。
    const result = moveBody(world, thin, createVec3(2.6, 0, 0));

    expect(result.blockedX).toBe(true);
    expect(result.position.x).toBeCloseTo(-3 - 0.05, 10);
  });

  it('卡在方块里时沿最小穿透轴推出（向上）', () => {
    const world = new FakeWorld().fill(-4, 0, -4, 4, 0, 4);
    // 脚底在顶面下方 0.06 格：最小穿透方向是向上。
    const body = bodyAt(0.5, 0.94, 0.5);

    const pushed = resolveOverlap(world, body);
    expect(pushed).not.toBeNull();
    expect(pushed?.y).toBe(1);
    expect(isInsideSolid(world, { ...body, position: pushed ?? body.position })).toBe(false);
  });

  it('卡在墙里时沿最小穿透轴推出（水平）', () => {
    const world = new FakeWorld().fill(2, 1, -4, 2, 3, 4);
    // 包围盒最大 X = 2.05，穿进墙面 0.05 格；水平方向的穿透远小于竖直方向。
    const body = bodyAt(1.75, 1, 0.5);

    const pushed = resolveOverlap(world, body);
    expect(pushed).not.toBeNull();
    expect(pushed?.x).toBeCloseTo(2 - HALF_WIDTH, 10);
    expect(pushed?.y).toBeCloseTo(1, 10);
  });

  it('没有重叠时 resolveOverlap 返回 null', () => {
    const world = new FakeWorld().fill(-4, 0, -4, 4, 0, 4);
    expect(resolveOverlap(world, bodyAt(0.5, 1, 0.5))).toBeNull();
  });

  it('撞到天花板时停止上升并报告 hitCeiling', () => {
    const world = new FakeWorld().fill(-4, 0, -4, 4, 0, 4).fill(-4, 4, -4, 4, 4, 4);
    const result = moveBody(world, bodyAt(0.5, 1, 0.5), createVec3(0, 2, 0));

    expect(result.hitCeiling).toBe(true);
    expect(result.blockedY).toBe(true);
    expect(result.position.y).toBe(4 - HEIGHT);
  });

  it('地面探测：贴面判定为着地，悬空 1 厘米判定为不着地', () => {
    const world = new FakeWorld().fill(-4, 0, -4, 4, 0, 4);

    expect(isOnGround(world, bodyAt(0.5, 1, 0.5))).toBe(true);
    expect(isOnGround(world, bodyAt(0.5, 1.01, 0.5))).toBe(false);
    expect(moveBody(world, bodyAt(0.5, 1, 0.5), createVec3(0, 0, 0)).onGround).toBe(true);
    expect(moveBody(world, bodyAt(0.5, 2, 0.5), createVec3(0, 0, 0)).onGround).toBe(false);
  });

  it('世界底部之下视为实体，玩家不会掉出世界', () => {
    const world = new FakeWorld();
    const result = moveBody(world, bodyAt(0.5, 3, 0.5), createVec3(0, -10, 0));

    // y = -1 是实体，其顶面为 y = 0。
    expect(result.position.y).toBe(0);
    expect(result.onGround).toBe(true);
  });

  it('包围盒重叠判定：贴面不算相交，真正进入才算', () => {
    const bounds = bodyBounds(bodyAt(0.5, 1, 0.5));

    expect(boundsIntersectBlock(bounds, 0, 1, 0)).toBe(true);
    // 脚下那一格与包围盒只在 y = 1 处贴面，不构成相交：否则玩家站在地上时
    // 永远"与方块重叠"，放置逻辑会拒绝一切合法操作。
    expect(boundsIntersectBlock(bounds, 0, 0, 0)).toBe(false);
    expect(boundsIntersectBlock(bounds, 0, 3, 0)).toBe(false);
    expect(boundsIntersectBlock(bounds, 1, 1, 0)).toBe(false);
    expect(boundsIntersectBlock(bounds, 0, 1, 1)).toBe(false);
  });
});
