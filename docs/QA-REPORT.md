# QA 报告（T7）

> 角色：独立对抗式 QA。目标不是"让测试变绿"，而是找出别人没发现的真实缺陷。
> 范围：冻结契约（`world/coords`、`world/BlockRegistry`、`world/Chunk`、`world/World`、
> `engine/events/EventBus`）+ 集成层（`app/WorldSession`、`app/GameApp`）+ 视觉与性能验收。
> 时间：2026-09-26；结论对应当前工作区的 `src/`（本报告记录了每条结论的验证方式）。
> 团队集成层的独立报告见 [`QA-INTEGRATION.md`](./QA-INTEGRATION.md)。

## 0. 交付物与结论速览

| 交付物                                           | 内容                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `tests/unit/qa/**`（5 个文件，99 个用例）        | 坐标往返、注册表一致性、高度图对抗式模糊、World 边界语义、EventBus 重入 |
| `tests/integration/qa/**`（2 个文件，18 个用例） | 跨区块编辑流水线、存档往返（真实地形 + IndexedDB）                      |
| `tests/e2e/qa-visual.spec.ts`（5 个用例）        | 新流程（主菜单 → 新建世界）下的画面/HUD/居中/溢出/稳定性                |
| `tests/e2e/qa-integration.spec.ts`（5 个用例）   | 生命周期泄漏、状态机组合、保存-恢复                                     |
| `scripts/measure-perf.mjs`                       | Playwright 驱动生产构建的性能基线（区分软/硬渲染后端）                  |
| 本文件 + `docs/QA-INTEGRATION.md`                | 报告                                                                    |

**缺陷总览（15 项，其中 9 项已在本会话内修复）**

| 编号 | 摘要                                                                 | 级别 | 状态                                |
| ---- | -------------------------------------------------------------------- | ---- | ----------------------------------- |
| D1   | 进入世界后准星 / 快捷栏 / HUD 从未显示                               | 高   | 已修复                              |
| D2   | `WorldSession.dispose()` 泄漏整个 session（游离 DOM + 监听器 + 堆）  | 中高 | 已修复                              |
| D3   | `EventBus` 中抛异常的监听器永久破坏注销机制                          | 中高 | 已修复                              |
| D4   | `World.getBlock` 在未加载区块里 `y<0` 返回 Air 而非 Bedrock          | 中   | 已修复                              |
| D5   | `World.setBlock`/`getBlock` 接受非整数坐标（谎报成功 + 脏 edit log） | 中   | 已修复                              |
| D6   | 暂停 → 设置 → 返回 后暂停菜单不再出现                                | 中低 | **未修复**                          |
| D7   | `EventBus.once` 在重入 emit 时触发两次                               | 中低 | **未修复**                          |
| D8   | 一个监听器抛异常会中断同一次 dispatch 的后续监听器                   | 中   | 已修复                              |
| D9   | `Chunk.applyEdits` 不校验 id/下标（Uint8Array 静默取模）             | 中低 | 已修复                              |
| D10  | `Chunk.lightDirty` 无法清除，`applyEdits` 也不置位                   | 低   | 已修复                              |
| D11  | `generateChunkNow` 的 sink 不校验 y；小数 y 别名到真实方块           | 低   | 已修复                              |
| D12  | `adoptGeneratedChunk` 载荷非法时 pending 残留                        | 低   | 已修复                              |
| D13  | 大面积水面在掠射角下仍有细密摩尔纹                                   | 低   | **未修复**（渲染侧）                |
| D14  | 白天时段天空呈灰紫而非调色板里的蓝                                   | 低   | **未修复**（待渲染 owner 确认意图） |
| D15  | 调试面板 `Seed` 行永远显示"随机"                                     | 低   | **未修复**                          |
| D16  | `BlockRegistry` 对未知 id（22..255）fail-open                        | 低   | **接受为已知风险**                  |
| D17  | `worldToLocalCoord` 对 16 的整数倍返回 `-0`                          | 信息 | 记录                                |

> 说明：D1–D5、D8–D12 是在本会话内**发现后被 owner 修复**并用回归测试锁定的；
> "已修复"指我已用新增测试在当前代码上复验通过，而不是只看代码改动。

---

## 1. 已验证通过

### 1.1 坐标系统（`world/coords`）

- `indexInChunk` ↔ `coordsFromIndex` 对**全部 32768 个合法下标**精确互逆，且下标唯一、覆盖
  `0 .. CHUNK_VOLUME-1`（穷举，不是抽样）。
- 四个角点与 `y=0/127`、`lx/lz=0/15` 的极端下标精确。
- 负数映射：`-1 → chunk -1 / local 15`、`-16 → chunk -1 / local 0`、`-17 → chunk -2 / local 15`；
  对 `-512..512` 全量验证 `chunk*size+local === world` 且 local 恒在 `[0,size)`。
- `chunkKey` 在 `cx,cz ∈ [-256,256]` 的 **513×513** 邻域内往返唯一（263169 个键无碰撞），
  并在 `±1_000_000`、`±2^21-1` 等极端值上往返正确；`cz = ±2^21` 之外会与相邻 cx 静默
  别名（`chunkKey(0,2^21) === chunkKey(1,-2^21)`），属于文档化的 ±16.7M 格限制，
  已写成刻画用例而不是缺陷。
- `isInsideWorldHeight` 只接受 `0..127`，NaN/Infinity 为 false。

### 1.2 方块注册表（`world/BlockRegistry`）

- 22 个定义的 `id === 数组下标`；`BlockId` 常量表与定义一一对应；名字与 id 均唯一。
- 六个 flag 位与声明式定义逐条一致；没有越界位；EMISSIVE 由 tile 的 `emissive` 推导。
- drop 语义：未声明 → 自身 id、`null` → 不掉落、`grass → dirt`；硬度含 `Infinity`（基岩）与
  Float32 精度、不可破坏一致性。
- **未知 id（22..255）不会抛异常**：所有谓词返回 false、硬度 0、掉落 null、
  `lightAttenuationOf` 返回 0（`?? 1` 兜底对真实字节不可达）；只有 `definitionOf` 抛
  `RangeError`。该 fail-open 行为已按 Lead 的决定记录为已知风险（见 D16）。

### 1.3 `Chunk` 高度图与最高方块（重点怀疑项，结论：无缺陷）

- 差分模糊测试：4000 次随机变更（含 Air/水/玻璃/树叶等调色板）后，`heightMap` 与
  `highestNonAir` 与独立影子模型**逐步一致**（每步校验触碰列 + 全局极值，每 97 步全量校验 256 列）。
- 逐列整列挖空（随机列序，从 y=60 挖到 y=0）后全部列高度归 0、极值 -1。
- 移除列顶方块：正确回落到下一个非空气方块；移除全 chunk 最高方块触发重扫并找到**另一列**
  的正确高度；`index = 0` 与 `index = CHUNK_VOLUME-1` 的极端列都覆盖。
- 一次写入 y=0 与 y=127、以及"最高的整列 128 层"（`surfaceHeightAt` = 128）均正确。
- 边界写入返回 false 且不记 edit；同值写入返回 false 且不置脏；`getEdits()` 按下标去重、
  保留最后一次写入；回退成 Air 也记 edit。
- 构造器对非法长度抛 `RangeError`；提供非空数组时正确重建两个缓存。

### 1.4 `World` 边界语义与跨区块脏标记（重点怀疑项，结论：跨区块标记正确）

- **脏标记集合是精确的**：内部方块只标自身；(0,·,0) 角点恰好标 2 个邻居（`(-1,0)`、`(0,-1)`）
  且**不标对角线**；(15,·,15) 标 `(1,0)`、`(0,1)`；负方向跨界（x=-16 → chunk(-2,0)）正确；
  邻居不存在时不抛错也不复活。
- 写入越界 y（-1/128/NaN/Infinity）返回 false 且不置脏；未加载区块写入返回 false。
- `generateChunkNow` 幂等（不重复调用生成器）、`beginGeneration`/`cancelGeneration`/
  `adoptGeneratedChunk` 的 pending 记账正确。
- `trimToCapacity`：按插入顺序丢弃未修改区块、**永不丢弃已修改区块**（必要时允许超出上限）、
  尊重 `protectedKeys`、低于上限时是 no-op。
- `unloadChunk` 对未修改区块返回 null，对已修改区块返回实体；`editedChunks()` 只产出
  被修改过的区块；`clear()` 清空。
- `surfaceHeightAt` 与"自上而下扫描"在 3x3 已加载区域内**全列一致**（含随机挖掘后的地形）；
  未加载区块回退到生成器（文档化行为）。
- 编辑区块"重新生成 + 回放 edit"后与保存前**逐字节一致**（含高度图）。

### 1.5 集成流水线（`tests/integration/qa/world-pipeline.test.ts`）

- 同种子两个独立 `World` 的区块载荷逐字节相同（生成器无跨调用可变状态）。
- `generateChunkNow` 与 `adoptGeneratedChunk` 两条路径产出相同载荷（worker 路径与同步路径一致）。
- 隧道/壕沟横穿 4 条区块边界后逐列高度与扫描一致；2x2 平台跨区块角点时四块各自正确、无空洞。
- 22 种方块全部经字节存储往返后 `definitionOf` 一致；128 层满高柱与逐层拆除正确。
- 2000 次跨 9 个区块的随机编辑与影子模型一致。

### 1.6 `EventBus`

- dispatch 期间取消订阅 → 本次仍被调用、下次不再调用（快照语义）；dispatch 期间订阅 →
  本次不调用、下次调用；嵌套 emit 的延迟删除在外层结束时统一 flush。
- `clear()` 在 dispatch 中调用后仍可用。
- **抛异常的监听器已被隔离**（D3/D8 修复后）：不再毒化 dispatchDepth、后续监听器继续执行、
  `off()` 真正生效、重复订阅/注销不再累积。

### 1.7 视觉验收（`tests/e2e/qa-visual.spec.ts`，5/5 通过）

按新流程（主菜单 → 新建世界 → 游玩）逐项验证：

| 检查项                           | 结论                                                                        | 证据               |
| -------------------------------- | --------------------------------------------------------------------------- | ------------------ |
| 黑屏 / 纯色                      | 通过（颜色种类 > 60、单一颜色占比 < 0.9、下半屏方差 > 3）                   | `qa-02-world.png`  |
| 准星居中                         | 通过（DOM 中心与视口中心偏差 < 1.5px；像素分析质心 639.5/359.5 vs 640/360） | `qa-02-world.png`  |
| Hotbar 居中                      | 通过（9 格、水平居中偏差 < 1.5px、贴底、不溢出）                            | `crop-hotbar.png`  |
| UI 文字溢出                      | 通过（调试面板 / HUD / 快捷栏 `scrollWidth- clientWidth ≤ 1`）              | `qa-02-world.png`  |
| 层级与遮挡                       | 通过（调试面板在左上角、不覆盖屏幕中心；模态 z=38 > HUD z=31~33）           | `qa-02-world.png`  |
| 视口自适应                       | 通过（1024x640、1600x900 下居中与边界仍成立）                               | —                  |
| 帧稳定性（闪烁/Z-fighting 抖动） | 通过（暂停后两帧平均差异 < 6/255、变化像素 < 6%）                           | `qa-04-paused.png` |
| 区块裂缝                         | **未观察到**（沙地/水岸/台阶边缘连续，无 1px 缝隙；但只覆盖出生点附近视角） | `qa-02/03/05`      |
| 颜色协调                         | 基本通过；白天天空偏灰紫与水面色纹见 D13/D14                                | `qa-05-sky.png`    |
| 图形几何量                       | 通过（区块 > 20、三角形 > 1000、draw call > 10）                            | `qa-03`            |

---

## 2. 发现的问题（含复现步骤与严重级别）

### D1【高｜已修复】进入世界后准星、快捷栏、HUD 从未显示

- **复现**：`vite build && vite preview` → 打开页面 → 主菜单点"新建世界" → 等区块加载完。
- **期望**：游玩状态下屏幕中央有准星、底部有 9 格快捷栏、左下角有坐标 HUD。
- **实际（修复前）**：三者 DOM 存在但 `display: none`；截图里只有世界画面。
  实测：`getComputedStyle(document.querySelector('[data-testid="crosshair"]')).display === 'none'`，
  `hotbar`/`hud` 同为 none；`Crosshair.visible === false`。
- **根因**：三个组件在构造函数里 `setVisible(element, false)`（注释明确写着"进入 playing 状态
  时调用 show()"），而 `WorldSession` 只创建它们、从未调用 `show()`。
- **修复**：`WorldSession` 构造函数末尾调用 `crosshair.show()/hotbar.show()/hud.show()`。
- **回归**：`qa-visual.spec.ts` 第一个用例（DOM 可见 + 居中 + 不溢出）。

### D2【中高｜已修复】`WorldSession.dispose()` 不消费 `#unsubscribe`，每次进出世界泄漏整个 session

详见 [`QA-INTEGRATION.md`](./QA-INTEGRATION.md) 的 I-1：修复前游离 DOM 节点每轮 +245、
事件监听器 +9、GC 后堆 +0.6 MB；修复后三项恒定（324 / 46 / 5.1→5.5 MB）。
行为后果是 N 倍音效与 N 倍自动保存计数。

- **回归**：`qa-integration.spec.ts > 连续进出世界 3 次：游离 DOM 节点、事件监听器与堆不增长`。

### D3【中高｜已修复】`EventBus` 中抛异常的监听器永久破坏注销机制

- **复现**（修复前）：
  ```ts
  const off = bus.on('time:tick', fn);
  bus.on('ui:notice', () => { throw new Error('x'); });
  bus.emit('ui:notice', …);   // 抛出
  off();                      // 静默失效
  bus.emit('time:tick', …);   // fn 仍然被调用
  ```
- **期望**：`off()` 之后不再收到事件；失败被如实记录。
- **实际（修复前）**：`emit` 没有 `try/finally`，异常让 `#dispatchDepth` 永久 > 0 →
  之后所有 `off()` 都被推迟进 `#pendingRemovals` 且永不 flush；`listenerCount` 持续增长
  （测试里 50 次订阅/注销后仍剩 51 个监听器）。
- **修复**：`emit` 用 `try/finally` 包裹并逐监听器 `try/catch`（错误走 `logger.error`）。
- **回归**：`tests/unit/qa/eventbus-reentrancy.test.ts`。

### D4【中｜已修复】`World.getBlock` 在未加载区块里对 y<0 返回 Air 而不是 Bedrock

- **复现**：`world.getBlock(400, -1, 400)`（该列所在区块未加载）。
- **期望**：y<0 一律 Bedrock（类注释明确说这是为了"阻止玩家从世界底部掉出去"）。
- **实际（修复前）**：先查 chunk、未命中即返回 Air → `isSolidAt(x,-1,z) === false`，
  玩家会掉出世界；网格器在已加载区边缘也拿不到"免费剔除底面"。
- **修复**：`y<0 → Bedrock`、`y>127 → Air` 的判断提到 chunk 查找之前。
- **回归**：`tests/unit/qa/world-boundary-semantics.test.ts`。

### D5【中｜已修复】非整数坐标被静默接受

- **复现**（修复前）：`world.setBlock(1.5, 10, 0, BlockId.Stone)`。
- **期望**：返回 false，不标脏、不写 edit log。
- **实际（修复前）**：返回 **true**；`blocks[2561.5]` 的写入被 typed array 丢弃（什么都没存），
  但区块与 (0,-1) 邻居被标脏，edit log 里留下小数下标 2561.5（会进存档）。
  `world.getBlock(1.5,10,0)` 返回 `undefined`（违反 `BlockId` 返回类型）。
  同一缺陷也存在于 sink 的小数 y：`indexInChunk(15,-0.5,15) = 127` 会**别名**到真实方块 (15,0,7)。
- **修复**：`getBlock` 非整数返回 Air；`setBlock` 非整数返回 false；`generateChunkNow` 的 sink
  校验 `Number.isInteger` + 范围。
- **回归**：`world-boundary-semantics.test.ts` 的"non-integer coordinates"分组。

### D6【中低｜未修复】暂停 → 设置 → 返回 之后暂停菜单不再出现

- **复现**：进世界 → `Esc` → 点"设置" → 点"返回"。
- **期望**：回到暂停菜单（状态回到 `paused`）。
- **实际**：设置面板关闭，`pause-menu` 仍 hidden → 冻结的世界且无任何界面；
  再按一次 `Esc` 才能找回菜单（非永久死锁，但状态与界面不一致）。
- **根因**：`WorldSession.setSettingsVisible()` 关闭分支以 `#pauseMenu.visible` 为前提，
  而打开设置时该菜单已被 `hide()`，条件永远为假。
- **盯防**：`qa-integration.spec.ts > 暂停 → 设置 → 返回 之后暂停菜单应当恢复（已知缺陷）`
  （`test.fail()`，修好后会变成 Unexpected pass，届时翻转为普通用例）。

### D7【中低｜未修复】`EventBus.once` 在重入 emit 时触发两次

- **复现**：`bus.once('time:tick', h)`，`h` 内部再 `emit('time:tick', …)` 一次。
- **期望**：`h` 只被调用一次（文档："Subscribes for exactly one emission"）。
- **实际**：被调用两次 —— `once` 的 `off()` 在 dispatch 期间被推迟，嵌套 emit 的快照里
  仍然包含该监听器。
- **影响**：会一次性触发的 UI 提示/音效重复一次；需要把"已触发"状态与"从集合移除"分开。
- **状态**：以刻画用例固定当前行为（`eventbus-reentrancy.test.ts`），改好会立刻变红提醒翻转。

### D8【中｜已修复】一个监听器抛异常会中断同一次 dispatch 的后续监听器

`block:broken` 的扇出链是"音效 / 粒子 / 背包 / 存档计数"：音效层一旦抛异常，
背包与存档计数都会被跳过（玩家挖了方块却拿不到掉落）。修复后逐监听器隔离，后续监听器照常执行。
**回归**：`eventbus-reentrancy.test.ts > runs the remaining listeners of a dispatch where one listener threw`。

### D9【中低｜已修复】`Chunk.applyEdits` 不校验 id 与下标

- **复现**（修复前）：`chunk.applyEdits([{ index: 0, id: 300 }])`。
- **期望**：非法记录被跳过。
- **实际（修复前）**：`blocks[0]` 变成 `300 & 0xFF = 44`（Uint8Array 静默取模），而
  `getEdits()` 仍返回 300 → 存储与 edit log 不一致，重新保存/读取会变成另一种方块；
  小数下标同样被写进日志（实际写入被丢弃）。
- **修复**：`Number.isInteger` + 范围校验（下标 `[0, CHUNK_VOLUME)`、id `[0, 255]`）。
- **回归**：`tests/unit/qa/chunk-heightmap-adversarial.test.ts` 的 applyEdits 分组。

### D10【低｜已修复】`Chunk.lightDirty` 无法清除，且 `applyEdits` 不置位

修复前没有任何 API 能把该标志置回 false（未来光照系统会每帧重算）；`markLightClean()` 的
注释声称 `applyEdits` 会置位，但实现只设置了 `#meshDirty` —— 读档回放后光照被错误地标记为
clean。现二者都已修正，测试覆盖"置清 → setBlock/applyEdits 重新置位"。

### D11【低｜已修复】`generateChunkNow` 的 `ChunkDataTarget` 不校验 y

整数越界写入会被 typed array 静默丢弃，但**小数 y 会别名**（见 D5）。现已校验并拒绝。
另：`adoptGeneratedChunk` 在载荷长度非法时抛异常但残留 pending 标记 → 该区块永久处于
"生成中"，流式层不再重试（已用 `try/finally` 修复，回归测试断言 `isPending === false`）。

### D13【低｜未修复】大面积水面在掠射角下仍有细密斜向网格纹

- **复现**：站在海滩上朝海面看（出生点常在海岸）；或跑 `VISUAL_OUTPUT_DIR=/tmp/qa-visual
pnpm exec playwright test tests/e2e/qa-visual.spec.ts` 后放大 `qa-02-world.png` 的水域。
- **期望**：水面平滑（远处由雾/反射过渡）。
- **实际**：水面出现规则的斜向交叉细纹（2 倍放大下清晰可见），远处水岸边缘有"锯齿状"台阶与
  1px 亮线。
- **量化**：水域裁剪区域逐行均值差 1.34/255（修复 `textureGrad` 前沙地是 2.91，现已降到 1.5
  左右，说明沙地摩尔纹已被那次修复解决）。
- **推测原因（供渲染 owner 参考）**：海面是被贪心合并的巨型四边形，靠 `fract()` 逐块重复
  tile；即使导数正确，`anisotropy = 4` 在极掠射角下仍不足以消掉高频图案。
  可考虑提高 anisotropy 到设备上限、按距离淡出 tile 细节，或限制单块合并尺寸。
- **严重级别**：低（观感问题，无功能影响）。

### D14【低｜未修复】白天时段天空呈灰紫而非调色板里的蓝

- **证据**：`qa-02-world.png` / `qa-05-sky.png` 右上天空实测 `rgb(88,89,116)`、`rgb(88,89,115)`；
  同帧 HUD 显示"时间 13:xx · 白天 · 第 1 天"。而 `Sky.ts` 的 day 关键帧是
  `zenith #4a8fd4 (74,143,212)`、`horizon #a8cdf0 (168,205,240)`。
- **可能解释**：正在 day↔dusk 之间插值；或色调映射/色彩空间把饱和度压掉了。
  **无法从外部判定意图**，需要渲染 owner 确认；若是预期效果请在代码注释里说明，
  否则建议检查 `ShaderMaterial` 的输出色彩空间（自定义 shader 不会自动加 linear→sRGB 转换）。
- **严重级别**：低（不影响可玩性；当前断言只要求"蓝色分量不低 + 不是纯色"，通过）。

### D15【低｜未修复】调试面板 `Seed` 行永远显示"随机"

`GameApp` 只在启动时按 `appConfig.defaultWorldSeed` 写一次这一行，玩家填了种子或继续存档后
都不更新。排障时会误导（按面板上的种子重建得不到同一个世界）。建议每帧从 session 读实际种子。
**复现**：主菜单填种子 `abc` → 新建世界 → 面板仍显示"随机"。

### D16【低｜接受为已知风险】`BlockRegistry` 对未知 id（22..255）fail-open

字节存储可以表示 22..255，但这些 id 没有定义：谓词全部 false、硬度 0、掉落 null、
`lightAttenuationOf` 返回 0（`?? 1` 兜底不可达），只有 `definitionOf` 抛 `RangeError`。
后果：损坏存档表现为"看不见、站不上去、也挖不动的洞"，直到某处调用 `definitionOf`
把渲染循环打崩。Lead 决定不做逐方块校验（32k 次检查/区块的代价高于收益），
`applyEdits` 已在存档入口拦截越界 id；建议后续在**生成器输出侧**或**读档抽样**时补校验。
**回归测试**把当前行为固定下来（`block-registry-table.test.ts`）。

### D17【信息】`worldToLocalCoord(-16, 16)` 返回 `-0`

`-16 % 16 === -0`，`local < 0` 不成立，因此返回负零。对所有下游用法（索引算术、
`=== 0` 判定、Map 键的 SameValueZero 语义）都无害，仅供 `Object.is`/序列化场景注意。

---

## 3. 性能数据

**⚠️ 方法学警告（务必随数字一起引用）**：下列数据来自 **headless Chromium + SwiftShader
软件光栅化**（`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0)), SwiftShader driver)`），
**不代表真机 GPU 性能**，只能作为"CPU 光栅化下的下限"和**回归基线**使用。
真机数据请在 macOS 上用 `node scripts/measure-perf.mjs --headed` 重测（会走真实 GPU）。

- 采集方式：`node scripts/measure-perf.mjs --duration=12`
  （生产构建 + `vite preview`，Playwright 驱动，固定种子 `perf-baseline`，等区块流式加载收敛后再测）。
- 环境：Apple Silicon（10 逻辑核）、DPR 1、视口分别 1280x720 与 640x360、单浏览器独占运行。

| 指标                           | 1280x720                 | 640x360                  |
| ------------------------------ | ------------------------ | ------------------------ |
| FPS（由平均帧间隔换算）        | **20.3**                 | **39.0**                 |
| 帧间隔 mean / p50              | 49.18 ms / 50.00 ms      | 25.62 ms / 16.80 ms      |
| p95 / p99 / max                | 50.10 / 66.70 / 66.70 ms | 33.40 / 50.10 / 66.70 ms |
| 卡顿帧（> 2×p50）              | 0                        | 15                       |
| 已加载区块                     | 197                      | 197                      |
| draw call / 帧（峰值 = 均值）  | 199                      | 199                      |
| 三角形 / 帧（面板值）          | 70,906                   | 70,906                   |
| 着色器程序（linkProgram 次数） | 8                        | 8                        |
| GC 后 JS 堆                    | 8.8 MB（窗口内 -1.3 MB） | 9.6 MB（窗口内 -0.7 MB） |
| 上下文丢失 / 控制台错误        | 无 / 无                  | 无 / 无                  |

**结论**

1. 两个视口的场景完全相同（同种子、197 区块、199 draw call、70,906 三角形），
   帧时间从 49 ms 降到 26 ms —— 说明软件渲染下瓶颈是**填充率/像素量**，不是 draw call 数或
   CPU 端逻辑。这也意味着真机 GPU 上这些 draw call（199/帧）与三角形（7 万/帧）属于轻量级负载。
2. `drawCalls = 199` 与"214 个已加载区块"相比很低，说明**贪心合并 + 视锥剔除在起作用**
   （不是"一块一个 Mesh"）。
3. 堆在 12 秒窗口内没有增长（-0.7 ~ -1.3 MB），未观察到渲染期泄漏；堆总量 < 10 MB。
4. **注意**：本次测量只覆盖"出生点静止不动"这一个场景。挖掘/放置、快速移动、跨区块流式
   加载峰值、大量掉落物/粒子等场景**未测**（见第 4 节）。
5. 脚本自身的一个坑（已修）：世界加载后立刻开始测，1280x720 下只加载了 65 个区块就开始
   计时，导致两个分辨率不可比；现在会等区块数稳定 4 秒再测。
   反面结论：**慢机器上区块流式加载更慢**（渲染越慢，每帧留给重建的预算越少），
   低端设备上"世界要等更久才铺满"是可预期的行为。

---

## 4. 未覆盖的风险（诚实清单）

1. **真机 GPU 性能未测**：所有帧率数据都来自 SwiftShader。`--headed` 模式已实现但本次未运行
   （会弹出真实窗口），因此"能不能 60 FPS"这个问题**没有答案**。
2. **鼠标与指针锁定未验证**：headless 下 `requestPointerLock()` 拿不到锁
   （`document.pointerLockElement` 恒为 null）→ 鼠标视角、按住左键挖掘、右键放置/交互
   这三条核心玩法**没有端到端验证**；只有它们各自的单元测试。
   `qa-visual` 的截图因此都是"出生点默认视角"。
3. **音频完全未验证**：无法断言音效是否发声、是否重叠、距离衰减是否正确。
4. **掉落实体与粒子系统**未做端到端验证（无挖掘 → 无掉落）；只有单元测试层面的覆盖。
5. **长时间运行 / 内存泄漏 soak**：只验证了"进出世界"这条路径不泄漏（3 轮）；
   连续游玩 30 分钟、反复开关背包/设置、重复保存等路径未做压力测试。
6. **存档规模与配额**：只验证了 9 个区块的小世界；大世界（数百个已修改区块）、
   IndexedDB 配额耗尽、隐私模式降级未验证。
7. **跨浏览器 / 移动端**：只在 Chromium 上跑过；WebGL2 在 Safari/Firefox 的差异、
   触屏操作、`env(safe-area-inset-*)` 的刘海屏适配未验证。
8. **Z-fighting / 区块裂缝**：只在出生点附近的几个视角目视检查（未见裂缝），
   没有做"沿区块边界飞行一圈"的系统性检查；也未验证阴影贴图边缘
   （`qa-02` 里沙滩上的长条阴影无法排除是 shadow camera 边界的产物）。
9. **多 worker 并发生成**：`WorkerPool` 的并发/异常/降级路径只做了静态核对，
   未在浏览器里跑过真实 worker 场景。
10. **`BlockRegistry` 未知 id fail-open**（D16）：接受风险，未修复。
11. **EventBus `once` 重入**（D7）与 **设置返回不恢复暂停菜单**（D6）：已发现、未修复，
    分别有刻画用例与 `test.fail()` 盯防。

---

## 5. 复跑命令

```bash
# 单元 + 集成（117 个用例）
pnpm exec vitest run tests/unit/qa tests/integration/qa

# 浏览器端：整仓 e2e（24 个用例：boot 10 + visual 4 + qa-visual 5 + qa-integration 5）
pnpm run test:e2e                     # 需要全项目 tsc 通过
# 只跑 QA 的两份 spec（并在并发环境下避免争抢 test-results/）
pnpm exec vite build
VISUAL_OUTPUT_DIR=test-results/visual pnpm exec playwright test tests/e2e/qa-visual.spec.ts
pnpm exec playwright test tests/e2e/qa-integration.spec.ts --output=/tmp/qa-pw-output

# 性能基线（独占运行，勿与其他 Playwright 任务并发）
node scripts/measure-perf.mjs --duration=12
node scripts/measure-perf.mjs --duration=12 --json=test-results/perf.json
node scripts/measure-perf.mjs --headed          # 真机 GPU（macOS 会弹窗）
```
