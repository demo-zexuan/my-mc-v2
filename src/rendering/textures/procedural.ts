/**
 * Procedurally generated textures.
 *
 * I. Why textures are generated at runtime instead of shipped as PNGs
 *
 * 1. The block atlas needs dozens of 16x16 tiles. Shipping a binary atlas
 *    makes every texture tweak a binary diff and requires an art pipeline that
 *    does not exist for this project.
 * 2. A deterministic generator keeps the repository small, removes any asset
 *    licensing question, and — most importantly — makes the atlas visually
 *    consistent because every tile shares the same noise function and palette.
 * 3. The same code path can later bake the atlas inside a Web Worker and
 *    transfer it as an `ImageBitmap`, so the main thread never blocks.
 *
 * @module rendering/textures/procedural
 */

import * as THREE from 'three';

/** Options for {@link createCheckerTexture}. */
export interface CheckerTextureOptions {
  /** Edge length of the square texture in pixels. */
  readonly size?: number;
  /** Number of checker cells along one axis. */
  readonly cells?: number;
  /** Colour of the first checker cell, as a hex number. */
  readonly colorA?: number;
  /** Colour of the second checker cell, as a hex number. */
  readonly colorB?: number;
}

/**
 * Draws a checkerboard into an offscreen canvas and wraps it as a texture.
 *
 * Used by the engine smoke test to prove that the texture upload path, the
 * colour space conversion and the mipmap chain all work before any world code
 * exists.
 *
 * @param options - Texture geometry and colours.
 * @returns A colour texture with nearest-neighbour filtering, matching the
 *          crisp look expected of a voxel game.
 */
export function createCheckerTexture(options: CheckerTextureOptions = {}): THREE.CanvasTexture {
  const size = options.size ?? 128;
  const cells = options.cells ?? 8;
  const colorA = options.colorA ?? 0x8fbf5f;
  const colorB = options.colorB ?? 0x6f9c47;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('2D canvas context is unavailable; cannot generate textures.');
  }

  const cellSize = size / cells;
  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      context.fillStyle = (x + y) % 2 === 0 ? `#${colorA.toString(16)}` : `#${colorB.toString(16)}`;
      context.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  // Nearest filtering is deliberate: voxel art loses its identity the moment
  // bilinear filtering smears a 16x16 tile.
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
