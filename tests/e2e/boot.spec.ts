import { expect, test } from '@playwright/test';

import {
  collectDiagnostics,
  expectNoSevereDiagnostics,
  focusGame,
  readPlayerPosition,
  startNewWorld,
  waitForMainMenu,
  waitForWorldReady,
} from './support/harness';

/**
 * Boot and platform smoke tests.
 *
 * I. Scope
 *
 * These assertions cover everything before gameplay: the page loads, the engine
 * initialises a real WebGL 2 context, the menu appears and the frame loop runs
 * without logging anything severe.
 */
test.describe('engine boot', () => {
  test('initialises the renderer and reaches the main menu', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);

    await page.goto('/');
    await waitForMainMenu(page);

    // The rendering context must be a real WebGL 2 context; a canvas element
    // alone would also be produced by a failed initialisation.
    const contextInfo = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (canvas === null) {
        return { ok: false, reason: 'no canvas' };
      }
      const context = canvas.getContext('webgl2');
      return {
        ok: context !== null,
        reason: context === null ? 'context missing' : 'ok',
        width: context?.drawingBufferWidth ?? 0,
        height: context?.drawingBufferHeight ?? 0,
      };
    });

    expect(contextInfo.reason).toBe('ok');
    expect(contextInfo.width).toBeGreaterThan(0);
    expect(contextInfo.height).toBeGreaterThan(0);

    // The menu must describe the controls; a menu that lost its hint block would
    // leave new players with no idea what to press.
    await expect(page.getByTestId('main-menu-controls')).toContainText('WASD');

    expectNoSevereDiagnostics(diagnostics);
  });

  test('reports no severe diagnostics while a world is created', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);

    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-diagnostics');

    expectNoSevereDiagnostics(diagnostics);
  });

  test('toggles the debug overlay with F3', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-f3');

    const overlay = page.getByTestId('debug-overlay');
    await expect(overlay).toBeVisible();

    await focusGame(page);
    await page.keyboard.press('F3');
    await expect(overlay).toBeHidden();

    await page.keyboard.press('F3');
    await expect(overlay).toBeVisible();
  });

  test('keeps rendering while the viewport is resized', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-resize');

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(500);

    // A resize that forgets `updateProjectionMatrix` still renders, but the
    // drawing buffer would no longer match the new size.
    const sizes = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      const context = canvas?.getContext('webgl2');
      return {
        clientWidth: canvas?.clientWidth ?? 0,
        clientHeight: canvas?.clientHeight ?? 0,
        bufferWidth: context?.drawingBufferWidth ?? 0,
      };
    });

    expect(sizes.clientWidth).toBe(1440);
    expect(sizes.clientHeight).toBe(900);
    expect(sizes.bufferWidth).toBeGreaterThanOrEqual(1440);
  });
});

/**
 * Gameplay interaction: the acceptance list from the project brief, expressed as
 * browser assertions.
 */
test.describe('gameplay', () => {
  test('generates a voxel world with terrain and chunks', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-world');

    // Streaming fills the view distance over several frames. `waitForWorldReady`
    // only proves that *some* chunk exists, so the count is polled here: under
    // SwiftShader a single read can land while the world is still half loaded.
    await expect
      .poll(
        async () => {
          const text = await page.getByTestId('debug-row-chunks').innerText();
          return Number.parseInt(/(\d+)/.exec(text)?.[1] ?? '0', 10);
        },
        { timeout: 45_000, message: 'the view distance never filled in' },
      )
      .toBeGreaterThan(50);

    const chunks = await page.getByTestId('debug-row-chunks').innerText();
    const triangles = await page.getByTestId('debug-row-triangles').innerText();
    const drawCalls = await page.getByTestId('debug-row-drawCalls').innerText();

    const chunkCount = Number.parseInt(/(\d+)/.exec(chunks)?.[1] ?? '0', 10);
    const triangleCount = Number.parseInt(triangles.replace(/[^0-9]/g, ''), 10);
    const drawCallCount = Number.parseInt(drawCalls.replace(/[^0-9]/g, ''), 10);

    expect(chunkCount).toBeGreaterThan(50);
    expect(triangleCount).toBeGreaterThan(5_000);
    // The mesher must batch faces per chunk. One draw call per face would put this
    // number in the tens of thousands and the frame rate on the floor.
    expect(drawCallCount).toBeGreaterThan(0);
    expect(drawCallCount).toBeLessThan(chunkCount * 4);
  });

  test('lets the player move with WASD', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-move');

    await focusGame(page);
    await page.waitForTimeout(500);

    // I. Try every direction and require one of them to work.
    // 1. The spawn point is procedural, so a single direction may legitimately run
    //    into a hill within a block. Testing "at least one direction moves the
    //    player" is deterministic regardless of the terrain the seed produced,
    //    while still failing loudly if the input pipeline is broken.
    // 2. The assertion is displacement, not frames: headless Chromium renders
    //    through SwiftShader, where a second of wall clock is a handful of frames
    //    and the fixed-step loop clamps its catch-up work by design.
    const directions = ['KeyW', 'KeyS', 'KeyA', 'KeyD'] as const;
    let bestDistance = 0;

    for (const key of directions) {
      const before = await readPlayerPosition(page);
      await page.keyboard.down(key);
      try {
        await expect
          .poll(
            async () => {
              const now = await readPlayerPosition(page);
              return Math.hypot(now.x - before.x, now.z - before.z);
            },
            { timeout: 8_000 },
          )
          .toBeGreaterThan(bestDistance);
        const now = await readPlayerPosition(page);
        bestDistance = Math.hypot(now.x - before.x, now.z - before.z);
      } catch {
        // This direction was blocked; the next one may not be.
      } finally {
        await page.keyboard.up(key);
      }

      if (bestDistance > 1) {
        break;
      }
    }

    expect(bestDistance, 'no direction moved the player').toBeGreaterThan(1);
  });

  test('turns the camera when the player moves the mouse', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-look');
    await waitForWorldReady(page);

    const facingBefore = await page.getByTestId('hud').locator('[data-row="facing"]').innerText();

    const box = await page.getByTestId('game-canvas').boundingBox();
    expect(box).not.toBeNull();
    const centreX = (box?.x ?? 0) + (box?.width ?? 0) / 2;
    const centreY = (box?.y ?? 0) + (box?.height ?? 0) / 2;

    // I. Hold the primary button across the movement.
    // 1. Pointer lock is the primary look channel, but a browser only grants it to
    //    a focused document. Automated and embedded contexts fall back to
    //    drag-to-look, and driving both paths the same way keeps this test valid
    //    wherever it runs.
    await page.mouse.move(centreX, centreY);
    await page.mouse.down();
    for (let step = 0; step < 12; step += 1) {
      await page.mouse.move(centreX + (step + 1) * 60, centreY, { steps: 3 });
      await page.waitForTimeout(60);
    }
    await page.mouse.up();
    await page.waitForTimeout(600);

    const facingAfter = await page.getByTestId('hud').locator('[data-row="facing"]').innerText();
    expect(facingAfter, 'the view direction never changed').not.toBe(facingBefore);
  });

  test('lets the player jump', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-jump');

    await focusGame(page);
    await page.waitForTimeout(300);
    const ground = await readPlayerPosition(page);

    await page.keyboard.press('Space');
    // Sample during the arc rather than after landing.
    let peak = ground.y;
    for (let sample = 0; sample < 12; sample += 1) {
      await page.waitForTimeout(60);
      const now = await readPlayerPosition(page);
      peak = Math.max(peak, now.y);
    }

    expect(peak).toBeGreaterThan(ground.y + 0.2);
  });

  test('opens the inventory and returns to the game', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-inventory');

    await focusGame(page);
    await page.keyboard.press('KeyE');
    await expect(page.getByTestId('inventory-screen')).toBeVisible();

    // The panel must own the pointer while it is open; otherwise clicks fall
    // through to the canvas and the player mines the block behind it.
    const pointerEvents = await page
      .getByTestId('inventory-screen')
      .evaluate((element) => window.getComputedStyle(element).pointerEvents);
    expect(pointerEvents).not.toBe('none');

    await page.keyboard.press('KeyE');
    await expect(page.getByTestId('inventory-screen')).toBeHidden();
  });

  test('shows the pause menu after the pointer lock is released', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-pause');
    await waitForWorldReady(page);

    await focusGame(page);
    await page.waitForTimeout(300);

    // Escape is handled two ways: the browser may swallow it into the pointer-lock
    // machinery, and the application also handles the key event itself. Playwright
    // dispatches a trusted key event, so the application path is exercised here.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    await expect(page.getByTestId('pause-menu')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('pause-menu-resume')).toBeVisible();
  });

  test('returns to the menu and enters a second world', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, 'e2e-first');

    await focusGame(page);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    const quit = page.getByTestId('pause-menu-quit');
    await expect(quit).toBeVisible({ timeout: 10_000 });
    await quit.click();

    await expect(page.getByTestId('main-menu')).toBeVisible({ timeout: 30_000 });
    await startNewWorld(page, 'e2e-second');
    await waitForWorldReady(page);
  });
});
