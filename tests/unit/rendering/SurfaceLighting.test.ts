import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createEnvironment, type EnvironmentRig } from '@/rendering/Environment';
import { DayNightCycle, Sky } from '@/rendering/Sky';

/**
 * 光照下限：朝下的面在白天不能是纯黑。
 *
 * I. 这个测试防的是什么回归
 *
 * 1. 真实缺陷：玩家站在树冠下抬头，树叶底面几乎是纯黑（实测最暗处 RGB≈(0,2,0)）。
 *    原因是半球光的贡献按法线方向分配：朝上的面拿天空色，**朝下的面只拿地面色**，
 *    而地面色原来是一个固定的暗棕色；平行光对朝下的面 `dot(N, L) < 0` 完全不贡献，
 *    于是 Lambert 只剩下极弱的一项。
 * 2. 这类缺陷不会让任何断言失败，只会让画面变丑，所以必须把"物理量"本身钉住：
 *    这里复刻 Three.js 的半球光/环境光辐照度公式，算出朝下的面在给定时刻的间接光照，
 *    再乘树叶反照率换回 sRGB，断言它高于一个可见度下限。
 *
 * II. 公式来源
 *
 * 与 `ShaderChunk/lights_pars_begin` 的 `getHemisphereLightIrradiance` 一致：
 * `w = 0.5 * dot(N, up) + 0.5`，`irradiance = mix(groundColor, skyColor, w)`；
 * 灯光颜色在 `WebGLLights` 里已经乘以强度，环境光同理。
 */

/** 树叶贴图的主色，取自 `world/blocks.ts` 的 `TILE.leaves.baseColor`。 */
const LEAF_ALBEDO = new THREE.Color(0x3f7a30);

/** 朝下法线（树叶底面、悬崖内侧）。 */
const DOWN_NORMAL_Y = -1;

/**
 * 计算某个法线方向上的间接光照（线性空间）。
 *
 * @param rig - 光照装置。
 * @param normalY - 法线的 Y 分量；半球光的"上"方向固定为 +Y。
 */
function indirectIrradiance(rig: EnvironmentRig, normalY: number): THREE.Color {
  const weight = 0.5 * normalY + 0.5;
  const sky = rig.hemisphereLight.color.clone().multiplyScalar(rig.hemisphereLight.intensity);
  const ground = rig.hemisphereLight.groundColor
    .clone()
    .multiplyScalar(rig.hemisphereLight.intensity);
  const ambient = rig.ambientLight.color.clone().multiplyScalar(rig.ambientLight.intensity);

  return ground
    .multiplyScalar(1 - weight)
    .add(sky.multiplyScalar(weight))
    .add(ambient);
}

/** 反照率 × 辐照度再回到 sRGB，得到玩家实际看到的颜色。 */
function reflectedSrgb(rig: EnvironmentRig, normalY: number, albedo: THREE.Color): THREE.Color {
  return indirectIrradiance(rig, normalY).multiply(albedo).convertLinearToSRGB();
}

function createScene(startTime: number): {
  scene: THREE.Scene;
  sky: Sky;
  rig: EnvironmentRig;
  cycle: DayNightCycle;
} {
  const scene = new THREE.Scene();
  const rig = createEnvironment(scene);
  const cycle = new DayNightCycle({ dayLengthSeconds: 1200, startTime });
  const sky = new Sky(scene, { cycle, radius: 200 });
  return { scene, sky, rig, cycle };
}

describe('朝下的面在白天仍有光照（树叶底面不是黑的）', () => {
  it('正午朝下的树叶底面读作可辨认的深绿', () => {
    const { sky, rig, cycle } = createScene(0.5);
    cycle.setTime(0.5);
    sky.syncEnvironment(rig);

    const down = reflectedSrgb(rig, DOWN_NORMAL_Y, LEAF_ALBEDO);
    const luminance = 0.2126 * down.r + 0.7152 * down.g + 0.0722 * down.b;

    expect(luminance).toBeGreaterThan(0.1);
    // 仍然是绿色：环境光没有把树叶洗成灰。
    expect(down.g).toBeGreaterThan(down.r);
    expect(down.g).toBeGreaterThan(down.b);
    // 但也不能亮到失去"树荫"的感觉。
    expect(luminance).toBeLessThan(0.55);

    sky.dispose();
    rig.dispose();
  });

  it('平行光对朝下的面没有贡献，所以必须靠环境项兜底', () => {
    const { sky, rig, cycle } = createScene(0.5);
    cycle.setTime(0.5);
    sky.syncEnvironment(rig);

    // 正午太阳在正上方：朝下的面 dot(N, L) = -1，直射项为 0。
    const downNormal = new THREE.Vector3(0, DOWN_NORMAL_Y, 0);
    const sunDirection = rig.sunLight.position.clone().normalize();
    expect(downNormal.dot(sunDirection)).toBeLessThan(0);

    // 环境项必须为正，否则该面就是纯黑。
    const irradiance = indirectIrradiance(rig, DOWN_NORMAL_Y);
    expect(irradiance.r + irradiance.g + irradiance.b).toBeGreaterThan(0);

    // 朝上的面（草地）明显比朝下的面亮，明暗对比依然存在。
    const up = reflectedSrgb(rig, 1, LEAF_ALBEDO);
    const upLuminance = 0.2126 * up.r + 0.7152 * up.g + 0.0722 * up.b;
    const down = reflectedSrgb(rig, DOWN_NORMAL_Y, LEAF_ALBEDO);
    const downLuminance = 0.2126 * down.r + 0.7152 * down.g + 0.0722 * down.b;
    expect(upLuminance).toBeGreaterThan(downLuminance * 1.3);

    sky.dispose();
    rig.dispose();
  });

  it('每个昼夜相位都保持非零下限', () => {
    const { sky, rig, cycle } = createScene(0);
    const samples: string[] = [];

    for (let step = 0; step < 24; step += 1) {
      cycle.setTime(step / 24);
      sky.syncEnvironment(rig);

      const down = reflectedSrgb(rig, DOWN_NORMAL_Y, LEAF_ALBEDO);
      const luminance = 0.2126 * down.r + 0.7152 * down.g + 0.0722 * down.b;
      samples.push(`${cycle.phase} ${(step / 24).toFixed(2)} lum=${luminance.toFixed(3)}`);

      // 任何时刻都不允许出现纯黑；夜晚只是更暗。修复前正午这里只有约 0.006，
      // 与"树冠底面 RGB≈(0,2,0)"的实际观测一致。
      expect(luminance).toBeGreaterThan(0.001);
    }

    // 正午应当明显亮于午夜（昼夜确实在起作用）。
    const noon = reflectedSrgb(rig, DOWN_NORMAL_Y, LEAF_ALBEDO);
    cycle.setTime(0.5);
    sky.syncEnvironment(rig);
    const noonLuminance =
      0.2126 * reflectedSrgb(rig, DOWN_NORMAL_Y, LEAF_ALBEDO).r +
      0.7152 * reflectedSrgb(rig, DOWN_NORMAL_Y, LEAF_ALBEDO).g +
      0.0722 * reflectedSrgb(rig, DOWN_NORMAL_Y, LEAF_ALBEDO).b;

    cycle.setTime(0);
    sky.syncEnvironment(rig);
    const midnightColor = reflectedSrgb(rig, DOWN_NORMAL_Y, LEAF_ALBEDO);
    const midnightLuminance =
      0.2126 * midnightColor.r + 0.7152 * midnightColor.g + 0.0722 * midnightColor.b;

    expect(noonLuminance).toBeGreaterThan(midnightLuminance * 1.5);
    expect(samples.length).toBe(24);
    expect(noon.g).toBeGreaterThanOrEqual(0);

    sky.dispose();
    rig.dispose();
  });

  it('环境光由光照装置提供，并在 dispose 时移除', () => {
    const scene = new THREE.Scene();
    const rig = createEnvironment(scene);

    expect(rig.ambientLight).toBeInstanceOf(THREE.AmbientLight);
    expect(scene.getObjectByName('environment:ambient')).toBe(rig.ambientLight);

    rig.dispose();
    expect(scene.children).toHaveLength(0);
  });
});
