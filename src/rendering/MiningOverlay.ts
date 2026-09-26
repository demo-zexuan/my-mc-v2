/**
 * Mining progress overlay.
 *
 * I. Why this exists
 *
 * Block breaking worked, but nothing on screen said so. A player holding the
 * button saw a static outline, and if the target was stone (1.5 s of mining) they
 * concluded the feature was broken. The project brief asks for visible mining
 * progress, and the absence of it turned a working feature into a reported bug —
 * the worst kind of defect, because no test can catch "it feels broken".
 *
 * II. Why a darkening cube rather than a crack texture
 *
 * A crack texture is the familiar Minecraft look, but it means six more tiles in
 * the atlas plus UV bookkeeping per face. A translucent box that darkens as the
 * timer runs reads just as clearly at a fraction of the complexity, and it needs
 * no atlas space. The outline stays visible on top of it, so the player can see
 * both *what* is targeted and *how far along* the break is.
 *
 * III. Cost
 *
 * One mesh, one material, one transform update per frame. The material is shared
 * so changing opacity does not touch the geometry.
 *
 * @module rendering/MiningOverlay
 */

import * as THREE from 'three';

/**
 * Growth applied to the box so it does not z-fight with the faces it wraps.
 *
 * The outline uses a smaller offset; keeping the overlay slightly larger means the
 * two never trade places at grazing angles.
 */
const SURFACE_OFFSET = 0.004;

/** Opacity at a fully mined block. Deliberately short of 1 so the tile stays readable. */
const MAX_OPACITY = 0.72;

export interface MiningOverlayOptions {
  /** Overlay colour. Defaults to near-black, which darkens any tile in the atlas. */
  readonly color?: number;
}

/**
 * Draws the block currently being mined, darkening as progress advances.
 */
export class MiningOverlay {
  readonly #object: THREE.Mesh;
  readonly #geometry: THREE.BoxGeometry;
  readonly #material: THREE.MeshBasicMaterial;
  #visible = false;
  #lastProgress = -1;

  public constructor(parent: THREE.Object3D, options: MiningOverlayOptions = {}) {
    this.#geometry = new THREE.BoxGeometry(1, 1, 1);
    this.#material = new THREE.MeshBasicMaterial({
      color: options.color ?? 0x000000,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // The surface being mined is exactly the surface this box covers, so the
      // depth test has to stay on and the polygon offset has to push the box
      // slightly towards the camera.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.#object = new THREE.Mesh(this.#geometry, this.#material);
    this.#object.name = 'mining-overlay';
    this.#object.visible = false;
    // Decoration only: never raycast against it, never let it cast a shadow.
    this.#object.raycast = () => {};
    this.#object.castShadow = false;
    this.#object.receiveShadow = false;
    parent.add(this.#object);
  }

  /** True while a break is in progress. */
  public get visible(): boolean {
    return this.#visible;
  }

  /** The underlying object, exposed for tests. */
  public get object3d(): THREE.Object3D {
    return this.#object;
  }

  /** Current opacity, exposed for tests. */
  public get opacity(): number {
    return this.#material.opacity;
  }

  /**
   * Follows the mining state.
   *
   * @param target - Block being mined, or `null` when nothing is being mined.
   * @param progress - Break progress in `0..1`.
   */
  public update(
    target: { readonly x: number; readonly y: number; readonly z: number } | null,
    progress: number,
  ): void {
    // A break that has just completed reports `progress === 1` for one step before
    // the target disappears; showing a fully black block there would flash.
    const active = target !== null && progress > 0 && progress < 1;

    if (!active) {
      if (this.#visible) {
        this.#object.visible = false;
        this.#visible = false;
        this.#lastProgress = -1;
      }
      return;
    }

    if (progress !== this.#lastProgress) {
      this.#lastProgress = progress;
      // A floor keeps the very first frames visible: at 2% the block would
      // otherwise darken by an imperceptible amount and the player would still
      // think nothing is happening.
      this.#material.opacity = MAX_OPACITY * Math.max(0.12, progress);
    }

    this.#object.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5);
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
