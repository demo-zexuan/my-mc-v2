import { PNG } from 'pngjs';

/**
 * Screenshot analysis helpers.
 *
 * I. Why the suite analyses pixels instead of only asserting on the DOM
 *
 * 1. Every failure mode that matters for a renderer is invisible to the DOM: an
 *    all-black canvas, a camera looking at nothing, a shader that compiled but
 *    outputs a flat colour, a texture that failed to upload. All of them leave a
 *    perfectly valid DOM behind.
 * 2. Decoding the screenshot inside the test turns "the game looks right" into
 *    a machine-checkable property, so a regression is caught by CI instead of by
 *    a human opening the page.
 *
 * The thresholds are deliberately loose. The goal is to catch a blank or
 * grossly wrong frame, not to pin exact colours, which would make the suite
 * fail on a legitimate art change or on a different GPU's interpolation.
 *
 * @module tests/e2e/support/image
 */

/** Decoded screenshot with random access to pixels. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** RGBA components at the given pixel; the image must not be empty. */
  pixel(x: number, y: number): { r: number; g: number; b: number; a: number };
}

/** Rectangular area defined in fractions of the image size. */
export interface Region {
  readonly name: string;
  /** Left edge, `0..1`. */
  readonly x: number;
  /** Top edge, `0..1`. */
  readonly y: number;
  /** Width, `0..1`. */
  readonly width: number;
  /** Height, `0..1`. */
  readonly height: number;
}

/** Average colour of a region. */
export interface RegionStatistics {
  readonly name: string;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Per-channel standard deviation; a flat fill has values near zero. */
  readonly spread: number;
}

/**
 * Decodes a PNG buffer produced by `page.screenshot()`.
 *
 * @param buffer - PNG bytes.
 * @returns Random access image wrapper.
 */
export function decodeScreenshot(buffer: Buffer): DecodedImage {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;

  if (width === 0 || height === 0) {
    throw new Error('screenshot decoded to an empty image');
  }

  const pixelAt = (x: number, y: number): { r: number; g: number; b: number; a: number } => {
    const clampedX = Math.min(width - 1, Math.max(0, Math.trunc(x)));
    const clampedY = Math.min(height - 1, Math.max(0, Math.trunc(y)));
    const offset = (clampedY * width + clampedX) * 4;
    return {
      r: data[offset] ?? 0,
      g: data[offset + 1] ?? 0,
      b: data[offset + 2] ?? 0,
      a: data[offset + 3] ?? 0,
    };
  };

  return { width, height, pixel: pixelAt };
}

/**
 * Computes the average colour and the per-channel spread of a region.
 *
 * @param image - Decoded screenshot.
 * @param region - Normalised region to sample.
 * @param sampleStep - Pixel stride; sampling every pixel is unnecessary for an
 *        average and makes the test noticeably slower.
 * @returns Region statistics.
 */
export function analyseRegion(
  image: DecodedImage,
  region: Region,
  sampleStep = 2,
): RegionStatistics {
  const x0 = Math.trunc(region.x * image.width);
  const y0 = Math.trunc(region.y * image.height);
  const x1 = Math.trunc((region.x + region.width) * image.width);
  const y1 = Math.trunc((region.y + region.height) * image.height);

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumSquares = 0;
  let count = 0;

  for (let y = y0; y < y1; y += sampleStep) {
    for (let x = x0; x < x1; x += sampleStep) {
      const { r, g, b } = image.pixel(x, y);
      sumR += r;
      sumG += g;
      sumB += b;
      sumSquares += r * r + g * g + b * b;
      count += 1;
    }
  }

  if (count === 0) {
    throw new Error(`region "${region.name}" sampled no pixels`);
  }

  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  const meanSquare = sumSquares / count;
  const variance = Math.max(0, meanSquare - (meanR * meanR + meanG * meanG + meanB * meanB));

  return {
    name: region.name,
    r: meanR,
    g: meanG,
    b: meanB,
    spread: Math.sqrt(variance),
  };
}

/**
 * Counts how many distinct colours the image contains, using a coarse bucket.
 *
 * @param image - Decoded screenshot.
 * @param sampleStep - Pixel stride.
 * @returns Number of distinct 5-bit-per-channel colour buckets.
 */
export function countDistinctColours(image: DecodedImage, sampleStep = 3): number {
  const buckets = new Set<number>();
  for (let y = 0; y < image.height; y += sampleStep) {
    for (let x = 0; x < image.width; x += sampleStep) {
      const { r, g, b } = image.pixel(x, y);
      buckets.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
  }
  return buckets.size;
}

/**
 * Returns the share of pixels occupied by the single most common colour bucket.
 *
 * @param image - Decoded screenshot.
 * @param sampleStep - Pixel stride.
 * @returns Fraction in `0..1`; `1` means the frame is a flat fill.
 */
export function dominantColourShare(image: DecodedImage, sampleStep = 3): number {
  const histogram = new Map<number, number>();
  let total = 0;

  for (let y = 0; y < image.height; y += sampleStep) {
    for (let x = 0; x < image.width; x += sampleStep) {
      const { r, g, b } = image.pixel(x, y);
      const bucket = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      histogram.set(bucket, (histogram.get(bucket) ?? 0) + 1);
      total += 1;
    }
  }

  let largest = 0;
  for (const count of histogram.values()) {
    largest = Math.max(largest, count);
  }
  return total === 0 ? 1 : largest / total;
}
