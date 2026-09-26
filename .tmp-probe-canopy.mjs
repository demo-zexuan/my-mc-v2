import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const tag = process.argv[2] ?? 'shot';
const url = process.argv[3] ?? 'http://127.0.0.1:4175/';
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
await page.waitForTimeout(400);

const shoot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log('[shot]', name);
};

const yawSweep = async (distance) => {
  const from = distance > 0 ? 40 : 1240;
  const to = distance > 0 ? 1240 : 40;
  await page.mouse.move(from, 360);
  await page.mouse.move(to, 360, { steps: 16 });
  await page.waitForTimeout(250);
};

const lookUp = async () => {
  await page.mouse.move(640, 700);
  await page.mouse.move(640, 20, { steps: 16 });
  await page.waitForTimeout(250);
};

const lookLevel = async () => {
  await page.mouse.move(640, 20);
  await page.mouse.move(640, 700, { steps: 16 });
  await page.waitForTimeout(250);
};

const walk = async (seconds) => {
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
};

await shoot('a-spawn-level');
await yawSweep(-1);
await walk(2.2);
await lookUp();
await shoot('b-up-0');

await lookLevel();
await walk(1.2);
await yawSweep(1);
await lookUp();
await shoot('b-up-1');

await lookLevel();
await walk(1.2);
await yawSweep(1);
await lookUp();
await shoot('b-up-2');

await lookLevel();
await walk(1.4);
await lookUp();
await shoot('b-up-3');

await browser.close();
