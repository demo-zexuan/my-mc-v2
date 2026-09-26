import { expect, test, type Locator, type Page } from '@playwright/test';

import { collectDiagnostics, expectNoSevereDiagnostics, waitForMainMenu } from './support/harness';

/**
 * 集成层验收（T7 QA 追加范围）。
 *
 * I. 为什么要有这一份
 *
 * `qa-visual.spec.ts` 只看画面，Lead 的 `boot.spec.ts` 只看启动；两者都不碰
 * **世界的生命周期**。而"回到主菜单再进一次"这条路径最容易出两类问题：
 *
 * 1. **泄漏**：`WorldSession` 构造了 WorkerPool / ChunkStreamer / InputManager /
 *    WorldRenderer / Sky / BlockAtlas 与全部 UI 组件，并往 `EventBus` 挂了 7 个监听器。
 *    只要有一个监听器没被注销，闭包就会把整个 session（含所有已被移除的 UI 子树）钉在
 *    内存里；再进世界时事件被重复处理（N 倍音效、N 倍自动保存计数）。
 * 2. **状态机卡死**：Esc / E / F3 与"暂停 → 设置 → 返回"组合时，`GameStateMachine`
 *    与各面板的可见性必须始终一致，否则会出现"界面关了但状态还停在 paused"导致玩家动不了。
 *
 * II. 指标为什么走 CDP
 *
 * `document.querySelectorAll('*')` 只能看到**已挂载**的节点，而泄漏恰恰发生在**游离**
 * 节点上。因此用 `Memory.getDOMCounters`（含游离节点与监听器总数）、
 * `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`（强制回收后的真实占用）、
 * `DOMDebugger.getEventListeners`（window 上的监听器）。
 */

/** CDP 会话的最小结构；Playwright 没有从 `@playwright/test` 导出 `CDPSession`。 */
interface CdpSession {
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  detach(): Promise<void>;
}

/** 一轮"进世界 → 退出到主菜单"之后的指标快照。 */
interface LifecycleMetrics {
  /** 渲染进程里的全部 DOM 节点，含游离节点。 */
  readonly nodes: number;
  /** 页面里注册的 DOM 事件监听器总数。 */
  readonly listeners: number;
  /** 挂在 `window` 上的监听器数量。 */
  readonly windowListeners: number;
  /** 强制 GC 之后的 JS 堆占用（MB）。 */
  readonly heapMb: number;
  /** 实际挂载在文档里的元素数量。 */
  readonly attachedElements: number;
}

/** 打开一个 CDP 会话。 */
async function openCdp(page: Page): Promise<CdpSession> {
  return (await page.context().newCDPSession(page)) as unknown as CdpSession;
}

/**
 * 采集一次生命周期指标（采集前强制 GC，避免把待回收对象算成泄漏）。
 *
 * @param page - 页面。
 */
async function readMetrics(page: Page): Promise<LifecycleMetrics> {
  const cdp = await openCdp(page);
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    const dom = await cdp.send<{ nodes: number; jsEventListeners: number }>(
      'Memory.getDOMCounters',
    );
    const heap = await cdp.send<{ usedSize: number }>('Runtime.getHeapUsage');
    const windowHandle = await cdp.send<{ result: { objectId: string } }>('Runtime.evaluate', {
      expression: 'window',
    });
    const listeners = await cdp.send<{ listeners: readonly unknown[] }>(
      'DOMDebugger.getEventListeners',
      { objectId: windowHandle.result.objectId },
    );
    const attachedElements = await page.evaluate(() => document.querySelectorAll('*').length);

    return {
      nodes: dom.nodes,
      listeners: dom.jsEventListeners,
      windowListeners: listeners.listeners.length,
      heapMb: heap.usedSize / 1024 / 1024,
      attachedElements,
    };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * 判断一个 HUD 组件是否真的可见。
 *
 * I. 为什么不能用 Playwright 的 `toBeVisible()`
 *
 * 准星是一个 **0x0 的定位锚点**（`.crosshair { width: 0; height: 0 }`），可见的十字由
 * 绝对定位的子元素撑开。Playwright 的 `toBeVisible()` 要求元素自身有非空盒子，因此对
 * 准星永远返回 "hidden"——用它写断言会得到一个"看起来是缺陷"的假阳性（本 spec 第一版
 * 就踩了这个坑）。这里改为：先看 `display/visibility/hidden/opacity`，盒子为空时再看
 * 子元素的盒子并集。
 *
 * @param locator - 目标组件。
 * @returns 组件是否可见。
 */
async function isWidgetVisible(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      element.hasAttribute('hidden')
    ) {
      return false;
    }
    if (Number.parseFloat(style.opacity) === 0) {
      return false;
    }
    const own = element.getBoundingClientRect();
    if (own.width > 0.5 && own.height > 0.5) {
      return true;
    }
    for (const child of element.children) {
      const rect = child.getBoundingClientRect();
      if (rect.width > 0.5 && rect.height > 0.5) {
        return true;
      }
    }
    return false;
  });
}

/** 从调试面板读出 X Y Z 玩家坐标。 */
async function readPosition(page: Page): Promise<{ x: number; y: number; z: number }> {
  const text = await page.getByTestId('debug-row-position').innerText();
  const numbers = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map((value) => Number.parseFloat(value));
  return { x: numbers[0] ?? 0, y: numbers[1] ?? 0, z: numbers[2] ?? 0 };
}

/** 等待世界真正开始渲染（调试面板报告区块数 > 0）。 */
async function waitForWorld(page: Page): Promise<void> {
  await expect(page.getByTestId('debug-overlay')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const text = await page.getByTestId('debug-row-chunks').innerText();
        const match = /(\d+)/.exec(text);
        return match === null ? 0 : Number.parseInt(match[1] ?? '0', 10);
      },
      { timeout: 40_000, message: '区块没有加载出来' },
    )
    .toBeGreaterThan(0);
}

/** 从主菜单新建一个世界并等待就绪。 */
async function enterWorld(page: Page, seed: string): Promise<void> {
  const seedInput = page.getByTestId('main-menu-seed');
  if ((await seedInput.count()) > 0) {
    await seedInput.fill(seed);
  }
  await page.getByTestId('main-menu-new-world').click();
  await waitForWorld(page);
  await page.waitForTimeout(2500);
}

/** 从世界里"保存并退出"回到主菜单。 */
async function quitToMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('pause-menu')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('pause-menu-quit').click();
  await waitForMainMenu(page);
  await page.waitForTimeout(500);
}

/** 跑 `count` 轮"进世界 → 退出"，返回每轮退出后的指标。 */
async function runLifecycleCycles(
  page: Page,
  count: number,
  seedPrefix: string,
): Promise<readonly LifecycleMetrics[]> {
  const cycles: LifecycleMetrics[] = [];
  for (let cycle = 0; cycle < count; cycle += 1) {
    await enterWorld(page, `${seedPrefix}-${cycle}`);
    await quitToMenu(page);
    cycles.push(await readMetrics(page));
  }
  return cycles;
}

/** 把指标数组格式化成一行，便于失败信息与报告引用。 */
function formatCycles(cycles: readonly LifecycleMetrics[]): string {
  return cycles
    .map(
      (entry, index) =>
        `#${index + 1} nodes=${entry.nodes} listeners=${entry.listeners} heap=${entry.heapMb.toFixed(2)}MB`,
    )
    .join(' | ');
}

test.describe('QA 集成层', () => {
  test.setTimeout(240_000);

  test('连续进出世界 3 次：已挂载的 DOM 与 window 监听器保持稳定', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);

    await page.goto('/');
    await waitForMainMenu(page);
    const baseline = await readMetrics(page);

    const cycles = await runLifecycleCycles(page, 3, 'qa-lifecycle');
    const first = cycles[0];
    const last = cycles[2];
    expect(first, '第一轮指标缺失').toBeDefined();
    expect(last, '第三轮指标缺失').toBeDefined();

    // I. 已挂载的元素数量必须回到菜单基线附近：UI 子树被真正从文档上摘掉了。
    //    这一条现在就是绿的，它是"dispose 至少把东西从 DOM 上移除了"的证据。
    expect(baseline.attachedElements).toBeGreaterThan(50);
    expect(
      (last?.attachedElements ?? 0) - (first?.attachedElements ?? 0),
      `每轮退出后挂载元素数仍在增长（${formatCycles(cycles)}）`,
    ).toBeLessThanOrEqual(20);

    // II. GameApp 自己的 window 监听器是应用级的，数量必须恒定（不随世界轮次增长）。
    expect(
      (last?.windowListeners ?? 0) - (first?.windowListeners ?? 0),
      `window 监听器随世界轮次增长（${formatCycles(cycles)}）`,
    ).toBeLessThanOrEqual(2);

    expectNoSevereDiagnostics(diagnostics);
  });

  test('连续进出世界 3 次：游离 DOM 节点、事件监听器与堆不增长', async ({ page }) => {
    // 回归测试（本会话内先失败、后修复）。
    //
    // 缺陷原文：`WorldSession.#wireEvents()` 往 `#unsubscribe` 里塞了 7 个注销句柄，
    // 但 `dispose()` 没有消费这个数组。回调闭包捕获了 `this`，于是**整个 session 对象图**
    // （含所有已被 remove() 的 UI 子树）活到进程结束。修复前实测：
    //   - `Memory.getDOMCounters().nodes` 每轮 +245（游离节点，三轮 567 → 812 → 1057）；
    //   - `jsEventListeners` 每轮 +9（68 → 77 → 86）；
    //   - 强制 GC 后堆每轮 +0.6 MB；
    //   - 行为上：进世界 N 次后一次"破坏方块"会触发 N 次音效、N 次
    //     `save.noteChunkModified(1)`（自动保存阈值被放大 N 倍）以及 N 条写进游离
    //     NoticeStack 的提示（玩家看不到，但节点一直累积）。
    //
    // 修复（`dispose()` 开头遍历调用 `#unsubscribe`）之后下面的断言全部成立，
    // 这条用例就是防止它再次退化。
    await page.goto('/');
    await waitForMainMenu(page);

    const cycles = await runLifecycleCycles(page, 3, 'qa-leak');
    const first = cycles[0];
    const last = cycles[2];
    const summary = formatCycles(cycles);
    test.info().annotations.push({ type: 'lifecycle-metrics', description: summary });
    // 指标打印到测试输出，便于把每一轮的真实数字写进 QA 报告。
    console.log(`[qa] 生命周期指标：${summary}`);

    expect(
      (last?.nodes ?? 0) - (first?.nodes ?? 0),
      `游离 DOM 节点在 2 轮里增长了 ${(last?.nodes ?? 0) - (first?.nodes ?? 0)}（${summary}）`,
    ).toBeLessThanOrEqual(20);
    expect(
      (last?.listeners ?? 0) - (first?.listeners ?? 0),
      `事件监听器在 2 轮里增长了 ${(last?.listeners ?? 0) - (first?.listeners ?? 0)}（${summary}）`,
    ).toBeLessThanOrEqual(2);
    expect(
      (last?.heapMb ?? 0) - (first?.heapMb ?? 0),
      `强制 GC 后堆在 2 轮里增长了 ${((last?.heapMb ?? 0) - (first?.heapMb ?? 0)).toFixed(2)} MB（${summary}）`,
    ).toBeLessThanOrEqual(1.2);
  });

  test.fail('暂停 → 设置 → 返回 之后暂停菜单应当恢复（已知缺陷）', async ({ page }) => {
    // 已知缺陷（QA 结论，未修复）：`WorldSession.setSettingsVisible()` 的两个分支互相
    // 矛盾 —— 打开设置时 `setSettingsVisible(true)` 会 `#pauseMenu.hide()`，而关闭设置时
    // `setSettingsVisible(false)` 只在 `#pauseMenu.visible` 为真时才 `show()`。此时它必然
    // 为假，于是从设置返回后：`GameState` 已经回到 `paused`，**但暂停菜单没有重新显示**，
    // 玩家看到的是一幅冻结、没有任何界面的画面（再按一次 Esc 才能靠 `togglePause()` 找回
    // 菜单，所以不是永久死锁，但状态与界面明显不一致）。
    //
    // `test.fail()`：修复后本用例会变成 Unexpected pass，届时翻转成普通 `test(...)`。
    await page.goto('/');
    await waitForMainMenu(page);
    await enterWorld(page, 'qa-settings-return');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('pause-menu-settings').click();
    await expect(page.getByTestId('settings-screen')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('settings-screen')).toBeHidden({ timeout: 10_000 });

    // 期望：回到暂停菜单（它是进入设置前的界面）。
    await expect(page.getByTestId('pause-menu')).toBeVisible({ timeout: 5_000 });
  });

  test('Esc / E / F3 组合后界面与状态仍一致', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);
    await page.goto('/');
    await waitForMainMenu(page);

    // I. 没有存档时"开始游戏"必须是禁用的，而不是点了没反应。
    await expect(page.getByTestId('main-menu-start')).toBeDisabled();

    await enterWorld(page, 'qa-state-machine');

    const crosshair = page.getByTestId('crosshair');
    const hotbar = page.getByTestId('hotbar');
    const debugOverlay = page.getByTestId('debug-overlay');
    expect(await isWidgetVisible(crosshair), '进入世界后准星不可见').toBe(true);
    expect(await isWidgetVisible(hotbar), '进入世界后快捷栏不可见').toBe(true);

    // II. Esc 开暂停 → 再 Esc 回到游玩。HUD 必须跟着回来。
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeHidden({ timeout: 10_000 });
    expect(await isWidgetVisible(crosshair), '从暂停返回后准星不可见').toBe(true);
    expect(await isWidgetVisible(hotbar), '从暂停返回后快捷栏不可见').toBe(true);

    // III. E 开背包 → 再 E 关闭。
    await page.keyboard.press('e');
    await expect(page.getByTestId('inventory-screen')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('e');
    await expect(page.getByTestId('inventory-screen')).toBeHidden({ timeout: 10_000 });
    expect(await isWidgetVisible(crosshair), '从背包返回后准星不可见').toBe(true);

    // IV. F3 切换调试面板两次，最终回到可见。
    await expect(debugOverlay).toBeVisible();
    await page.keyboard.press('F3');
    await expect(debugOverlay).toBeHidden({ timeout: 10_000 });
    await page.keyboard.press('F3');
    await expect(debugOverlay).toBeVisible({ timeout: 10_000 });

    // V. 组合操作之后世界仍在推进：按住 W 应当改变坐标。
    const before = await readPosition(page);
    await page.keyboard.down('w');
    await page.waitForTimeout(1500);
    await page.keyboard.up('w');
    await page.waitForTimeout(400);
    const after = await readPosition(page);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    expect(
      moved,
      `按键序列之后玩家没有移动（${JSON.stringify(before)} → ${JSON.stringify(after)}）`,
    ).toBeGreaterThan(0.4);

    expectNoSevereDiagnostics(diagnostics);
  });

  test('保存并退出后用「开始游戏」恢复玩家位置', async ({ page }) => {
    const diagnostics = collectDiagnostics(page);
    await page.goto('/');
    await waitForMainMenu(page);
    await expect(
      page.getByTestId('main-menu-start'),
      '全新浏览器配置里不应存在存档',
    ).toBeDisabled();

    await enterWorld(page, 'qa-save-roundtrip');

    // I. 先走一段路，让"保存的位置"与出生点明显不同。
    await page.keyboard.down('w');
    await page.waitForTimeout(1800);
    await page.keyboard.up('w');
    await page.waitForTimeout(600);
    const savedPosition = await readPosition(page);

    await quitToMenu(page);

    // II. 退出后"开始游戏"必须可用（存档确实写入了）。
    await expect(page.getByTestId('main-menu-start')).toBeEnabled();

    // III. 继续游戏 → 必须回到同一个世界、同一个位置。
    await page.getByTestId('main-menu-start').click();
    await waitForWorld(page);
    await page.waitForTimeout(1500);
    const restoredPosition = await readPosition(page);

    const drift = Math.hypot(
      restoredPosition.x - savedPosition.x,
      restoredPosition.z - savedPosition.z,
    );
    expect(
      drift,
      `读档后的水平位置偏移 ${drift.toFixed(2)}（保存 ${JSON.stringify(savedPosition)} → 恢复 ${JSON.stringify(restoredPosition)}）`,
    ).toBeLessThan(1.5);
    expect(Math.abs(restoredPosition.y - savedPosition.y)).toBeLessThan(3);

    // IV. 区块重新加载出来了，说明世界是被恢复而不是卡在空场景。
    await expect
      .poll(
        async () => {
          const text = await page.getByTestId('debug-row-chunks').innerText();
          const match = /(\d+)/.exec(text);
          return match === null ? 0 : Number.parseInt(match[1] ?? '0', 10);
        },
        { timeout: 30_000 },
      )
      .toBeGreaterThan(20);

    expectNoSevereDiagnostics(diagnostics);
  });
});
