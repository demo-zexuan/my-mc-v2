/**
 * Verifies the two menu/onboarding fixes.
 *
 * I. What is checked
 *
 * 1. "开始游戏" is clickable with no save and creates a world from the seed field.
 * 2. Entering a world publishes the control hints, and `H` brings them back.
 *
 * Usage: node scripts/probe-menu-hints.mjs [url]
 */
import { chromium } from '@playwright/test';

const url = process.argv.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:4173/';
const browser = await chromium.launch({
  headless: !process.argv.includes('--headed'),
  args: ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('[data-testid="main-menu"]', { timeout: 45_000 });
await page.waitForSelector('[data-testid="boot-loading"]', { state: 'detached' }).catch(() => {});

const start = page.getByTestId('main-menu-start');
console.log(
  `start button: disabled=${await start.isDisabled()} label="${await start.innerText()}"`,
);
console.log(`hint: ${await page.getByTestId('main-menu-start-hint').innerText()}`);
await page.screenshot({ path: 'test-results/integration/menu-after.png' });

// Type a seed and use the primary button, which is the path a player takes.
await page.getByTestId('main-menu-seed').fill('seed-from-start-button');
await start.click();

await page.waitForSelector('[data-testid="debug-overlay"]', { timeout: 60_000 });
await page.waitForTimeout(3500);
const seedRow = (await page.getByTestId('debug-row-seed').innerText()).replace(/\s+/g, ' ');
console.log(`seed row: ${seedRow}`);

const notices = await page.getByTestId('notice').allInnerTexts();
console.log(`notices on entry: ${notices.length}`);
for (const text of notices) {
  console.log(`  - ${text.split('\n')[0]}`);
}
await page.screenshot({ path: 'test-results/integration/in-game-hints.png' });

// `H` must bring the hints back after they expire.
await page.waitForTimeout(16000);
await page.getByTestId('game-canvas').click({ position: { x: 640, y: 360 } });
await page.keyboard.press('KeyH');
await page.waitForTimeout(600);
const again = await page.getByTestId('notice').allInnerTexts();
console.log(`notices after H: ${again.length}`);
console.log(
  notices.length > 0 && again.length > 0
    ? 'VERDICT: control hints appear on entry and H brings them back.'
    : 'VERDICT: control hints are missing.',
);

await browser.close();
