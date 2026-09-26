import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createEnvironment, type EnvironmentRig } from '@/rendering/Environment';
import { DayNightCycle, Sky } from '@/rendering/Sky';

/**
 * 天空 / 昼夜 / 光照装置的集成测试。
 *
 * I. 覆盖的真实路径
 *
 * `Sky` + `DayNightCycle` + `Environment`（真实的半球光与平行光）+ `THREE.Scene` 的雾。
 * 断言的是"同一份采样结果驱动的三个子系统保持一致"：天空颜色、平行光方向、雾色。
 *
 * II. 为什么可以脱离 GL
 *
 * `ShaderMaterial`、`SphereGeometry`、`PlaneGeometry` 都是纯数据对象；编译与绘制由
 * 端到端用例覆盖。
 */

/** 安全地取出 uniform 值：`uniforms` 的类型是 `IUniform<any>` 索引签名。 */
function uniformValue<T>(material: THREE.ShaderMaterial, name: string): T | undefined {
  const uniform = material.uniforms[name] as THREE.IUniform<T> | undefined;
  return uniform?.value;
}

function createRig(
  scene: THREE.Scene,
  startTime: number,
): {
  sky: Sky;
  rig: EnvironmentRig;
  cycle: DayNightCycle;
} {
  const rig = createEnvironment(scene);
  const cycle = new DayNightCycle({ dayLengthSeconds: 1200, startTime });
  const sky = new Sky(scene, { cycle, radius: 200, cloudHeight: 150 });
  return { sky, rig, cycle };
}

describe('Sky 场景装配', () => {
  it('包含渐变天穹、太阳、月亮与云层', () => {
    const scene = new THREE.Scene();
    const { sky, rig } = createRig(scene, 0.5);

    const dome = scene.getObjectByName('sky:dome');
    const sun = scene.getObjectByName('sky:sun');
    const moon = scene.getObjectByName('sky:moon');
    const clouds = scene.getObjectByName('sky:clouds');

    expect(dome).toBeInstanceOf(THREE.Mesh);
    expect(sun).toBeInstanceOf(THREE.Mesh);
    expect(moon).toBeInstanceOf(THREE.Mesh);
    expect(clouds).toBeInstanceOf(THREE.Mesh);

    const domeMaterial = (dome as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(domeMaterial).toBeInstanceOf(THREE.ShaderMaterial);
    expect(domeMaterial.side).toBe(THREE.BackSide);
    expect(domeMaterial.transparent).toBe(false);
    expect(domeMaterial.uniforms['uZenithColor']).toBeDefined();
    expect(domeMaterial.uniforms['uSunDirection']).toBeDefined();
    // 天穹必须最先绘制，且不写深度。
    expect(dome?.renderOrder).toBeLessThan(0);
    expect(domeMaterial.depthWrite).toBe(false);

    const cloudMaterial = (clouds as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(cloudMaterial.transparent).toBe(true);
    expect(cloudMaterial.depthWrite).toBe(false);
    expect(cloudMaterial.uniforms['uTime']).toBeDefined();

    sky.dispose();
    rig.dispose();
  });

  it('天穹与日月跟随相机，云层只跟随水平位置', () => {
    const scene = new THREE.Scene();
    const { sky, rig } = createRig(scene, 0.5);

    sky.update(0, new THREE.Vector3(120, 70, -40));

    expect(sky.group.position.toArray()).toEqual([120, 70, -40]);
    expect(sky.cloudGroup.position.toArray()).toEqual([120, 150, -40]);

    sky.dispose();
    rig.dispose();
  });

  it('太阳与月亮位于天穹半径之内', () => {
    const scene = new THREE.Scene();
    const { sky, rig } = createRig(scene, 0.5);

    const sun = scene.getObjectByName('sky:sun');
    const moon = scene.getObjectByName('sky:moon');
    if (sun === undefined || moon === undefined) {
      throw new Error('sky objects missing');
    }

    // 半径 200 < 相机远平面时天穹不会被裁掉；日月必须在半径之内。
    expect(sun.position.length()).toBeLessThan(200);
    expect(moon.position.length()).toBeLessThan(200);

    sky.dispose();
    rig.dispose();
  });
});

describe('Sky 与光照装置联动', () => {
  it('正午平行光垂直向下且强度最大', () => {
    const scene = new THREE.Scene();
    const { sky, rig, cycle } = createRig(scene, 0.5);

    cycle.setTime(0.5);
    sky.syncEnvironment(rig);

    expect(rig.sunLight.position.x).toBeCloseTo(0, 5);
    expect(rig.sunLight.position.y).toBeGreaterThan(170);
    expect(rig.sunLight.position.z).toBeCloseTo(0, 5);
    expect(rig.sunLight.intensity).toBeCloseTo(2.2, 6);
    expect(rig.sunLight.visible).toBe(true);
    expect(rig.hemisphereLight.intensity).toBeCloseTo(0.85, 6);

    sky.dispose();
    rig.dispose();
  });

  it('午夜切换到月亮方向与冷色光', () => {
    const scene = new THREE.Scene();
    const { sky, rig, cycle } = createRig(scene, 0.5);

    cycle.setTime(0);
    sky.syncEnvironment(rig);

    // 太阳在地平线以下 → 平行光改用月亮方向（此时朝上）。
    expect(rig.sunLight.position.y).toBeGreaterThan(0);
    expect(rig.sunLight.intensity).toBeGreaterThan(0.2);
    expect(rig.sunLight.intensity).toBeLessThan(0.3);
    expect(rig.sunLight.color.b).toBeGreaterThan(rig.sunLight.color.r);
    expect(rig.hemisphereLight.intensity).toBeLessThan(0.4);

    sky.dispose();
    rig.dispose();
  });

  it('日出时平行光贴地，且始终指向同一距离', () => {
    const scene = new THREE.Scene();
    const { sky, rig, cycle } = createRig(scene, 0.5);

    cycle.setTime(0.26);
    sky.syncEnvironment(rig);

    const distance = rig.sunLight.position.length();
    expect(distance).toBeCloseTo(180, 4);
    // 高度角很低：垂直分量占方向的极小部分。
    expect(Math.abs(rig.sunLight.position.y) / distance).toBeLessThan(0.1);

    sky.dispose();
    rig.dispose();
  });

  it('一整天里太阳方向始终是单位向量，强度非负', () => {
    const scene = new THREE.Scene();
    const { sky, rig, cycle } = createRig(scene, 0);

    for (let step = 0; step < 24; step += 1) {
      cycle.setTime(step / 24);
      sky.syncEnvironment(rig);

      const direction = rig.sunLight.position.clone().normalize();
      expect(Number.isFinite(direction.x)).toBe(true);
      expect(Math.abs(direction.length() - 1)).toBeLessThan(1e-6);
      expect(rig.sunLight.intensity).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(rig.hemisphereLight.intensity)).toBe(true);
    }

    sky.dispose();
    rig.dispose();
  });
});

describe('Sky 与雾', () => {
  it('雾色随昼夜插值，并与天空状态一致', () => {
    const scene = new THREE.Scene();
    const { sky, rig, cycle } = createRig(scene, 0.5);
    scene.fog = new THREE.Fog(0x000000, 20, 200);

    cycle.setTime(0.5);
    sky.update(0);
    const noonFog = scene.fog.color.clone();
    expect(noonFog.r).toBeCloseTo(cycle.state.fogColor.r, 6);
    expect(noonFog.g).toBeCloseTo(cycle.state.fogColor.g, 6);

    cycle.setTime(0);
    sky.update(0);
    const nightFog = scene.fog.color.clone();
    expect(nightFog.r).not.toBeCloseTo(noonFog.r, 3);
    // 夜晚的雾比正午暗得多。
    expect(nightFog.r + nightFog.g + nightFog.b).toBeLessThan(noonFog.r + noonFog.g + noonFog.b);

    sky.dispose();
    rig.dispose();
  });

  it('没有雾时不会抛错', () => {
    const scene = new THREE.Scene();
    const { sky, rig } = createRig(scene, 0.5);
    scene.fog = null;
    expect(() => sky.update(0.1)).not.toThrow();

    sky.dispose();
    rig.dispose();
  });
});

describe('Sky 时间推进与资源释放', () => {
  it('update 推进时间并刷新云层 uniform', () => {
    const scene = new THREE.Scene();
    const { sky, rig, cycle } = createRig(scene, 0.6);

    const clouds = scene.getObjectByName('sky:clouds');
    if (clouds === undefined) {
      throw new Error('clouds missing');
    }
    const material = (clouds as THREE.Mesh).material as THREE.ShaderMaterial;

    const before = uniformValue<number>(material, 'uTime') ?? 0;
    sky.update(600);
    // 一天 1200 秒，推进半天 → 0.6 + 0.5 = 1.1 → 0.1。
    expect(cycle.timeOfDay).toBeCloseTo(0.1, 6);
    const after = uniformValue<number>(material, 'uTime') ?? 0;
    expect(after).toBeGreaterThan(before);

    sky.dispose();
    rig.dispose();
  });

  it('dispose 释放几何体并把天空移出场景', () => {
    const scene = new THREE.Scene();
    const { sky, rig } = createRig(scene, 0.5);
    const dome = scene.getObjectByName('sky:dome');
    if (dome === undefined) {
      throw new Error('dome missing');
    }

    const geometry = (dome as THREE.Mesh).geometry;
    let disposed = false;
    geometry.addEventListener('dispose', () => {
      disposed = true;
    });

    sky.dispose();

    expect(disposed).toBe(true);
    expect(scene.getObjectByName('sky:dome')).toBeUndefined();
    expect(scene.getObjectByName('sky:sun')).toBeUndefined();
    expect(scene.getObjectByName('sky:clouds')).toBeUndefined();

    // 释放两次是安全的。
    expect(() => sky.dispose()).not.toThrow();

    rig.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
