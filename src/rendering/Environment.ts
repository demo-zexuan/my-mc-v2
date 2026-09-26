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

  scene.add(hemisphereLight, sunLight, target);

  return {
    hemisphereLight,
    sunLight,
    dispose: (): void => {
      hemisphereLight.removeFromParent();
      sunLight.removeFromParent();
      target.removeFromParent();
      sunLight.shadow.dispose();
    },
  };
}
