import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  collectDiagnostics,
  expectNoSevereDiagnostics,
  startNewWorld,
  waitForMainMenu,
  waitForWorldReady,
} from './support/harness';
import {
  analyseRegion,
  countDistinctColours,
  decodeScreenshot,
  dominantColourShare,
  type DecodedImage,
} from './support/image';

/**
 * QA 视觉验收（T7）。
 *
 * I. 这份 spec 为什么独立于 `visual.spec.ts`
 *
 * `visual.spec.ts` 是 Phase 0 针对烟雾场景写的，启动后直接进游戏。接入真实游戏后
 * 入口变成了「主菜单 → 新建世界 → 游玩」，HUD 组件也变成运行期才显示，因此这里
 * 重新按新流程逐项验收：
 *
 * 1. 进入世界后准星 / 快捷栏 / HUD 是否**真的可见**（它们默认 hidden，必须由
 *    playing 状态触发显示，这是一个已经踩过的集成坑）；
 * 2. 准星与快捷栏是否**居中**（DOM 盒子的中心 vs 视口中心）；
 * 3. 面板文字是否溢出（`scrollWidth > clientWidth` 就是被裁掉了）；
 * 4. 画面是否黑屏 / 纯色 / 缺少几何（三角形与 draw call 的下限）；
 * 5. 暂停时连续两帧是否稳定（抓闪烁与 Z-fighting 抖动）；
 * 6. 视口变化后居中与溢出是否仍然成立。
 *
 * 所有断言都用「下限/上限」而不是固定像素值，避免一次合理的美术调整就把套件打红；
 * 真正需要人眼判断的东西（颜色协调、裂缝、Z-fighting 的具体位置）通过
 * `test-results/visual/qa-*.png` 留档，由人工/Agent 用 read_image 复核。
 */

/** 截图落盘目录，与 `visual.spec.ts` 共用同一约定。 */
const VISUAL_OUTPUT_DIR = process.env['VISUAL_OUTPUT_DIR'] ?? 'test-results/visual';

/** 固定种子，让两次运行的画面可比。 */
const QA_SEED = 'qa-visual-seed';

test.describe('QA 视觉验收', () => {
  // 软件渲染下生成 200 个区块并建网格需要十几秒，给足余量。
  test.setTimeout(150_000);

  /** 截图并落盘，返回解码后的像素数据。 */
  async function capture(page: Page, name: string): Promise<DecodedImage> {
    const buffer = await page.screenshot({ type: 'png' });
    await mkdir(VISUAL_OUTPUT_DIR, { recursive: true });
    await writeFile(join(VISUAL_OUTPUT_DIR, `${name}.png`), buffer);
    return decodeScreenshot(buffer);
  }

  /**
   * 读取一个元素的可见性与盒模型。
   *
   * @param locator - 目标元素。
   */
  async function boxOf(locator: Locator): Promise<{
    readonly visible: boolean;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly centerX: number;
    readonly centerY: number;
    readonly overflowX: number;
    readonly overflowY: number;
  }> {
    return locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return {
        visible:
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          !element.hasAttribute('hidden'),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        centerX: rect.x + rect.width / 2,
        centerY: rect.y + rect.height / 2,
        overflowX: element.scrollWidth - element.clientWidth,
        overflowY: element.scrollHeight - element.clientHeight,
      };
    });
  }

  test('进入世界后准星、快捷栏与 HUD 都可见且居中', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);

    await page.goto('/');
    await waitForMainMenu(page);
    await capture(page, 'qa-01-main-menu');

    await startNewWorld(page, QA_SEED);
    await page.waitForTimeout(1500);
    const image = await capture(page, 'qa-02-world');

    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const centerX = (viewport?.width ?? 1280) / 2;
    const centerY = (viewport?.height ?? 720) / 2;

    // I. 三个 HUD 组件都必须在游玩状态下真正显示。
    // 1. 它们的构造函数把自己设为 hidden，只有 playing 状态调用 show() 才可见；
    //    漏掉这一步的表现就是"画面正常但没有任何准星/快捷栏"，DOM 断言可以稳定
    //    地抓住它，而纯截图对比做不到。
    const crosshair = await boxOf(page.getByTestId('crosshair'));
    const hotbar = await boxOf(page.getByTestId('hotbar'));
    const hud = await boxOf(page.getByTestId('hud'));
    expect(crosshair.visible, '准星不可见').toBe(true);
    expect(hotbar.visible, '快捷栏不可见').toBe(true);
    expect(hud.visible, 'HUD 不可见').toBe(true);

    // II. 准星必须落在屏幕正中：偏移超过 1.5px 就说明定位方式被改坏了
    //     （例如用了 top/left 百分比却漏了 translate(-50%, -50%)）。
    expect(
      Math.abs(crosshair.centerX - centerX),
      `准星 X 偏移 ${crosshair.centerX - centerX}`,
    ).toBeLessThan(1.5);
    expect(
      Math.abs(crosshair.centerY - centerY),
      `准星 Y 偏移 ${crosshair.centerY - centerY}`,
    ).toBeLessThan(1.5);

    // III. 快捷栏也必须水平居中，并且有 9 个格子。
    expect(
      Math.abs(hotbar.centerX - centerX),
      `快捷栏 X 偏移 ${hotbar.centerX - centerX}`,
    ).toBeLessThan(1.5);
    expect(hotbar.y, '快捷栏应贴在画面底部').toBeGreaterThan((viewport?.height ?? 720) * 0.75);
    const slotCount = await page.locator('[data-testid="hotbar"] .hotbar__slot').count();
    expect(slotCount, '快捷栏格数').toBe(9);

    // IV. 文字不得溢出：`scrollWidth - clientWidth > 0` 意味着内容被裁掉。
    for (const [name, locator] of [
      ['调试面板', page.getByTestId('debug-overlay')],
      ['HUD', page.getByTestId('hud')],
      ['快捷栏', page.getByTestId('hotbar')],
    ] as const) {
      const box = await boxOf(locator);
      expect(box.overflowX, `${name} 横向溢出`).toBeLessThanOrEqual(1);
      expect(box.overflowY, `${name} 纵向溢出`).toBeLessThanOrEqual(1);
    }

    // V. 调试面板留在左上角，且不能盖住屏幕中心（准星位置）。
    const overlay = await boxOf(page.getByTestId('debug-overlay'));
    expect(overlay.x).toBeLessThan(64);
    expect(overlay.y).toBeLessThan(64);
    const coversCrosshair =
      centerX >= overlay.x &&
      centerX <= overlay.x + overlay.width &&
      centerY >= overlay.y &&
      centerY <= overlay.y + overlay.height;
    expect(coversCrosshair, '调试面板盖住了准星位置').toBe(false);

    // VI. HUD 的每一行都要有内容，空行说明快照没有接上。
    const hudRows = await page.locator('[data-testid="hud"] .hud__row').allInnerTexts();
    expect(hudRows.length).toBeGreaterThanOrEqual(3);
    for (const row of hudRows) {
      expect(row.trim().length, `HUD 空行：${JSON.stringify(row)}`).toBeGreaterThan(0);
    }

    // VII. 画面本身要有几何与内容，不能停在"只有天空"或黑屏。
    expect(countDistinctColours(image), '画面颜色种类').toBeGreaterThan(60);
    expect(dominantColourShare(image), '单一颜色占比').toBeLessThan(0.9);
    const lowerHalf = analyseRegion(image, {
      name: 'lower',
      x: 0.1,
      y: 0.6,
      width: 0.8,
      height: 0.35,
    });
    expect(lowerHalf.spread, '下半屏色彩方差').toBeGreaterThan(3);

    expectNoSevereDiagnostics(diagnostics);
  });

  test('世界包含真实几何：区块、三角形与 draw call 都在合理区间', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, `${QA_SEED}-geometry`);
    await waitForWorldReady(page);
    await page.waitForTimeout(1500);

    const readNumber = async (key: string): Promise<number> => {
      const text = await page.getByTestId(`debug-row-${key}`).innerText();
      const match = /-?[\d.,]+/.exec(text.replace(/,/g, ''));
      return match === null ? Number.NaN : Number.parseFloat(match[0]);
    };

    const chunks = await readNumber('chunks');
    const triangles = await readNumber('triangles');
    const drawCalls = await readNumber('drawCalls');

    // 下限刻意放得很松：只要 mesher 真的在跑就不可能低于这些值，
    // 而一旦退回 Phase 0 的烟雾场景（26 个三角形 / 3 个 draw call）就会立刻失败。
    expect(chunks, '已加载区块数').toBeGreaterThan(20);
    expect(triangles, '三角形数').toBeGreaterThan(1000);
    expect(drawCalls, 'draw call 数').toBeGreaterThan(10);

    const image = await capture(page, 'qa-03-world-geometry');
    // 天空不能是纯黑：整幅图最亮 1% 像素的均值应当明显高于 0。
    let brightPixels = 0;
    let brightSum = 0;
    for (let y = 0; y < image.height; y += 3) {
      for (let x = 0; x < image.width; x += 3) {
        const { r, g, b } = image.pixel(x, y);
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (luminance > 200) {
          brightPixels += 1;
          brightSum += luminance;
        }
      }
    }
    expect(brightPixels, '画面中几乎没有亮部（疑似黑屏）').toBeGreaterThan(0);
    expect(brightSum / brightPixels, '亮部亮度').toBeGreaterThan(200);
  });

  test('暂停时相邻两帧稳定，没有明显闪烁或抖动', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, `${QA_SEED}-stability`);
    await page.waitForTimeout(1500);

    // 暂停后世界停止推进：此时两帧之间的差异只可能来自渲染不稳定
    //（Z-fighting 抖动、缓冲区未清干净、双重缓冲错位等）。
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);

    const first = await page.screenshot({ type: 'png' });
    await page.waitForTimeout(900);
    const second = await page.screenshot({ type: 'png' });
    await mkdir(VISUAL_OUTPUT_DIR, { recursive: true });
    await writeFile(join(VISUAL_OUTPUT_DIR, 'qa-04-paused.png'), second);

    const a = decodeScreenshot(first);
    const b = decodeScreenshot(second);
    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);

    let total = 0;
    let changed = 0;
    let samples = 0;
    for (let y = 0; y < a.height; y += 2) {
      for (let x = 0; x < a.width; x += 2) {
        const p = a.pixel(x, y);
        const q = b.pixel(x, y);
        const delta = (Math.abs(p.r - q.r) + Math.abs(p.g - q.g) + Math.abs(p.b - q.b)) / 3;
        total += delta;
        if (delta > 24) {
          changed += 1;
        }
        samples += 1;
      }
    }

    const meanDelta = total / samples;
    const changedShare = changed / samples;
    // 阈值很松：真正的问题（整屏闪烁/来回抖动的面）会让 meanDelta 达到几十，
    // 而云层或时钟动画只影响很小的区域。
    expect(meanDelta, `暂停后两帧平均差异 ${meanDelta.toFixed(3)}`).toBeLessThan(6);
    expect(changedShare, `暂停后变化像素占比 ${(changedShare * 100).toFixed(2)}%`).toBeLessThan(
      0.06,
    );
    expectNoSevereDiagnostics(diagnostics);
  });

  test('改变视口后准星与快捷栏仍然居中且不溢出', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, `${QA_SEED}-resize`);
    await page.waitForTimeout(1200);

    for (const size of [
      { width: 1024, height: 640 },
      { width: 1600, height: 900 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(700);

      const centerX = size.width / 2;
      const crosshair = await boxOf(page.getByTestId('crosshair'));
      const hotbar = await boxOf(page.getByTestId('hotbar'));
      const hud = await boxOf(page.getByTestId('hud'));

      expect(crosshair.visible, `${size.width}x${size.height} 准星不可见`).toBe(true);
      expect(hotbar.visible, `${size.width}x${size.height} 快捷栏不可见`).toBe(true);
      expect(hud.visible, `${size.width}x${size.height} HUD 不可见`).toBe(true);
      expect(Math.abs(crosshair.centerX - centerX)).toBeLessThan(1.5);
      expect(Math.abs(hotbar.centerX - centerX)).toBeLessThan(1.5);
      expect(hotbar.x, '快捷栏越出左边界').toBeGreaterThanOrEqual(0);
      expect(hotbar.x + hotbar.width, '快捷栏越出右边界').toBeLessThanOrEqual(size.width);
      expect(hud.x, 'HUD 越出左边界').toBeGreaterThanOrEqual(0);
      expect(hud.y + hud.height, 'HUD 越出下边界').toBeLessThanOrEqual(size.height);
      // 窄视口下快捷栏会收缩，溢出的判定同理。
      expect(hotbar.overflowX).toBeLessThanOrEqual(1);
      expect(hud.overflowX).toBeLessThanOrEqual(1);
    }
  });

  test('天空与雾在地平线以上保持蓝调且不是纯色', async ({ page }) => {
    await page.goto('/');
    await waitForMainMenu(page);
    await startNewWorld(page, `${QA_SEED}-sky`);
    await page.waitForTimeout(1500);

    const image = await capture(page, 'qa-05-sky');
    // 采样右上角，避开左上角的调试面板与中部的 HUD。
    const sky = analyseRegion(image, { name: 'sky', x: 0.6, y: 0.02, width: 0.35, height: 0.1 });

    // 白天/黄昏/夜晚的相位取决于世界时钟，这里只断言"不是黑屏、不是纯色、
    // 蓝色分量不低"这三条与相位无关的性质。
    expect(sky.spread, '天空区域是纯色（可能是渐变没生效）').toBeGreaterThan(0.5);
    expect(sky.b, '天空蓝色分量过低（疑似黑屏或纯黑天空）').toBeGreaterThan(20);
    const skyColours = countDistinctColours(image);
    expect(skyColours).toBeGreaterThan(60);
  });
});
