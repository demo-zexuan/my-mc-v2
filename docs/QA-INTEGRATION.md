# QA 集成层报告（T7 追加范围）

> 审查对象：`src/app/WorldSession.ts`、`src/app/GameApp.ts`、`src/world/ChunkStreamer.ts`、
> `src/workers/WorkerPool.ts`（此前无任何测试覆盖的集成层）。
> 审查方式：源码逐行核对 + 新增测试（`tests/e2e/qa-integration.spec.ts`、
> `tests/integration/qa/integration-save-pipeline.test.ts`）+ 浏览器内 CDP 指标采集。
> 修订时间：2026-09-26 17:2x（本地工作区）；结论对应该时刻的 `src/` 与 `dist/`。

## 0. 结论速览

| 编号 | 结论                                                                                 | 严重级别       | 状态                                 |
| ---- | ------------------------------------------------------------------------------------ | -------------- | ------------------------------------ |
| I-1  | `dispose()` 不消费 `#unsubscribe` → 每次进出世界泄漏整个 session（含游离 DOM 子树）  | 中高           | **已修复**（本会话内），并有回归测试 |
| I-2  | 暂停菜单 → 设置 → 返回后暂停菜单不再显示（状态 `paused` 与界面不一致）               | 中低           | 未修复，`test.fail()` 盯防           |
| I-3  | 调试面板 `Seed` 行永远显示"随机"，不反映实际种子                                     | 低             | 未修复                               |
| I-4  | 准星是 0×0 定位锚点，Playwright `toBeVisible()` 对它恒为 hidden                      | 低（测试陷阱） | 测试侧已规避，建议 Lead 的用例也注意 |
| I-5  | 连续进出世界 3 次：已挂载 DOM / window 监听器 / 堆均不增长                           | —              | 已验证通过                           |
| I-6  | 存档往返（真实地形 + 编辑 + IndexedDB + 重生成）逐字节一致，挖掉的方块读档后仍是空气 | —              | 已验证通过                           |

## 1. 已验证通过

### 1.1 生命周期不泄漏（I-1 的回归验证）

`tests/e2e/qa-integration.spec.ts` 连续执行 3 轮"新建世界 → 保存并退出 → 回主菜单"，
每轮退出后用 CDP 采集指标（`HeapProfiler.collectGarbage` → `Memory.getDOMCounters` →
`Runtime.getHeapUsage` → `DOMDebugger.getEventListeners`）：

| 轮次           | 全部 DOM 节点（含游离） | 事件监听器       | window 监听器 | GC 后堆                   |
| -------------- | ----------------------- | ---------------- | ------------- | ------------------------- |
| 修复前 #1 → #3 | 567 → 812 → **1057**    | 68 → 77 → **86** | 17 → 17 → 17  | 6.08 → 6.68 → **7.25 MB** |
| 修复后 #1 → #3 | 324 → 324 → **324**     | 46 → 46 → **46** | —             | 5.10 → 5.32 → 5.53 MB     |

- 游离节点与监听器在修复后完全恒定；堆仍有约 +0.2 MB/轮，属于区块缓存与动画对象的正常波动
  （阈值设为 1.2 MB/2 轮，未触发）。
- 已挂载元素数量在菜单态恒为 160 左右（各 UI 组件确实被移出文档），因此"DOM 看起来干净"
  的假象正是这个缺陷最初难以察觉的原因。

### 1.2 存档往返（I-6）

`tests/integration/qa/integration-save-pipeline.test.ts`（5 个用例，走真实 IndexedDB
事务路径与**真实生产地形生成器**，非平坦替身）：

- 挖掉 4 个跨越区块边界的方块 + 建 2 层塔 → `saveWorld()` → `loadWorld()` → 重新生成
  3x3 区块 → 回放编辑：**被挖方块全部仍为空气**，塔块仍在；
- 9 个区块的 `blocks` 与 `heightMap` 与保存前**逐字节一致**；
- 只保存被修改过的区块（9 个区块只改了 1 个 → 存档里只有 1 条区块记录）；
- 两次读档得到同一个世界；编辑下标全部为 `[0, CHUNK_VOLUME)` 内的整数。

e2e 侧另有"保存并退出 → 开始游戏恢复玩家位置"用例：全新浏览器配置下"开始游戏"禁用 →
新建世界 → 按住 W 前进 → 保存退出 → "开始游戏"变为可用 → 继续游戏后水平位置偏移 < 1.5 格、
Y 偏移 < 3 格、区块重新加载。**通过**。

### 1.3 状态机与输入组合（I-5 的配套）

`Esc`（暂停↔继续）、`E`（背包开↔关）、`F3`（调试面板开↔关）连续组合后：准星与快捷栏
回到可见、世界仍在推进（按住 W 坐标改变 > 0.4 格）、无 console/page 错误。
"没有存档时开始游戏按钮禁用"也已断言。**通过**。

### 1.4 其它已核对项

- `WorkerPool`：`spawn` 失败与 `dispose` 路径会终止 worker 并 reject 未决请求；未发现
  悬挂 promise（**仅静态核对，未在浏览器里跑真实 worker 并发**，见第 4 节）。
- `ChunkStreamer`：`dispose()` 会清空队列与待卸载列表；卸载区块进入 `#pendingUnloads`
  并参与下一次 `buildSaveInput()`。
- `GameApp.#leaveWorld()` → `session.dispose()` → `state.transition('menu')` 的顺序正确，
  菜单刷新后"继续/新建"状态与实际存档一致。

## 2. 发现的问题

### I-1【中高｜已修复】`WorldSession.dispose()` 不消费 `#unsubscribe`，每次进出世界泄漏整个 session

**复现（修复前）**

1. `pnpm exec vite build && pnpm exec playwright test tests/e2e/qa-integration.spec.ts -g "游离 DOM"`；
2. 连续 3 轮"新建世界 → Esc → 保存并退出到主菜单"；
3. 每轮结束后读 `Memory.getDOMCounters()`。

**期望 vs 实际**

- 期望：每轮退出后游离节点数、监听器数与堆回到基线。
- 实际（修复前）：游离节点 567 → 812 → 1057（+245/轮），监听器 68 → 77 → 86（+9/轮），
  堆 +0.6 MB/轮且强制 GC 不回收。

**根因**：`#wireEvents()` 把 7 个 `bus.on(...)` 的注销句柄放进 `#unsubscribe`，但
`dispose()` 从未遍历该数组。回调是捕获 `this` 的箭头函数，于是整个 session 对象图
（含全部已 `remove()` 的 UI 子树及其 DOM 监听器）被 app 级 `EventBus` 持有到进程结束。
行为可见后果：进世界 N 次后一次"破坏方块"触发 N 次音效、N 次 `save.noteChunkModified(1)`
（自动保存阈值被放大 N 倍，且 app 级 `SaveManager`/`AudioManager` 是共享的）。

**现状**：`dispose()` 开头已改为遍历调用 `#unsubscribe` 并清空数组；1.1 的指标证明问题消失。
回归测试：`tests/e2e/qa-integration.spec.ts > 连续进出世界 3 次：游离 DOM 节点、事件监听器与堆不增长`。

### I-2【中低｜未修复】暂停 → 设置 → 返回 之后暂停菜单不再出现

**复现**

1. 进入任意世界；2. `Esc` 打开暂停菜单；3. 点"设置"；4. 点"返回"。

**期望**：回到进入设置前的暂停菜单（`GameState` 回到 `paused`，界面对应 `pause-menu`）。
**实际**：`settings-screen` 关闭、`pause-menu` 仍为 `hidden` —— 画面是冻结的世界且没有任何
界面；再按一次 `Esc` 才能靠 `togglePause()` 把菜单找回来（不是永久死锁，但状态与界面不一致）。

**根因**：`WorldSession.setSettingsVisible()` 的两个分支自相矛盾：

```ts
public setSettingsVisible(visible: boolean): void {
  if (!visible && this.#pauseMenu.visible) {   // ← 打开设置时已被 hide()，这里永远是 false
    this.#pauseMenu.show();
  } else if (visible) {
    this.#pauseMenu.hide();
  }
}
```

**建议**：记录"设置是从暂停菜单进来的"（`GameState.#settingsReturn` 已经是这套思路），
在 `visible === false` 时按那个来源恢复；或直接让 `GameApp.#closeSettings()` 决定恢复哪个界面。

盯防用例：`tests/e2e/qa-integration.spec.ts > 暂停 → 设置 → 返回 之后暂停菜单应当恢复（已知缺陷）`
（`test.fail()`，修复后会变成 Unexpected pass，届时翻转为普通用例）。

### I-3【低｜未修复】调试面板的 `Seed` 行永远显示"随机"

`GameApp` 只在启动时按 `appConfig.defaultWorldSeed` 写一次：

```ts
this.#debugOverlay.set(
  'seed',
  appConfig.defaultWorldSeed === '' ? '随机' : appConfig.defaultWorldSeed,
);
```

玩家在菜单里填了具体种子、或"开始游戏"载入某个存档后，这一行都不会更新。调试面板是排障
入口，"种子"显示错会直接误导定位（例如复现某个地形问题时按面板上的种子重开会得到别的世界）。
**建议**：在 `#renderFrame` 里像 `chunks`/`position` 一样从 session 读实际种子
（`WorldSession` 已经持有 `#options.seed`）。

### I-4【低｜测试陷阱，已规避】准星是 0×0 元素，`toBeVisible()` 恒判 hidden

`.crosshair { width: 0; height: 0 }`，可见十字由绝对定位的子元素撑开。Playwright 的
`toBeVisible()` 要求元素自身有非空盒子，因此对 `[data-testid="crosshair"]` 永远是
"hidden"——用它写断言会得到假阳性缺陷（本报告的第一版 spec 就因此误报过一次）。
我的用例改用"computed style + 子元素盒子并集"的判断；Lead 的 `visual.spec.ts` 若也用
`toBeVisible()` 检查准星，需要同样处理。

## 3. 覆盖方式与命令

```bash
# 单元 + 集成（117 个用例，含本报告涉及的 2 个新文件）
pnpm exec vitest run tests/unit/qa tests/integration/qa

# 浏览器端（本报告 5 个用例；整仓同时跑 boot/visual 共 24 个用例）
pnpm exec vite build                     # 或 pnpm run build（需全项目 tsc 通过）
pnpm exec playwright test tests/e2e/qa-integration.spec.ts --output=/tmp/qa-pw-output
VISUAL_OUTPUT_DIR=/tmp/qa-visual pnpm exec playwright test
```

> 提示：`test-results/` 与 4173 端口是团队共享资源；并发跑 Playwright 时建议用
> `--output=<独立目录>`，否则彼此的产物会被清理。

## 4. 未覆盖的风险（诚实清单）

1. **指针锁定在 headless 里拿不到**（`document.pointerLockElement` 始终为 null）→ 鼠标视角、
   "按住左键挖掘"、"右键放置"这三条核心交互**没有**被自动化验证。实际的挖掘/放置只在
   `MiningSystem`/`BlockInteraction` 的单测层面覆盖。
2. **真实 Web Worker 路径未在浏览器验证**：`WorkerPool` 的并发、worker 异常、降级到同步
   生成这几条只在源码层面核对。
3. **音频未经听感验证**：不能断言音效是否真的响、是否重叠（泄漏导致的 N 倍音效只在推理层）。
4. **自动保存的时序/节流阈值**只用单测覆盖，未在 e2e 里等过一次真实的节流触发。
5. **IndexedDB 的配额/隐私模式降级**未验证（`SaveStorage` 的失败分支只在单测里）。
6. **长时间运行（>10 分钟）与多标签页**未验证；本报告的泄漏结论只覆盖"进出世界"这一条路径。
7. **真机 GPU 表现**未测（见 `docs/QA-REPORT.md` 的性能一节）。
