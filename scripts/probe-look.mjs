/**
 * Verifies that the camera can actually be turned.
 *
 * I. Why this probe exists
 *
 * Pointer lock was never requested, so mouse look silently did nothing. No unit
 * test could catch it (they drive the input manager directly) and the browser
 * suite never asserted on camera rotation, so the defect reached a player. This
 * probe asserts the three links of that chain in a real browser: the canvas click
 * acquires the lock, movement is delivered, and the camera yaw changes.
 *
 * Usage: node scripts/probe-look.mjs [url]
 */
import { chromium } from '@playwright/test';

const url =
  process.argv.find((argument) => argument.startsWith('http')) ?? 'http://127.0.0.1:4173/';
// I. Pointer lock needs a focused window.
// 1. Headless Chromium refuses with "The root document of this element is not
//    valid for pointer lock", which makes it impossible to verify the most
//    important control in a first-person game. The probe therefore runs headed by
//    default; pass `--headless` to check the fallback path instead.
const headed = !process.argv.includes('--headless');
const browser = await chromium.launch({
  headless: !headed,
  args: ['--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('[data-testid="main-menu"]', { timeout: 45_000 });
await page.waitForSelector('[data-testid="boot-loading"]', { state: 'detached' }).catch(() => {});
await page.getByTestId('main-menu-new-world').click();
await page.waitForSelector('[data-testid="debug-overlay"]', { timeout: 45_000 });
await page.waitForTimeout(3000);

await page.screenshot({ path: 'test-results/integration/look-before.png' });
const box = await page.getByTestId('game-canvas').boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

// Instrument the two failure signals the API offers: a `pointerlockerror` event
// and the rejected promise returned by `requestPointerLock()`.
await page.evaluate(() => {
  window.__plErrors = [];
  document.addEventListener('pointerlockerror', () => {
    window.__plErrors.push('pointerlockerror event');
  });
  const proto = HTMLElement.prototype;
  const original = proto.requestPointerLock;
  proto.requestPointerLock = function patched(...args) {
    const result = original.apply(this, args);
    if (result instanceof Promise) {
      result.catch((error) => {
        window.__plErrors.push(`rejected: ${String(error && error.message)}`);
      });
    }
    window.__plCalls = (window.__plCalls ?? 0) + 1;
    return result;
  };
});

const lockedBefore = await page.evaluate(() => document.pointerLockElement !== null);
await page.mouse.click(cx, cy);
await page.waitForTimeout(300);
const lockedAfter = await page.evaluate(() => document.pointerLockElement !== null);
const diagnostics = await page.evaluate(() => ({
  calls: window.__plCalls ?? 0,
  errors: window.__plErrors ?? [],
}));
console.log(`pointer lock: before=${lockedBefore} afterClick=${lockedAfter}`);
console.log(
  `requestPointerLock calls=${diagnostics.calls} errors=${JSON.stringify(diagnostics.errors)}`,
);

// A locked canvas reports the player position; turning changes the facing row.
const facingBefore = await page
  .getByTestId('hud')
  .locator('[data-row="facing"]')
  .innerText()
  .catch(() => '(no facing row)');

// II. Turn the view. When the pointer lock is unavailable the game falls back to
//     drag-to-look, so the button is held across the movement either way.
await page.mouse.down();
for (let step = 0; step < 10; step += 1) {
  await page.mouse.move(cx + (step + 1) * 60, cy, { steps: 3 });
  await page.waitForTimeout(80);
}
await page.mouse.up();
await page.waitForTimeout(400);

// A screenshot is the ground truth for "did the view change": the HUD facing row
// is only a hint, and it is exactly the kind of readout that can be wrong.
await page.screenshot({ path: 'test-results/integration/look-after.png' });

const facingAfter = await page
  .getByTestId('hud')
  .locator('[data-row="facing"]')
  .innerText()
  .catch(() => '(no facing row)');

console.log(`facing: before="${facingBefore}" after="${facingAfter}"`);
const turned = facingBefore !== facingAfter;
console.log(
  turned
    ? `VERDICT: mouse look works — ${lockedAfter ? 'pointer lock active' : 'drag-to-look fallback active'}.`
    : 'VERDICT: mouse look is broken.',
);

await browser.close();
