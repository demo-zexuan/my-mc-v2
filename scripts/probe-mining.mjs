/**
 * Verifies the full block-breaking chain in a real browser.
 *
 * I. Why a dedicated probe
 *
 * "I cannot break blocks" is a claim about a chain of six links: the pointer lock
 * or the drag fallback, the button binding, the DDA ray hit, the selection change
 * that hands the target to the mining system, the hardness timer, and the world
 * write. A probe that reports each link separately turns a vague report into a
 * located defect.
 *
 * Usage: node scripts/probe-mining.mjs [url]
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
await page.waitForTimeout(8000);

const readRow = async (key) => {
  const text = await page.getByTestId(`debug-row-${key}`).innerText();
  return text.replace(/^[^\d-]*/, '').trim();
};

const box = await page.getByTestId('game-canvas').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// 1. Look down so the crosshair lands on the block under the player's feet.
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let i = 0; i < 12; i += 1) {
  await page.mouse.move(cx, cy + (i + 1) * 30, { steps: 2 });
  await page.waitForTimeout(50);
}
await page.mouse.up();
await page.waitForTimeout(1200);

const dropsBefore = await readRow('entities');
const trailBefore = await page.getByTestId('debug-row-triangles').innerText();
console.log(`before: drops=${dropsBefore} triangles=${trailBefore.trim()}`);

// 2. Hold the primary button without moving, so drag-to-look cannot interfere.
await page.mouse.move(cx, cy);
await page.mouse.down();
for (let tick = 0; tick < 12; tick += 1) {
  await page.waitForTimeout(500);
  const drops = await readRow('entities');
  // Read the raw row text: the `input` row is `attack=… target=…`, which a
  // digits-only extraction would erase entirely.
  const miningRaw = (await page.getByTestId('debug-row-mining').innerText()).replace(/\s+/g, ' ');
  const inputRaw = (await page.getByTestId('debug-row-input').innerText()).replace(/\s+/g, ' ');
  const facingRaw = (
    await page.getByTestId('hud').locator('[data-row="facing"]').innerText()
  ).replace(/\s+/g, ' ');
  console.log(
    `  t=${((tick + 1) * 0.5).toFixed(1)}s drops=${drops} | ${miningRaw.slice(0, 20)} | ${inputRaw.slice(0, 40)} | ${facingRaw}`,
  );
  if (drops !== dropsBefore) {
    console.log(`mining worked after ~${((tick + 1) * 0.5).toFixed(1)}s: drops=${drops}`);
    break;
  }
}
await page.mouse.up();
await page.waitForTimeout(500);

const dropsAfter = await readRow('entities');
console.log(`after:  drops=${dropsAfter}`);

// 3. Independent signal: the mesh must have changed if a block was removed.
const trianglesAfter = await page.getByTestId('debug-row-triangles').innerText();
console.log(`triangles before=${trailBefore.trim()} after=${trianglesAfter.trim()}`);
console.log(
  dropsBefore !== dropsAfter
    ? 'VERDICT: block breaking works — a drop was produced.'
    : 'VERDICT: block breaking produced no drop.',
);

await page.screenshot({ path: 'test-results/integration/mining.png' });
await browser.close();
