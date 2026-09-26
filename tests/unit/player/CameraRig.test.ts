import { describe, expect, it } from 'vitest';
import type { PerspectiveCamera } from 'three';

import { createVec3 } from '@/physics/Vec3';
import { CameraRig, MAX_PITCH, MAX_FOV, MIN_FOV, type RigCamera } from '@/player/CameraRig';

/**
 * 编译期契约检查：真实的 `THREE.PerspectiveCamera` 必须结构化满足 `RigCamera`。
 *
 * 这是"机架不 import Three.js"这一设计的前提。若 Three.js 的 `position.set` /
 * `rotation.set` 签名或 `fov` 类型发生变化，`tsc` 会在这里失败，而不是等到
 * `pnpm run build` 之后由玩家发现视角不动了。
 */
type Assignable<From, To> = From extends To ? true : false;
type Expect<T extends true> = T;
export type ThreeCameraSatisfiesRigCamera = Expect<Assignable<PerspectiveCamera, RigCamera>>;

/**
 * 手写的假相机。
 *
 * `CameraRig` 只要求结构满足 `RigCamera`，而 `THREE.PerspectiveCamera` 天然满足
 * 同一组成员（见上面的编译期断言），因此这里不需要引入 Three.js 运行时就能验证
 * "写进相机的值是否正确"。
 */
class FakeCamera implements RigCamera {
  public readonly position = {
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number): void {
      this.x = x;
      this.y = y;
      this.z = z;
    },
  };

  public readonly rotation = {
    order: 'XYZ',
    x: 0,
    y: 0,
    z: 0,
    set(x: number, y: number, z: number): void {
      this.x = x;
      this.y = y;
      this.z = z;
    },
  };

  public fov = 75;
  public projectionUpdates = 0;

  public updateProjectionMatrix(): void {
    this.projectionUpdates += 1;
  }
}

describe('player/CameraRig', () => {
  it('默认朝向为面向 -Z，默认 FOV 75', () => {
    const rig = new CameraRig();

    expect(rig.yaw).toBe(0);
    expect(rig.pitch).toBe(0);
    expect(rig.fov).toBe(75);

    // 注意：-sin(0) 是 -0，逐分量比较避免把符号零当成不相等。
    const look = rig.lookDirection(createVec3());
    expect(look.x).toBeCloseTo(0, 10);
    expect(look.y).toBeCloseTo(0, 10);
    expect(look.z).toBeCloseTo(-1, 10);
  });

  it('鼠标右移向右转（yaw 减小），上移抬头（pitch 增大）', () => {
    const rig = new CameraRig({ sensitivity: 0.002 });

    rig.applyLook(100, 0);
    expect(rig.yaw).toBeCloseTo(-0.2, 10);

    rig.applyLook(0, -50);
    expect(rig.pitch).toBeCloseTo(0.1, 10);
  });

  it('pitch 严格限制在 ±89°', () => {
    const rig = new CameraRig({ sensitivity: 0.002 });

    rig.applyLook(0, -100000);
    expect(rig.pitch).toBeCloseTo(MAX_PITCH, 10);
    expect(rig.pitch).toBeLessThan(Math.PI / 2);

    rig.applyLook(0, 100000);
    expect(rig.pitch).toBeCloseTo(-MAX_PITCH, 10);

    rig.setPose(0, 10);
    expect(rig.pitch).toBeCloseTo(MAX_PITCH, 10);
  });

  it('开启 Y 轴反转后垂直方向取反', () => {
    const rig = new CameraRig({ sensitivity: 0.002, invertY: true });

    rig.applyLook(0, 10);
    expect(rig.pitch).toBeCloseTo(0.02, 10);

    rig.applyLook(0, -10);
    expect(rig.pitch).toBeCloseTo(0, 10);
  });

  it('yaw 始终包装在 (-π, π]，长时间转圈不会累积精度损失', () => {
    const rig = new CameraRig({ sensitivity: 0.002 });

    rig.applyLook(10000, 0);
    expect(rig.yaw).toBeGreaterThan(-Math.PI);
    expect(rig.yaw).toBeLessThanOrEqual(Math.PI);
  });

  it('忽略非有限输入', () => {
    const rig = new CameraRig({ sensitivity: 0.002 });
    rig.applyLook(Number.NaN, 10);

    expect(rig.yaw).toBe(0);
    expect(rig.pitch).toBe(0);
  });

  it('FOV 被夹紧到安全范围，且只在变化时重建投影矩阵', () => {
    const rig = new CameraRig({ fov: 75 });
    const camera = new FakeCamera();

    rig.applyTo(camera, createVec3(0, 1.62, 0));
    expect(camera.fov).toBe(75);
    expect(camera.projectionUpdates).toBe(0);

    rig.setFov(90);
    rig.applyTo(camera, createVec3(0, 1.62, 0));
    expect(camera.fov).toBe(90);
    expect(camera.projectionUpdates).toBe(1);

    rig.applyTo(camera, createVec3(0, 1.62, 0));
    expect(camera.projectionUpdates).toBe(1);

    rig.setFov(1000);
    expect(rig.fov).toBe(MAX_FOV);
    rig.setFov(-100);
    expect(rig.fov).toBe(MIN_FOV);
  });

  it('applyTo 写入 YXZ 欧拉顺序、朝向与眼睛位置', () => {
    const rig = new CameraRig({ yaw: 0.5, pitch: -0.25 });
    const camera = new FakeCamera();

    rig.applyTo(camera, createVec3(3, 4, 5));

    expect(camera.rotation.order).toBe('YXZ');
    expect(camera.rotation.x).toBeCloseTo(-0.25, 10);
    expect(camera.rotation.y).toBeCloseTo(0.5, 10);
    expect(camera.rotation.z).toBe(0);
    expect(camera.position).toMatchObject({ x: 3, y: 4, z: 5 });
  });

  it('视线方向与水平基向量符合约定', () => {
    const rig = new CameraRig();

    const forwardAtZero = rig.horizontalForward(createVec3());
    expect(forwardAtZero.x).toBeCloseTo(0, 10);
    expect(forwardAtZero.y).toBe(0);
    expect(forwardAtZero.z).toBeCloseTo(-1, 10);

    const rightAtZero = rig.horizontalRight(createVec3());
    expect(rightAtZero.x).toBeCloseTo(1, 10);
    expect(rightAtZero.y).toBe(0);
    expect(rightAtZero.z).toBeCloseTo(0, 10);

    // yaw = +90°：面向 -X，右手方向为 -Z。
    rig.setPose(Math.PI / 2, 0);
    const forward = rig.horizontalForward(createVec3());
    expect(forward.x).toBeCloseTo(-1, 10);
    expect(forward.z).toBeCloseTo(0, 10);

    // 抬头 45°：视线方向 Y 分量为 sin(45°)。
    rig.setPose(0, Math.PI / 4);
    const look = rig.lookDirection(createVec3());
    expect(look.y).toBeCloseTo(Math.SQRT1_2, 10);
    expect(look.z).toBeCloseTo(-Math.SQRT1_2, 10);
  });

  it('走路摇晃：走路时产生偏移，停下后淡出，空中不摇晃', () => {
    const rig = new CameraRig({ viewBobbing: true });
    const dt = 1 / 60;

    for (let step = 0; step < 60; step += 1) {
      rig.updateView(dt, 4.317, true);
    }
    expect(rig.bobAmount).toBeCloseTo(1, 2);
    expect(Math.abs(rig.bobOffset.y)).toBeGreaterThan(0);

    // 空中：幅度淡出到 0。
    for (let step = 0; step < 60; step += 1) {
      rig.updateView(dt, 4.317, false);
    }
    expect(rig.bobAmount).toBe(0);
    // 用绝对值比较：正弦项在幅度为 0 时可能得到 -0。
    expect(Math.abs(rig.bobOffset.y)).toBe(0);
  });

  it('关闭视角摇晃后偏移恒为零', () => {
    const rig = new CameraRig({ viewBobbing: false });

    for (let step = 0; step < 60; step += 1) {
      rig.updateView(1 / 60, 5, true);
    }

    expect(rig.bobAmount).toBe(0);
    expect(rig.bobOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('摇晃偏移叠加在眼睛位置上', () => {
    const rig = new CameraRig({ viewBobbing: true });
    for (let step = 0; step < 30; step += 1) {
      rig.updateView(1 / 60, 4.317, true);
    }

    const camera = new FakeCamera();
    rig.applyTo(camera, createVec3(0, 10, 0));

    expect(camera.position.y).toBeCloseTo(10 + rig.bobOffset.y, 10);
    expect(camera.position.x).toBeCloseTo(rig.bobOffset.x, 10);
  });
});
