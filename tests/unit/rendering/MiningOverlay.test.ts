// @vitest-environment jsdom
import * as THREE from 'three';
import { beforeEach, describe, expect, it } from 'vitest';

import { MiningOverlay } from '@/rendering/MiningOverlay';

/**
 * Deterministic coverage for the mining progress feedback.
 *
 * I. Why this is a unit test rather than a browser assertion
 *
 * The defect this feature fixes was "the player cannot tell that mining is
 * happening". Reproducing it in a browser requires aiming the crosshair at a
 * block, which needs the pointer-lock or drag-to-look path, and dragging with the
 * primary button held also mines — so the harness ends up digging its own target
 * out of reach. Asserting the overlay's own contract is deterministic; the
 * browser suite asserts the observable consequence instead (the world changes and
 * the debug row reports progress).
 */
describe('MiningOverlay', () => {
  let parent: THREE.Scene;

  beforeEach(() => {
    parent = new THREE.Scene();
  });

  it('starts hidden', () => {
    const overlay = new MiningOverlay(parent);

    expect(overlay.visible).toBe(false);
    expect(overlay.object3d.visible).toBe(false);
    overlay.dispose();
  });

  it('follows the block being mined and shows progress', () => {
    const overlay = new MiningOverlay(parent);

    overlay.update({ x: 4, y: 20, z: -7 }, 0.5);

    expect(overlay.visible).toBe(true);
    // A block occupies [x, x + 1), so the overlay centre sits at x + 0.5.
    expect(overlay.object3d.position.x).toBeCloseTo(4.5, 6);
    expect(overlay.object3d.position.y).toBeCloseTo(20.5, 6);
    expect(overlay.object3d.position.z).toBeCloseTo(-6.5, 6);
    expect(overlay.opacity).toBeGreaterThan(0.1);
    overlay.dispose();
  });

  it('darkens monotonically with progress', () => {
    const overlay = new MiningOverlay(parent);

    overlay.update({ x: 0, y: 0, z: 0 }, 0.1);
    const early = overlay.opacity;
    overlay.update({ x: 0, y: 0, z: 0 }, 0.5);
    const middle = overlay.opacity;
    overlay.update({ x: 0, y: 0, z: 0 }, 0.9);
    const late = overlay.opacity;

    expect(early).toBeLessThan(middle);
    expect(middle).toBeLessThan(late);
    // Never fully opaque, so the tile being mined stays readable.
    expect(late).toBeLessThan(0.9);
    overlay.dispose();
  });

  it('keeps the first frames visible instead of imperceptible', () => {
    const overlay = new MiningOverlay(parent);

    // At 1% a proportional opacity would be invisible, and the player would still
    // believe nothing is happening.
    overlay.update({ x: 0, y: 0, z: 0 }, 0.01);

    expect(overlay.opacity).toBeGreaterThan(0.05);
    overlay.dispose();
  });

  it('hides when progress reaches one', () => {
    const overlay = new MiningOverlay(parent);
    overlay.update({ x: 0, y: 0, z: 0 }, 0.5);
    expect(overlay.visible).toBe(true);

    // The break completes before the target disappears, so rendering a fully
    // black block here would flash for one frame.
    overlay.update({ x: 0, y: 0, z: 0 }, 1);

    expect(overlay.visible).toBe(false);
    overlay.dispose();
  });

  it('hides when there is no target', () => {
    const overlay = new MiningOverlay(parent);
    overlay.update({ x: 0, y: 0, z: 0 }, 0.4);

    overlay.update(null, 0);

    expect(overlay.visible).toBe(false);
    overlay.dispose();
  });

  it('never participates in raycasts or shadows', () => {
    const overlay = new MiningOverlay(parent);
    const mesh = overlay.object3d as THREE.Mesh;

    // The overlay wraps the block the player is aiming at; if it were raycastable
    // every subsequent frame would hit the overlay instead of the block.
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
    // The override appends nothing: an overlay that answered raycasts would
    // shadow the block behind it on the very next frame.
    const intersections: THREE.Intersection[] = [];
    mesh.raycast(new THREE.Raycaster(), intersections);
    expect(intersections).toEqual([]);
    overlay.dispose();
  });

  it('releases its resources and detaches from the scene', () => {
    const overlay = new MiningOverlay(parent);
    const mesh = overlay.object3d as THREE.Mesh;

    let geometryDisposed = false;
    let materialDisposed = false;
    mesh.geometry.addEventListener('dispose', () => {
      geometryDisposed = true;
    });
    (mesh.material as THREE.Material).addEventListener('dispose', () => {
      materialDisposed = true;
    });

    overlay.dispose();

    expect(geometryDisposed).toBe(true);
    expect(materialDisposed).toBe(true);
    expect(parent.children).toHaveLength(0);
  });
});
