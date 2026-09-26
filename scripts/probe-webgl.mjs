/**
 * Diagnostic probe for headless WebGL support.
 *
 * I. Why this exists
 *
 * The E2E suite runs a production build inside headless Chromium, where WebGL is
 * provided by SwiftShader. The accepted flag set changes between Chrome
 * releases, and a wrong combination yields a canvas that reports a context but
 * cannot be handed to Three.js. This script drives the real application so that
 * `playwright.config.ts` uses a verified flag set instead of an assumed one.
 *
 * Usage: node scripts/probe-webgl.mjs [url]
 */

import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';

const FLAG_SETS = [
  { name: 'default (no flags)', args: [] },
  { name: 'enable-unsafe-swiftshader', args: ['--enable-unsafe-swiftshader'] },
  {
    name: 'unsafe-swiftshader + angle/swiftshader',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
  },
  {
    name: 'unsafe-swiftshader + disable-gpu',
    args: ['--enable-unsafe-swiftshader', '--disable-gpu'],
  },
  {
    name: 'angle=swiftshader without unsafe flag',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
  },
];

for (const flagSet of FLAG_SETS) {
  const browser = await chromium.launch({ args: flagSet.args });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const messages = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      messages.push(`${message.type()}: ${message.text().slice(0, 220)}`);
    }
  });
  page.on('pageerror', (error) => messages.push(`pageerror: ${error.message.slice(0, 220)}`));

  let outcome;
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 25_000 });
    // Wait for either the fatal card or the debug overlay.
    await page.waitForSelector('[data-testid="boot-fatal"], [data-testid="debug-overlay"]', {
      timeout: 25_000,
    });
    outcome = await page.evaluate(() => {
      const fatal = document.querySelector('[data-testid="boot-fatal"]');
      const debug = document.querySelector('[data-testid="debug-overlay"]');
      const canvas = document.querySelector('canvas');
      const gl = canvas?.getContext('webgl2') ?? null;
      return {
        state: fatal !== null ? 'fatal' : debug !== null ? 'running' : 'unknown',
        fatalText: fatal?.textContent?.slice(0, 240) ?? null,
        fps: debug?.querySelector('[data-testid="debug-row-fps"]')?.textContent ?? null,
        drawCalls: debug?.querySelector('[data-testid="debug-row-drawCalls"]')?.textContent ?? null,
        glRenderer: gl?.getParameter(gl.RENDERER) ?? null,
        glVersion: gl?.getParameter(gl.VERSION) ?? null,
      };
    });
  } catch (error) {
    outcome = { state: 'page-error', error: String(error).slice(0, 240) };
  }

  console.log(`\n=== ${flagSet.name} ===`);
  console.log(JSON.stringify(outcome, null, 2));
  if (messages.length > 0) {
    console.log('messages:', messages.slice(0, 5).join('\n          '));
  }
  await browser.close();
}
