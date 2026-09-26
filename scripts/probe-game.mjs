/**
 * End-to-end probe for the integrated game.
 *
 * I. Why this script exists separately from the Playwright suite
 *
 * The suite asserts; this script observes. During integration the useful question
 * is "what does the game actually do when a player clicks New World", including
 * console output and a screenshot per stage. Keeping it out of the suite means it
 * can be run against a half-finished build without turning the CI red.
 *
 * Usage: node scripts/probe-game.mjs [url]
 */

import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/';
const outDir = process.env['VISUAL_OUTPUT_DIR'] ?? 'test-results/integration';

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const messages = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') {
    messages.push(`${message.type()}: ${message.text().slice(0, 260)}`);
  }
});
page.on('pageerror', (error) => messages.push(`pageerror: ${error.message.slice(0, 260)}`));

await mkdir(outDir, { recursive: true });

const stage = async (name, note) => {
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`[shot] ${name} — ${note}`);
};

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

// I. Boot: either the fatal card or the main menu must appear.
await page.waitForSelector('[data-testid="boot-fatal"], [data-testid="main-menu"]', {
  timeout: 45_000,
});
const fatal = await page.locator('[data-testid="boot-fatal"]').count();
if (fatal > 0) {
  const text = await page.locator('[data-testid="boot-fatal"]').innerText();
  console.log('FATAL CARD:', text.replace(/\s+/g, ' ').slice(0, 400));
  await stage('01-fatal', 'boot failed');
  console.log('console:', messages.slice(0, 8).join('\n         '));
  await browser.close();
  process.exit(1);
}

// The loading card fades out; waiting for it to detach keeps the screenshot
// representative of what a player sees once the menu is interactive.
await page
  .waitForSelector('[data-testid="boot-loading"]', { state: 'detached', timeout: 15_000 })
  .catch(() => {});
await page.waitForTimeout(350);
await stage('01-main-menu', 'main menu visible');

// II. Start a new world from a fixed seed so runs are comparable.
await page.locator('[data-testid="main-menu-new-world"]').click();
await page.waitForTimeout(900);

// III. Wait for the world to render.
const deadline = Date.now() + 60_000;
let ready = false;
while (Date.now() < deadline) {
  const state = await page.evaluate(() => {
    const debug = document.querySelector('[data-testid="debug-overlay"]');
    const hasCanvas = document.querySelector('canvas') !== null;
    const chunks = debug?.querySelector('[data-testid="debug-row-chunks"]')?.textContent ?? null;
    const fps = debug?.querySelector('[data-testid="debug-row-fps"]')?.textContent ?? null;
    return { hasCanvas, chunks, fps };
  });
  if (state.hasCanvas && state.chunks !== null && !state.chunks.includes('—')) {
    ready = true;
    console.log('world ready:', JSON.stringify(state));
    break;
  }
  await page.waitForTimeout(500);
}

await page.waitForTimeout(2500);
await stage('02-world', ready ? 'world rendered' : 'world never reported chunks');

// IV. Look around and walk, then screenshot again.
await page.mouse.move(640, 360);
await page.mouse.click(640, 360);
await page.keyboard.down('KeyW');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
await page.mouse.move(760, 360, { steps: 12 });
await page.waitForTimeout(600);
await stage('03-after-moving', 'after walking and looking');

const debugText = await page
  .locator('[data-testid="debug-overlay"]')
  .innerText()
  .catch(() => '(no debug overlay)');
console.log('--- debug overlay ---');
console.log(debugText);

console.log('--- console messages ---');
console.log(messages.length === 0 ? '(none)' : messages.slice(0, 14).join('\n'));

await browser.close();
