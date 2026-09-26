/**
 * Canopy probe: walk from spawn toward the nearby trees and look straight up, so
 * the leaf underside can be inspected. Also captures a shoreline view with both
 * water and sky in frame.
 *
 * Usage: node .tmp-probe-canopy.mjs <tag> [url]
 */
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const tag = process.argv[2] ?? 'shot';
const url = process.argv[3] ?? 'http://127.0.0.1:4173/';
const outDir = `/tmp/canopy-shots/${tag}`;
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (error) => console.log(`pageerror: ${error.message.slice(0, 200)}`));

await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
await page.waitForSelector('[data-testid="boot-fatal"], [data-testid="main-menu"]', {
  timeout: 45_000,
});
if ((await page.locator('[data-testid="boot-fatal"]').count()) > 0) {
  console.log(
    'FATAL:',
    (await page.locator('[data-testid="boot-fatal"]').innerText()).slice(0, 300),
  );
  await browser.close();
  process.exit(1);
}
await page.click('[data-testid="main-menu-new-world"]');

const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  const chunks = await page.evaluate(
    () => document.querySelector('[data-testid="debug-row-chunks"]')?.textContent ?? null,
  );
  if (chunks !== null && !chunks.includes('—')) break;
  await page.waitForTimeout(500);
}
console.log('world ready');
await page.waitForTimeout(4000);

await page.mouse.click(640, 360);
await page.waitForTimeout(300);

const shoot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('[shot]', name);
};

const look = async (dx, dy) => {
  // 指针锁定下就是靠位移驱动视角；分几步走，避免单帧跳变。
  const steps = 10;
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.move(640 + (dx * (i + 1)) / steps, 360 + (dy * (i + 1)) / steps);
    await page.waitForTimeout(30);
  }
  await page.mouse.move(640, 360);
  await page.waitForTimeout(200);
};

const walk = async (seconds) => {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
};

// I. 出生点平视：同时包含水面与天空。
await shoot('a-spawn-level');

// II. 朝左侧树林走一段，然后抬头看树冠。
await look(-260, 0);
for (const [index, seconds] of [1.6, 1.6, 1.4].entries()) {
  await walk(seconds);
  // 抬头 80° 左右：约 0.0022 rad/px 灵敏度 → 1.4 rad ≈ 636 px。
  await look(0, -640);
  await shoot(`b-up-${index}`);
  // 收回视线，换个方向继续找树。
  await look(0, 640);
  await look(index === 1 ? -160 : 0, 0);
}

await browser.close();
