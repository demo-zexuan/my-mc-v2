import { chromium } from '@playwright/test';
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('[data-testid="main-menu"]', { timeout: 45000 });
await page.waitForSelector('[data-testid="boot-loading"]', { state: 'detached' }).catch(() => {});
await page.getByTestId('main-menu-new-world').click();
await page.waitForSelector('[data-testid="debug-overlay"]', { timeout: 45000 });
await page.waitForTimeout(6000);
// Look down at the ground so the crosshair lands on a solid block.
const box = await page.getByTestId('game-canvas').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
for (let i = 0; i < 10; i += 1) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + (i + 1) * 20);
  await page.waitForTimeout(120);
}
await page.waitForTimeout(1500);
await page.screenshot({ path: 'test-results/integration/04-block-outline.png' });
console.log('position:', await page.getByTestId('debug-row-position').innerText());
await browser.close();
