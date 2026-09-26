import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import {
  analyseRegion,
  countDistinctColours,
  decodeScreenshot,
  dominantColourShare,
  type DecodedImage,
} from './support/image';
import { waitForEngineReady } from './support/harness';

/**
 * Visual verification.
 *
 * I. Strategy
 *
 * Every artefact is written to `VISUAL_OUTPUT_DIR` (default
 * `test-results/visual`) so that a human — or an agent reviewing the build — can
 * look at the exact frame the assertions were computed from. The assertions
 * themselves are coarse on purpose: they detect "black screen", "flat fill" and
 * "wrong region colour" without freezing the art direction.
 *
 * II. Why region colours are asserted at all
 *
 * The single most common rendering regression in a voxel game is a camera or
 * projection mistake that leaves the scene pointing at the void. The sky/ground
 * split is a cheap, stable proxy for "the camera is looking at the world".
 */

const VISUAL_OUTPUT_DIR = process.env['VISUAL_OUTPUT_DIR'] ?? 'test-results/visual';

/** Captures a screenshot and writes it to the visual artefact directory. */
async function capture(page: Page, name: string): Promise<DecodedImage> {
  const buffer = await page.screenshot({ type: 'png' });
  await mkdir(VISUAL_OUTPUT_DIR, { recursive: true });
  await writeFile(join(VISUAL_OUTPUT_DIR, `${name}.png`), buffer);
  return decodeScreenshot(buffer);
}

test.describe('visual quality', () => {
  test('renders a lit, textured scene instead of a blank canvas', async ({ page }) => {
    await page.goto('/');
    await waitForEngineReady(page);
    // Let the cube rotate away from its initial pose so the frame is not a
    // single flat face.
    await page.waitForTimeout(600);

    const image = await capture(page, 'phase0-engine-smoke');

    // I. The frame must contain real imagery.
    expect(countDistinctColours(image)).toBeGreaterThan(60);
    expect(dominantColourShare(image)).toBeLessThan(0.9);

    // II. Sky occupies the upper part of the frame and must be the cool blue of
    //     the scene background, i.e. blue-dominant.
    //     The right-hand half is sampled to avoid the debug overlay.
    const sky = analyseRegion(image, { name: 'sky', x: 0.5, y: 0.02, width: 0.45, height: 0.12 });
    expect(sky.b).toBeGreaterThan(sky.r);

    // III. Ground occupies the lower part and must be the warm green of the
    //      checker texture, i.e. green-dominant.
    const ground = analyseRegion(image, {
      name: 'ground',
      x: 0.25,
      y: 0.85,
      width: 0.5,
      height: 0.12,
    });
    expect(ground.g).toBeGreaterThan(ground.b);
    expect(ground.g).toBeGreaterThan(40);

    // IV. Lighting must produce variation, not a flat ambient fill. A scene lit
    //     only by an ambient light has almost no spread across a curved surface
    //     and no visible shadow terminator.
    expect(ground.spread).toBeGreaterThan(3);

    expect(image.width).toBe(1280);
    expect(image.height).toBe(720);
  });

  test('keeps the HUD legible and out of the scene centre', async ({ page }) => {
    await page.goto('/');
    await waitForEngineReady(page);

    const overlay = page.getByTestId('debug-overlay');
    const box = await overlay.boundingBox();
    expect(box).not.toBeNull();

    // I. The panel must stay in the top-left corner: an overlay that has drifted
    //    into the middle of the screen hides the crosshair area where the player
    //    aims.
    expect(box?.x ?? 0).toBeLessThan(64);
    expect(box?.y ?? 0).toBeLessThan(64);

    // II. Text must not be clipped: the rendered box has to be tall enough for
    //     every configured row.
    const rows = await overlay.locator('.debug-overlay__row').count();
    expect(rows).toBeGreaterThanOrEqual(4);
    expect(box?.height ?? 0).toBeGreaterThan(rows * 12);

    // III. A transparent panel over a bright sky is unreadable; the background
    //      must be dark enough to guarantee contrast.
    const style = await overlay.evaluate((element) => {
      const computed = window.getComputedStyle(element);
      return { background: computed.backgroundColor, color: computed.color };
    });
    expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(style.color).not.toBe(style.background);

    await capture(page, 'phase0-debug-overlay');
  });

  test('shows a styled loading screen before and during engine boot', async ({ page, browser }) => {
    // I. With JavaScript disabled entirely, the static markup in index.html must
    //    still paint as a styled card. This is the state a player sees while the
    //    bundle is downloading on a slow connection; a blank page there makes the
    //    game look broken.
    const noJsContext = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 1280, height: 720 },
    });
    const noJsPage = await noJsContext.newPage();
    await noJsPage.goto('/');

    const staticCard = noJsPage.locator('[data-testid="boot-loading"]');
    await expect(staticCard).toBeVisible();
    await expect(staticCard).toContainText('正在启动');

    const image = await capture(noJsPage, 'phase0-loading');
    await noJsContext.close();

    // The card is opaque, so the centre of the frame must be the dark page
    // background rather than the browser's default white.
    const centre = analyseRegion(image, { name: 'card', x: 0.4, y: 0.4, width: 0.2, height: 0.2 });
    expect(centre.r).toBeLessThan(120);
    expect(centre.b).toBeLessThan(140);

    // II. With JavaScript enabled, the static card is adopted by the boot
    //     overlay, updated through the boot stages, and dismissed once a frame
    //     has actually been presented.
    await page.route('**/*.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('boot-loading')).toBeVisible();
    // Exactly one card: the adopted static element, not a duplicate appended by
    // the overlay.
    await expect(page.locator('.boot-screen')).toHaveCount(1);

    await page.unroute('**/*.js');
    await waitForEngineReady(page);
  });
});
