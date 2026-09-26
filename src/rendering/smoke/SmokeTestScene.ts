/**
 * Engine smoke test scene.
 *
 * I. Purpose
 *
 * This module is the Phase 0 acceptance artefact: it proves that the whole
 * toolchain (TypeScript, Vite, Three.js, the GL context, the texture upload
 * path, the shadow pipeline and the fixed-step loop) works end to end before any
 * voxel code exists.
 *
 * II. Lifetime
 *
 * It is deleted in Phase 2, when `WorldRenderer` replaces it. Keeping it in a
 * clearly namespaced folder (`rendering/smoke`) makes that removal mechanical and
 * prevents it from quietly becoming part of the shipped architecture.
 *
 * @module rendering/smoke/SmokeTestScene
 */

import * as THREE from 'three';

import { createEnvironment, type EnvironmentRig } from '@/rendering/Environment';
import { createCheckerTexture } from '@/rendering/textures/procedural';

/** Update surface the game loop drives. */
export interface SmokeTestScene {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Advances animations; `deltaSeconds` is wall-clock, not a fixed step. */
  update(deltaSeconds: number): void;
  dispose(): void;
}

export interface SmokeTestSceneOptions {
  /** Renders the scene in wireframe instead of shaded triangles. */
  readonly wireframe?: boolean;
}

/**
 * Builds a self-contained scene with lights, a shadow receiver and a rotating
 * textured cube.
 *
 * @param options - Visual toggles used by the debug overlay.
 * @returns The scene, its camera and a disposer.
 */
export function createSmokeTestScene(options: SmokeTestSceneOptions = {}): SmokeTestScene {
  const scene = new THREE.Scene();
  scene.name = 'smoke-test-scene';

  // A horizon-ish background is enough for the smoke test; the real sky shader
  // arrives with the day/night system.
  scene.background = new THREE.Color(0x87a7c7);
  scene.fog = new THREE.Fog(0x87a7c7, 60, 220);

  const camera = new THREE.PerspectiveCamera(
    72,
    window.innerWidth / Math.max(1, window.innerHeight),
    0.1,
    1000,
  );
  camera.name = 'smoke-test-camera';
  camera.position.set(4.5, 4.0, 7.5);
  camera.lookAt(0, 1, 0);

  const environment: EnvironmentRig = createEnvironment(scene, { shadowExtent: 40 });

  const checkerTexture = createCheckerTexture({ size: 128, cells: 8 });
  checkerTexture.repeat.set(16, 16);

  // I. Ground: a shadow receiver that also gives the cube a sense of scale.
  const groundGeometry = new THREE.PlaneGeometry(400, 400);
  const groundMaterial = new THREE.MeshStandardMaterial({ map: checkerTexture, roughness: 0.95 });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.name = 'smoke-test-ground';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // II. Cube: sized like one voxel so that the camera framing stays realistic.
  const cubeTexture = createCheckerTexture({
    size: 128,
    cells: 1,
    colorA: 0xd8c48a,
    colorB: 0xd8c48a,
  });
  const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
  const cubeMaterial = new THREE.MeshStandardMaterial({
    map: cubeTexture,
    roughness: 0.8,
    metalness: 0.0,
    wireframe: options.wireframe ?? false,
  });
  const cube = new THREE.Mesh(cubeGeometry, cubeMaterial);
  cube.name = 'smoke-test-cube';
  cube.position.set(0, 1.0, 0);
  cube.castShadow = true;
  cube.receiveShadow = true;
  scene.add(cube);

  let disposed = false;
  return {
    scene,
    camera,
    update: (deltaSeconds: number): void => {
      cube.rotation.y += deltaSeconds * 0.6;
      cube.rotation.x = Math.sin(performance.now() / 2400) * 0.15;
    },
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      environment.dispose();
      groundGeometry.dispose();
      groundMaterial.dispose();
      cubeGeometry.dispose();
      cubeMaterial.dispose();
      checkerTexture.dispose();
      cubeTexture.dispose();
      scene.clear();
    },
  };
}
