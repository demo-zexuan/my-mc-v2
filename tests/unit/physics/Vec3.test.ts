import { describe, expect, it } from 'vitest';

import {
  addScaledVec3,
  clamp01,
  clampNumber,
  copyVec3,
  createVec3,
  horizontalLengthOf,
  lengthOf,
  lerpVec3,
  moveTowardsHorizontal,
  moveTowardsVec3,
  normalizeVec3,
  setVec3,
} from '@/physics/Vec3';

describe('physics/Vec3', () => {
  it('创建、复制与就地覆盖', () => {
    const vector = createVec3(1, 2, 3);
    expect(vector).toEqual({ x: 1, y: 2, z: 3 });

    const copy = createVec3();
    copyVec3(copy, vector);
    expect(copy).not.toBe(vector);
    expect(copy).toEqual(vector);

    setVec3(copy, 0, 0, 0);
    expect(copy).toEqual({ x: 0, y: 0, z: 0 });
    expect(vector).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('长度与水平长度', () => {
    expect(lengthOf(createVec3(3, 4, 0))).toBe(5);
    expect(horizontalLengthOf(createVec3(3, 100, 4))).toBe(5);
  });

  it('归一化：零向量退化为零向量而不是 NaN', () => {
    const out = createVec3();
    normalizeVec3(out, createVec3(0, 0, 0));
    expect(out).toEqual({ x: 0, y: 0, z: 0 });
    expect(Number.isNaN(out.x)).toBe(false);

    normalizeVec3(out, createVec3(0, 5, 0));
    expect(out).toEqual({ x: 0, y: 1, z: 0 });
  });

  it('moveTowardsVec3 沿差向量限制步长，斜向不会变快', () => {
    const out = createVec3();
    const target = createVec3(3, 4, 0);

    moveTowardsVec3(out, createVec3(0, 0, 0), target, 2.5);
    expect(lengthOf(out)).toBeCloseTo(2.5, 10);
    expect(out.x).toBeCloseTo(1.5, 10);
    expect(out.y).toBeCloseTo(2, 10);

    // 剩余距离小于步长时直接落到目标。
    moveTowardsVec3(out, createVec3(2.9, 0, 0), createVec3(3, 0, 0), 5);
    expect(out).toEqual({ x: 3, y: 0, z: 0 });
  });

  it('moveTowardsHorizontal 只改 X/Z，保留 Y', () => {
    const velocity = createVec3(0, -7, 0);
    moveTowardsHorizontal(velocity, velocity, 4, 0, 1.5);

    expect(velocity.y).toBe(-7);
    expect(velocity.x).toBeCloseTo(1.5, 10);
    expect(velocity.z).toBe(0);

    // 到达目标后精确落到目标速度，不做多余抖动。
    for (let index = 0; index < 20; index += 1) {
      moveTowardsHorizontal(velocity, velocity, 4.317, 0, 1.5);
    }
    expect(velocity.x).toBe(4.317);
  });

  it('addScaledVec3 与 lerpVec3', () => {
    const out = createVec3();
    addScaledVec3(out, createVec3(1, 1, 1), createVec3(2, 0, -2), 0.5);
    expect(out).toEqual({ x: 2, y: 1, z: 0 });

    lerpVec3(out, createVec3(0, 0, 0), createVec3(10, -4, 2), 0.25);
    expect(out).toEqual({ x: 2.5, y: -1, z: 0.5 });
  });

  it('clamp 工具', () => {
    expect(clampNumber(5, 0, 3)).toBe(3);
    expect(clampNumber(-5, 0, 3)).toBe(0);
    expect(clampNumber(2, 0, 3)).toBe(2);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(-0.5)).toBe(0);
  });
});
