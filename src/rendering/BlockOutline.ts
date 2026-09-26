/**
 * Block selection outline.
 *
 * I. Why a separate object instead of a material swap
 *
 * The brief requires the player to see which block they are about to break. The
 * two workable techniques are tinting the target block's faces or drawing a wire
 * box around it. Drawing a box wins on two counts:
 *
 * 1. Tinting means re-uploading the chunk's geometry, or giving every chunk a
 *    second material, on every change of target — the target changes whenever the
 *    player moves their head.
 * 2. A wire box is a single small object that is re-positioned, so the cost per
 *    frame is one matrix update rather than a mesh rebuild.
 *
 * II. Why `depthTest` stays enabled
 *
 * Disabling the depth test would make the outline visible through terrain, which
 * reads as a bug: the player would see the edge of a block hidden behind a hill.
 * The outline must be occluded exactly like the block it belongs to.
 *
 * @module rendering/BlockOutline
 */

import * as THREE from 'three';

/** Half-extent offset that keeps the lines from z-fighting with the block faces. */
const SURFACE_OFFSET = 0.002;

export interface BlockOutlineOptions {
  /** Line colour. Defaults to a near-black that reads on every tile in the atlas. */
  readonly color?: number;
}

/**
 * A unit wire cube that follows the block under the crosshair.
 *
 * The geometry is built once and only the transform changes, so switching targets
 * allocates nothing.
 */
export class BlockOutline {
  readonly #object: THREE.LineSegments;
  readonly #geometry: THREE.EdgesGeometry;
  readonly #material: THREE.LineBasicMaterial;
  #visible = false;

  public constructor(parent: THREE.Object3D, options: BlockOutlineOptions = {}) {
    // `EdgesGeometry` on a box yields the twelve cube edges and nothing else:
    // using the box's own wireframe would also draw the two diagonals of every
    // face, which looks wrong on a cube.
    this.#geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.#material = new THREE.LineBasicMaterial({
      color: options.color ?? 0x101418,
      transparent: true,
      opacity: 0.85,
      // The lines sit a hair outside the block faces; without the offset the
      // edges fight with the faces they touch at grazing angles.
      depthTest: true,
      depthWrite: false,
    });

    this.#object = new THREE.LineSegments(this.#geometry, this.#material);
    this.#object.name = 'block-outline';
    this.#object.visible = false;
    // The outline is decoration: it must never be picked up by a raycast or
    // shadow pass.
    this.#object.raycast = () => {};
    this.#object.frustumCulled = true;
    parent.add(this.#object);
  }

  /** True while a block is highlighted. */
  public get visible(): boolean {
    return this.#visible;
  }

  /** The underlying object, exposed for tests. */
  public get object3d(): THREE.Object3D {
    return this.#object;
  }

  /**
   * Moves the outline onto a block, or hides it.
   *
   * @param hit - Block coordinates under the crosshair, or `null` for no target.
   */
  public update(hit: { readonly x: number; readonly y: number; readonly z: number } | null): void {
    if (hit === null) {
      if (this.#visible) {
        this.#object.visible = false;
        this.#visible = false;
      }
      return;
    }

    // A block occupies `[x, x+1)` on each axis, so the centre is at x + 0.5.
    this.#object.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    this.#object.scale.setScalar(1 + SURFACE_OFFSET * 2);

    if (!this.#visible) {
      this.#object.visible = true;
      this.#visible = true;
    }
  }

  /** Releases the GPU resources. */
  public dispose(): void {
    this.#object.removeFromParent();
    this.#geometry.dispose();
    this.#material.dispose();
  }
}
