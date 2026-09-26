/**
 * Second-stage diagnostic: which Chromium launch mode actually provides WebGL 2.
 *
 * I. Background
 *
 * Playwright's default `headless: true` uses the stripped-down
 * `chromium_headless_shell` binary, which has no GPU stack. The full Chrome for
 * Testing build (`channel: 'chromium'`) runs the real headless mode and can fall
 * back to SwiftShader. This script measures the difference instead of guessing.
 *
 * Usage: node scripts/probe-launch-modes.mjs [url]
 */

import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';

const MODES = [
  { name: 'headless shell (default)', options: {} },
  { name: 'channel=chromium (Chrome for Testing)', options: { channel: 'chromium' } },
  {
    name: 'channel=chromium + unsafe-swiftshader',
    options: { channel: 'chromium', args: ['--enable-unsafe-swiftshader'] },
  },
  {
    name: 'channel=chrome (installed Google Chrome)',
    options: { channel: 'chrome', args: ['--enable-unsafe-swiftshader'] },
  },
];

for (const mode of MODES) {
  let browser;
  try {
    browser = await chromium.launch(mode.options);
  } catch (error) {
    console.log(`\n=== ${mode.name} ===\nlaunch failed: ${String(error).slice(0, 200)}`);
    continue;
  }

  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text().slice(0, 200));
    }
  });

  // I. Raw capability check on a detached canvas (independent of the app).
  await page.goto('about:blank');
  const raw = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl === null) {
      return { webgl2: false };
    }
    return {
      webgl2: true,
      renderer: gl.getParameter(gl.RENDERER),
      version: gl.getParameter(gl.VERSION),
    };
  });

  // II. Application check against the real production build.
  let app;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 25_000 });
    await page.waitForSelector('[data-testid="boot-fatal"], [data-testid="debug-overlay"]', {
      timeout: 25_000,
    });
    app = await page.evaluate(() => {
      const fatal = document.querySelector('[data-testid="boot-fatal"]');
      const debug = document.querySelector('[data-testid="debug-overlay"]');
      return {
        state: fatal !== null ? 'fatal' : debug !== null ? 'running' : 'unknown',
        fatal: fatal?.textContent?.slice(0, 200) ?? null,
        fps: debug?.querySelector('[data-testid="debug-row-fps"]')?.textContent ?? null,
        drawCalls: debug?.querySelector('[data-testid="debug-row-drawCalls"]')?.textContent ?? null,
      };
    });
  } catch (error) {
    app = { state: 'page-error', fatal: String(error).slice(0, 200) };
  }

  console.log(`\n=== ${mode.name} ===`);
  console.log('raw :', JSON.stringify(raw));
  console.log('app :', JSON.stringify(app));
  if (errors.length > 0) {
    console.log('cons:', errors.slice(0, 3).join(' | '));
  }
  await browser.close();
}
