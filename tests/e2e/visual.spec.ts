import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startNewWorld, waitForMainMenu, waitForWorldReady } from './support/harness';
import {
  analyseRegion,
  countDistinctColours,
  decodeScreenshot,
  dominantColourShare,
  type DecodedImage,
} from './support/image';

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
 * The most common rendering regression in a voxel game is a camera or projection
 * mistake that points the scene at the void, or a day/night bug that leaves the
 * world unlit. Both are invisible to DOM assertions; the sky/ground split and the
 * overall brightness are cheap, stable proxies for them.
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
  test('renders the main menu as a readable card over a dark backdrop', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);

    const image = await capture(page, 'game-main-menu');

    // The backdrop must be dark so the card's text keeps its contrast.
    const corner = analyseRegion(image, {
      name: 'corner',
      x: 0.02,
      y: 0.02,
      width: 0.08,
      height: 0.08,
    });
    expect(corner.r).toBeLessThan(90);
    expect(corner.g).toBeLessThan(90);
    expect(corner.b).toBeLessThan(110);

    // And the card must actually be visible against it.
    const card = analyseRegion(image, { name: 'card', x: 0.4, y: 0.4, width: 0.2, height: 0.1 });
    expect(card.r + card.g + card.b).toBeGreaterThan(corner.r + corner.g + corner.b);

    await expect(page.getByTestId('main-menu-title')).toBeVisible();
  });

  test('renders a lit voxel world instead of a blank canvas', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'visual-world');
    // Let the streamed chunks settle and the camera settle on the ground.
    await page.waitForTimeout(2500);

    const image = await capture(page, 'game-world');

    // I. The frame must contain real imagery rather than one flat colour.
    expect(countDistinctColours(image)).toBeGreaterThan(60);
    expect(dominantColourShare(image)).toBeLessThan(0.9);

    // II. The world must not be unlit. A scene left at midnight, or a light rig
    //     that failed to initialise, produces a near-black frame.
    const overall = analyseRegion(image, {
      name: 'overall',
      x: 0.05,
      y: 0.1,
      width: 0.9,
      height: 0.8,
    });
    const meanBrightness = (overall.r + overall.g + overall.b) / 3;
    // I. Calibration.
    // 1. A world rendered without lighting, or at midnight with the light rig
    //    broken, measures below 10 — that is the failure this guards against.
    // 2. A lit world measured 35 to 65 depending on the seed and the time of day
    //    (coastlines are darker than inland plains). The threshold sits at 25 so a
    //    dark-but-correct seed does not fail, while a black frame still does.
    expect(meanBrightness, `mean brightness ${meanBrightness.toFixed(1)}`).toBeGreaterThan(25);

    // III. Sky and ground must be distinguishable: the upper band is sampled to
    //      the right of the debug panel, the lower band below the horizon.
    const sky = analyseRegion(image, { name: 'sky', x: 0.55, y: 0.02, width: 0.4, height: 0.08 });
    const ground = analyseRegion(image, {
      name: 'ground',
      x: 0.25,
      y: 0.88,
      width: 0.5,
      height: 0.1,
    });
    expect(Math.abs(sky.r + sky.g + sky.b - (ground.r + ground.g + ground.b))).toBeGreaterThan(20);

    expect(image.width).toBe(1280);
    expect(image.height).toBe(720);
  });

  test('centres the crosshair and the hotbar', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'visual-hud');
    await waitForWorldReady(page);

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const width = viewport?.width ?? 1280;
    const height = viewport?.height ?? 720;

    // I. A crosshair that is not exactly centred makes aiming feel wrong, and it
    //    is the kind of error that is easy to introduce with padding or a border.
    const crosshair = await page.getByTestId('crosshair').boundingBox();
    expect(crosshair).not.toBeNull();
    const crosshairCentreX = (crosshair?.x ?? 0) + (crosshair?.width ?? 0) / 2;
    const crosshairCentreY = (crosshair?.y ?? 0) + (crosshair?.height ?? 0) / 2;
    expect(Math.abs(crosshairCentreX - width / 2)).toBeLessThan(2);
    expect(Math.abs(crosshairCentreY - height / 2)).toBeLessThan(2);

    // II. The hotbar mirrors Minecraft's placement: horizontally centred, near the
    //     bottom edge, and clear of the very bottom so it never clips.
    const hotbar = await page.getByTestId('hotbar').boundingBox();
    expect(hotbar).not.toBeNull();
    const hotbarCentreX = (hotbar?.x ?? 0) + (hotbar?.width ?? 0) / 2;
    expect(Math.abs(hotbarCentreX - width / 2)).toBeLessThan(2);
    expect((hotbar?.y ?? 0) + (hotbar?.height ?? 0)).toBeLessThan(height);
    expect((hotbar?.y ?? 0) + (hotbar?.height ?? 0)).toBeGreaterThan(height * 0.7);

    // III. The HUD must not swallow clicks meant for the world.
    const hudPointerEvents = await page
      .getByTestId('hud')
      .evaluate((element) => window.getComputedStyle(element).pointerEvents);
    expect(hudPointerEvents).toBe('none');

    await capture(page, 'game-hud');
  });

  test('keeps the loading screen visible before the engine is ready', async ({ page }) => {
    // I. The static card must be on screen while the bundle is still downloading,
    //    so a slow connection never shows a blank page.
    // 1. The script response is *delayed* rather than aborted: aborting leaves the
    //    page's load event and font loading pending forever, and Playwright's
    //    screenshot waits for both before it captures.
    await page.route('**/assets/*.js', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await route.continue();
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const staticCard = page.locator('[data-testid="boot-loading"]');
    await expect(staticCard).toBeVisible();
    await expect(staticCard).toContainText('正在启动');

    const image = await capture(page, 'game-loading');

    const centre = analyseRegion(image, { name: 'card', x: 0.4, y: 0.4, width: 0.2, height: 0.2 });
    expect(centre.r).toBeLessThan(120);
    expect(centre.b).toBeLessThan(140);

    await page.unroute('**/assets/*.js');

    // II. With the bundle running, the static card is adopted by the boot overlay,
    //     updated through the stages and dismissed once the menu is interactive.
    await page.goto('/');
    await waitForMainMenu(page);
    await expect(page.locator('.boot-screen')).toHaveCount(0);
  });
});
