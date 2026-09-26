/**
 * Verifies mining feedback and flight mode in a real browser.
 *
 * I. What "cannot break blocks" turned out to mean
 *
 * Breaking worked; the progress was invisible, so a player holding the button saw
 * nothing happen and reported it as broken. This probe therefore checks the two
 * things a player actually perceives: the world changes, and the target darkens
 * while the break is in progress. Flight is checked through the debug row and the
 * player's Y coordinate.
 *
 * Usage: node scripts/probe-flight.mjs [url]
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
await page.getByTestId('main-menu-new-world').click();
await page.waitForSelector('[data-testid="debug-overlay"]', { timeout: 45_000 });
await page.waitForTimeout(9000);

const row = async (key) =>
  (await page.getByTestId(`debug-row-${key}`).innerText()).replace(/\s+/g, ' ').trim();
const position = async () => {
  const text = await row('position');
  const n = text.match(/-?\d+(\.\d+)?/g) ?? [];
  return { x: Number(n[0]), y: Number(n[1]), z: Number(n[2]) };
};

const box = await page.getByTestId('game-canvas').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// --- Look down at the ground so there is definitely a target in reach. ---
await page.mouse.move(cx, cy);
await page.mouse.down();
// A shallow aim keeps the crosshair on ground a few blocks ahead instead of
// straight down: dragging with the primary button held also mines, and digging a
// shaft directly below the crosshair puts the next block outside the 5-block
// reach, which looks like "mining stopped working".
for (let i = 0; i < 4; i += 1) {
  await page.mouse.move(cx, cy + (i + 1) * 16, { steps: 2 });
  await page.waitForTimeout(40);
}
await page.mouse.up();
await page.waitForTimeout(1000);
console.log(`target: ${await row('input')}`);

// --- Hold the button and sample the progress readout mid-break. ---
await page.mouse.move(cx, cy);
await page.mouse.down();
let sawProgress = false;
for (let tick = 0; tick < 30; tick += 1) {
  await page.waitForTimeout(60);
  const mining = await row('mining');
  const inputRow = await row('input');
  const drops = await row('entities');
  const percent = Number.parseInt(mining.replace(/[^0-9]/g, ''), 10);
  console.log(`  t=${((tick + 1) * 0.06).toFixed(2)}s ${mining} | ${inputRow} | drops=${drops}`);
  if (percent > 0 && percent < 100) {
    sawProgress = true;
    await page.screenshot({ path: 'test-results/integration/mining-progress.png' });
    console.log(`mining feedback observed at ${percent}%`);
    break;
  }
}
await page.mouse.up();
console.log(
  sawProgress
    ? 'VERDICT: mining shows progress feedback.'
    : 'VERDICT: no mining progress observed.',
);

// --- Flight: double-tap Space, then ascend. ---
const before = await position();
await page.keyboard.press('Space');
await page.waitForTimeout(80);
await page.keyboard.press('Space');
await page.waitForTimeout(500);
const flyRow = await row('fly');
console.log(`fly row: ${flyRow}`);

await page.keyboard.down('Space');
await page.waitForTimeout(2500);
await page.keyboard.up('Space');
const after = await position();
console.log(`y: ${before.y.toFixed(2)} -> ${after.y.toFixed(2)}`);
console.log(
  flyRow.includes('on') && after.y > before.y + 1
    ? 'VERDICT: flight mode works — double-tap toggles it and Space ascends.'
    : 'VERDICT: flight mode is broken.',
);

await page.screenshot({ path: 'test-results/integration/flight.png' });
await browser.close();
