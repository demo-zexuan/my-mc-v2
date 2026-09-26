import { expect, type Page } from '@playwright/test';

/**
 * Shared helpers for the browser suites.
 *
 * @module tests/e2e/support/harness
 */

/** Console/exception record collected during a page run. */
export interface PageDiagnostics {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  readonly failedRequests: string[];
}

/**
 * Starts collecting console errors, uncaught exceptions and failed requests.
 *
 * I. Why requests are also tracked
 *
 * A missing texture or a 404 on a hashed asset does not throw in the page; it
 * silently degrades the scene. Treating failed requests as failures is the only
 * way the suite can catch a broken `base` path on Cloudflare Pages.
 *
 * @param page - Page to instrument.
 * @returns Mutable diagnostics record, populated as the page runs.
 */
export function collectDiagnostics(page: Page): PageDiagnostics {
  const diagnostics: PageDiagnostics = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
  };

  page.on('console', (message) => {
    if (message.type() === 'error') {
      diagnostics.consoleErrors.push(message.text());
    }
  });

  page.on('pageerror', (error) => {
    diagnostics.pageErrors.push(error.message);
  });

  page.on('requestfailed', (request) => {
    diagnostics.failedRequests.push(`${request.method()} ${request.url()}`);
  });

  page.on('response', (response) => {
    if (response.status() >= 400) {
      diagnostics.failedRequests.push(`${response.status()} ${response.url()}`);
    }
  });

  return diagnostics;
}

/** Waits for the boot sequence to reach the main menu. */
export async function waitForMainMenu(page: Page): Promise<void> {
  await expect(page.getByTestId('game-canvas')).toBeVisible();
  await expect(page.getByTestId('main-menu')).toBeVisible({ timeout: 30_000 });
  // The loading card must be gone, otherwise the menu is not interactive yet.
  await expect(page.locator('[data-testid="boot-loading"]')).toHaveCount(0, { timeout: 20_000 });
}

/**
 * Creates a world from the main menu and waits until the world has rendered.
 *
 * @param page - Page under test.
 * @param seed - Optional seed so runs are comparable.
 */
export async function startNewWorld(page: Page, seed = 'e2e-seed'): Promise<void> {
  const seedInput = page.getByTestId('main-menu-seed');
  if ((await seedInput.count()) > 0) {
    await seedInput.fill(seed);
  }
  await page.getByTestId('main-menu-new-world').click();
  await waitForWorldReady(page);
}

/** Waits until chunks exist and the frame loop is reporting a rate. */
export async function waitForWorldReady(page: Page): Promise<void> {
  await expect(page.getByTestId('debug-overlay')).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      async () => {
        const text = await page.getByTestId('debug-row-chunks').innerText();
        const match = /\d+/.exec(text);
        return match === null ? 0 : Number.parseInt(match[0], 10);
      },
      { timeout: 40_000, message: 'no chunk was ever loaded' },
    )
    .toBeGreaterThan(0);

  await expect
    .poll(
      async () => {
        const text = await page.getByTestId('debug-row-fps').innerText();
        const match = /\d+/.exec(text);
        return match === null ? 0 : Number.parseInt(match[0], 10);
      },
      { timeout: 30_000, message: 'the render loop never reported a frame rate' },
    )
    .toBeGreaterThan(0);
}

/**
 * Reads the player position the debug overlay is displaying.
 *
 * @param page - Page under test.
 * @returns Parsed world coordinates.
 */
export async function readPlayerPosition(page: Page): Promise<{ x: number; y: number; z: number }> {
  const text = await page.getByTestId('debug-row-position').innerText();
  const numbers = text.match(/-?\d+(?:\.\d+)?/g) ?? [];
  return {
    x: Number.parseFloat(numbers[0] ?? '0'),
    y: Number.parseFloat(numbers[1] ?? '0'),
    z: Number.parseFloat(numbers[2] ?? '0'),
  };
}

/**
 * Gives the page a real keyboard focus target.
 *
 * The canvas is focusable, and pointer lock needs a trusted click; several
 * suites therefore click the middle of the canvas before sending keys.
 *
 * @param page - Page under test.
 */
export async function focusGame(page: Page): Promise<void> {
  const canvas = page.getByTestId('game-canvas');
  const box = await canvas.boundingBox();
  if (box !== null) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
}

/**
 * Asserts that the page produced no severe diagnostics.
 *
 * @param diagnostics - Record produced by {@link collectDiagnostics}.
 */
export function expectNoSevereDiagnostics(diagnostics: PageDiagnostics): void {
  expect(diagnostics.pageErrors, 'uncaught page exceptions').toEqual([]);
  expect(diagnostics.consoleErrors, 'console errors').toEqual([]);
  expect(diagnostics.failedRequests, 'failed network requests').toEqual([]);
}
