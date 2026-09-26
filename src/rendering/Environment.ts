/**
 * Scene lighting rig.
 *
 * I. Light budget
 *
 * 1. Voxel worlds are lit almost entirely by a sky term and a single sun term.
 *    Adding more punctual lights would blow the per-fragment budget on
 *    integrated GPUs without improving the look, because every surface is
 *    axis-aligned and receives the same two directions.
 * 2. The sun is a directional light whose position is later driven by the
 *    day/night cycle; the shadow camera therefore has to cover the whole loaded
 *    area, which is why its frustum is configured explicitly instead of using
 *    the tiny default.
 *
 * @module rendering/Environment
 */

import * as THREE from 'three';

/** Handles for the lights created by {@link createEnvironment}. */
export interface EnvironmentRig {
  /** Sky/ground ambient term. */
  readonly hemisphereLight: THREE.HemisphereLight;
  /** The single shadow-casting sun/moon light. */
  readonly sunLight: THREE.DirectionalLight;
  /**
   * 与朝向无关的最小环境光。
   *
   * I. 为什么需要它（真实缺陷的直接修复）
   *
   * 1. 半球光的贡献取决于法线方向：朝上的面拿到天空色，朝下的面只拿到地面色。
   *    树叶底面、悬崖内侧、洞穴顶这类"朝下的面"因此只吃到一点点地面反弹，
   *    在 Lambert 下算出来几乎是纯黑——玩家站在树冠下抬头看到的就是一团黑。
   * 2. 现实里的"天光"是经过多次散射的，并不严格按法线方向分布；用一盏很弱的环境光
   *    近似这部分多次散射，就能保证任何朝向的面都还有底色，同时保留平行光的明暗对比。
   * 3. 默认强度为 0：灯光装置本身不改变既有场景的观感，由 `Sky.syncEnvironment()`
   *    按昼夜相位驱动（夜晚自然变暗，而不是永远一个亮度）。
   */
  readonly ambientLight: THREE.AmbientLight;
  /** Detaches every light from its parent and frees GPU-side state. */
  dispose(): void;
}

export interface EnvironmentOptions {
  /** Half-extent of the shadow camera in world units. Defaults to 160. */
  readonly shadowExtent?: number;
}

/**
 * Adds the standard lighting rig to a scene.
 *
 * @param scene - Scene to attach the lights to.
 * @param options - Shadow coverage tuning.
 * @returns Rig handles for later day/night updates.
 */
export function createEnvironment(
  scene: THREE.Scene,
  options: EnvironmentOptions = {},
): EnvironmentRig {
  const extent = options.shadowExtent ?? 160;

  // I. Ambient sky/ground term.
  // 1. The ground colour is a warm brown rather than black: light bouncing off
  //    terrain is the main reason caves look different from the surface.
  const hemisphereLight = new THREE.HemisphereLight(0x9fc6ff, 0x6b5637, 0.85);
  hemisphereLight.name = 'environment:hemisphere';
  hemisphereLight.position.set(0, 1, 0);

  // II. Sun.
  // 1. `target` must be part of the scene graph for the light to look at it;
  //    attaching it explicitly avoids the "light aims at the origin of its own
  //    parent" trap when the rig is later re-parented.
  const sunLight = new THREE.DirectionalLight(0xfff3d6, 2.2);
  sunLight.name = 'environment:sun';
  sunLight.position.set(90, 140, 60);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.bias = -0.0008;
  sunLight.shadow.normalBias = 0.04;

  const shadowCamera = sunLight.shadow.camera;
  shadowCamera.left = -extent;
  shadowCamera.right = extent;
  shadowCamera.top = extent;
  shadowCamera.bottom = -extent;
  shadowCamera.near = 0.5;
  shadowCamera.far = 600;
  shadowCamera.updateProjectionMatrix();

  const target = new THREE.Object3D();
  target.name = 'environment:sun-target';
  sunLight.target = target;

  // III. 最小环境光。
  // 强度默认 0，由 Sky.syncEnvironment() 按昼夜相位驱动，见 EnvironmentRig 的说明。
  const ambientLight = new THREE.AmbientLight(0xffffff, 0);
  ambientLight.name = 'environment:ambient';

  scene.add(hemisphereLight, sunLight, target, ambientLight);

  return {
    hemisphereLight,
    sunLight,
    ambientLight,
    dispose: (): void => {
      hemisphereLight.removeFromParent();
      sunLight.removeFromParent();
      target.removeFromParent();
      ambientLight.removeFromParent();
      sunLight.shadow.dispose();
    },
  };
}
