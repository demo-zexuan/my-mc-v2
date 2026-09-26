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
 * silently degrades the scene. Treating failed requests as test failures is the
 * only way the visual suite can catch a broken `base` path on Cloudflare Pages.
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

/**
 * Waits until the boot overlay has been dismissed and the loop has rendered at
 * least a few frames.
 *
 * @param page - Page under test.
 */
export async function waitForEngineReady(page: Page): Promise<void> {
  await expect(page.getByTestId('game-canvas')).toBeVisible();
  // The overlay detaches itself after the first presented frame.
  await expect(page.locator('[data-testid="boot-loading"]')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('debug-overlay')).toBeVisible();

  // A single frame proves nothing about a running loop; require several.
  await expect
    .poll(
      async () => {
        const text = await page.getByTestId('debug-row-fps').innerText();
        const value = Number.parseInt(text.replace(/[^0-9]/g, ''), 10);
        return Number.isFinite(value) ? value : 0;
      },
      { timeout: 20_000, message: 'the render loop never reported a frame rate' },
    )
    .toBeGreaterThan(0);
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
