import { expect, test } from '@playwright/test';

import {
  collectDiagnostics,
  expectNoSevereDiagnostics,
  waitForEngineReady,
} from './support/harness';

/**
 * Boot and interaction smoke tests.
 *
 * I. Scope
 *
 * These assertions cover the accessibility of the loop to the player: the page
 * loads, the engine initialises, the canvas is actually rendering, the debug
 * view can be toggled, and nothing was logged as an error along the way.
 */
test.describe('engine boot', () => {
  test('initialises the renderer and starts the frame loop', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);

    await page.goto('/');
    await waitForEngineReady(page);

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
        width: canvas.width,
        height: canvas.height,
        drawingBufferWidth: context?.drawingBufferWidth ?? 0,
        drawingBufferHeight: context?.drawingBufferHeight ?? 0,
      };
    });

    expect(contextInfo.reason).toBe('ok');
    expect(contextInfo.ok).toBe(true);
    expect(contextInfo.drawingBufferWidth).toBeGreaterThan(0);
    expect(contextInfo.drawingBufferHeight).toBeGreaterThan(0);

    expectNoSevereDiagnostics(diagnostics);
  });

  test('reports draw calls and triangles once rendering', async ({ page }) => {
    await page.goto('/');
    await waitForEngineReady(page);

    const drawCalls = await page.getByTestId('debug-row-drawCalls').innerText();
    const triangles = await page.getByTestId('debug-row-triangles').innerText();

    expect(Number.parseInt(drawCalls.replace(/[^0-9]/g, ''), 10)).toBeGreaterThan(0);
    expect(Number.parseInt(triangles.replace(/[^0-9]/g, ''), 10)).toBeGreaterThan(0);
  });

  test('toggles the debug overlay with F3', async ({ page }) => {
    await page.goto('/');
    await waitForEngineReady(page);

    const overlay = page.getByTestId('debug-overlay');
    await expect(overlay).toBeVisible();

    await page.keyboard.press('F3');
    await expect(overlay).toBeHidden();

    await page.keyboard.press('F3');
    await expect(overlay).toBeVisible();
  });

  test('keeps rendering while the viewport is resized', async ({ page }) => {
    await page.goto('/');
    await waitForEngineReady(page);

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(400);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);

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
