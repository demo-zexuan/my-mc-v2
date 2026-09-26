# 开发指南

面向在本仓库里写代码、调试和排查环境问题的人。命令与版本号都来自当前仓库的实际配置与
本机实测输出，不是模板。

---

## I. 环境准备

| 项目        | 要求                                   | 依据                                                                           |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| Node.js     | ≥ 22.12（CI 用 24，本机实测 v24.14.0） | `package.json` 的 `engines.node`、`.github/workflows/ci.yml` 的 `NODE_VERSION` |
| pnpm        | 12.6.0                                 | `package.json` 的 `packageManager`（corepack 会读取它）                        |
| 浏览器      | 支持 WebGL 2                           | `src/rendering/createRenderer.ts` 会拒绝没有 WebGL 2 的环境                    |
| 磁盘 / 网络 | 首次安装需要下载依赖与 Chromium        | `pnpm install` + `pnpm exec playwright install chromium`                       |

```bash
# 1. 安装依赖（pnpm 会自动使用 packageManager 指定的版本）
corepack enable          # 可选
pnpm install

# 2. 本地环境变量（三个 VITE_* 都有默认值，这一步可以跳过）
cp .env.example .env

# 3. 首次运行浏览器测试前准备 Chromium
pnpm exec playwright install chromium
```

### 为什么依赖脚本被白名单化

pnpm ≥ 10 默认**阻止**所有依赖的安装脚本。`pnpm-workspace.yaml` 里显式放行了两个：

```yaml
allowBuilds:
  esbuild: true # 需要下载平台二进制，否则 Vite 无法工作
  workerd: true # Wrangler 的 Pages 运行时
```

其余依赖保持被阻止状态：一个被投毒的传递依赖不应该能在 `pnpm install` 时执行任意代码。

同一文件里的 `minimumReleaseAgeExclude` 列了四条：

```yaml
minimumReleaseAgeExclude:
  - '@vitest/coverage-v8@5.0.2'
  - '@vitest/mocker@5.0.2'
  - '@vitest/spy@5.0.2'
  - vitest@5.0.2
```

原因是 pnpm 默认对"刚发布不久"的版本设隔离期，而本项目固定的 Vitest 5.0.2 比默认窗口更新。
把豁免显式写出来，既让 CI 安装结果可复现，也让"为什么这四个版本绕过了策略"一目了然——
比全局关掉 `minimumReleaseAge` 安全得多。

`.npmrc` 里还有两条与本项目相关的设置：`auto-install-peers=true`（避免 CI / Cloudflare Pages
因为一个运行期才需要的可选 peer 而失败）与 `strict-peer-dependencies=false`
（`typescript-eslint@8.70` 声明的是 `typescript >=4.8.4 <6.1.0`，比社区常见写法更窄）。

### 为什么 TypeScript 固定在 5.9.3

`typescript-eslint@8.70` 的 peer 约束是 `typescript >=4.8.4 <6.1.0`。为了让"类型检查 +
类型感知 lint"整条链路自洽，项目固定 5.9.3，而不是跟随 `latest`。

---

## II. 常用命令

| 命令                     | 作用                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `pnpm run dev`           | Vite 开发服务器（<http://127.0.0.1:5173>），带 HMR                     |
| `pnpm run build`         | `typecheck` + `vite build` → `dist/`（类型错误不可能进入产物）         |
| `pnpm run preview`       | 在 4173 端口预览生产构建（`--strictPort`，端口被占用会直接失败）       |
| `pnpm run typecheck`     | 四个 tsconfig 项目全量检查（应用 / node 侧 / 测试 / E2E）              |
| `pnpm run lint`          | ESLint（含类型感知规则）                                               |
| `pnpm run format`        | Prettier 写入；`format:check` 只检查                                   |
| `pnpm run test`          | Vitest 单元 + 集成测试（当前 **68 个文件 / 895 个用例**，本机约 4 秒） |
| `pnpm run test:watch`    | Vitest 监听模式                                                        |
| `pnpm run test:coverage` | 覆盖率报告输出到 `coverage/`（v8 provider）                            |
| `pnpm run test:e2e`      | 构建 + Playwright 浏览器测试                                           |
| `pnpm run test:e2e:run`  | 直接跑 Playwright，复用已有 `dist/`（改测试时用这个，省一次构建）      |
| `pnpm run check`         | 提交前门禁：typecheck → lint → format:check → test → build             |
| `pnpm run check:full`    | `check` + 浏览器 E2E                                                   |
| `pnpm run deploy`        | 构建并 `wrangler pages deploy dist`（需要 Cloudflare 凭据）            |

**改代码后最省时间的顺序**：`pnpm run test`（秒级反馈）→ `pnpm run check`（提交前）→
`pnpm run check:full`（动过渲染 / 输入 / 装配层时）。

---

## III. 调试技巧

### F3 调试面板

按 `F3` 切换（`VITE_DEBUG_OVERLAY=false` 可以让它默认关闭）。行清单定义在
`src/app/GameApp.ts` 的 `WORLD_ROWS`，每行的含义：

| 行            | 含义                                                                   |
| ------------- | ---------------------------------------------------------------------- |
| `FPS`         | `FrameStats` 算出的帧率（由指数移动平均得到，不是瞬时值）              |
| `Frame`       | 最近的 EMA 帧耗时（毫秒）。与 `FPS` 一起看能区分"偶发卡顿"和"整体过载" |
| `Draw calls`  | `renderer.info.render.calls`，一帧提交的绘制调用数                     |
| `Triangles`   | `renderer.info.render.triangles`，一帧提交的三角形数                   |
| `Position`    | 相机（眼睛）世界坐标，保留 1 位小数                                    |
| `Chunk`       | 玩家所在区块坐标                                                       |
| `Chunks`      | 已建立网格的区块数，括号里是 `+Nq/Nf`：Nq 排队中、Nf 正在生成          |
| `Render dist` | 当前渲染距离（区块），来自设置而不是常量                               |
| `Seed`        | 世界种子；没填种子时显示"随机"                                         |
| `Time`        | 世界时间，单位"刻"（24000 刻 = 一天，0 刻为日出）                      |
| `Drops`       | 场上掉落物实体数                                                       |
| `Particles`   | 场上活跃粒子数（池容量 512，不会超过它）                               |

> 这些行只在世界运行时才有值；回到主菜单会显示 `—`，并且 `GameApp` 会主动隐藏面板
> （把引擎指标留在菜单上看起来像残影）。

游戏内左下角还有一个 HUD（坐标 / 区块 / 群系 / 时间 / 朝向 / 帧率），它读的是**快照数据**，
与调试面板相互独立。

### `scripts/probe-game.mjs`：观察集成行为

Playwright 套件负责**断言**，这个脚本负责**观察**——它跑真实构建，把每个阶段截图并打印控制台
消息，因此可以在"一半功能还没做完"的构建上运行，不会把 CI 弄红。

```bash
pnpm run build
pnpm run preview &                       # 或任意已在运行的 4173 端口服务
node scripts/probe-game.mjs              # 默认 http://127.0.0.1:4173/
node scripts/probe-game.mjs http://127.0.0.1:5173/    # 也可以指向 dev server
```

输出：

- `test-results/integration/01-main-menu.png`、`02-world.png`、`03-after-moving.png`
  （可用 `VISUAL_OUTPUT_DIR` 改目录）
- 启动阶段的 fatal 卡片文本（如果有）
- `--- debug overlay ---`：把 12 行读数整块打印出来
- `--- console messages ---`：页面里的 error / warning（最多 14 条）

启动失败时脚本会以退出码 1 结束，适合放进 shell 脚本里做冒烟检查。

另外两个脚本是排查性的一次性工具，只在怀疑环境问题时用：

| 脚本                             | 用途                                                                |
| -------------------------------- | ------------------------------------------------------------------- |
| `scripts/probe-webgl.mjs`        | 逐个试 Chromium 启动参数组合，找出真正能给出 WebGL 2 上下文的那一组 |
| `scripts/probe-launch-modes.mjs` | 对比 `headless_shell` 与完整 Chrome for Testing 的 WebGL 能力       |

`playwright.config.ts` 里那组 `--enable-unsafe-swiftshader` 就是这么定下来的，不是猜的。

### 定向运行浏览器测试

```bash
# 只跑一个 spec / 一个用例
pnpm exec playwright test tests/e2e/visual.spec.ts --reporter=line
pnpm exec playwright test --grep "move with WASD"

# 复用已有 dist（不重新构建）
pnpm run test:e2e:run

# 交互式调试（时间轴 + DOM 快照）
pnpm run test:e2e:ui
```

有用的环境变量（都在 `.env.example` 里列出）：

| 变量                | 作用                                                           |
| ------------------- | -------------------------------------------------------------- |
| `E2E_BASE_URL`      | 指向一个已经在跑的服务，Playwright 不再自己启动 `vite preview` |
| `VISUAL_OUTPUT_DIR` | 截图输出目录，默认 `test-results/visual`                       |
| `CI=true`           | 打开重试（2 次）、单 worker、HTML/JUnit 报告                   |

`pnpm run preview` 使用 `--strictPort`，端口冲突时**不会**静默换端口。如果上一次的 preview
还挂着：

```bash
lsof -ti:4173 | xargs -r kill -9
```

### 看视觉产物

`pnpm run test:e2e` 会把截图写到 `test-results/visual/`（`boot` / `visual` / `qa-visual` 三个
suite 都写这个目录）。README 里引用的四张图放在 `docs/screenshots/`，是从那里复制过来的：

```bash
pnpm exec playwright test --reporter=line
mkdir -p docs/screenshots
cp test-results/visual/game-main-menu.png test-results/visual/game-world.png \
   test-results/visual/game-hud.png test-results/visual/game-loading.png docs/screenshots/
```

---

## IV. 常见问题

### 1. 页面显示"当前浏览器或显卡驱动不支持 WebGL 2"

启动时 `detectGraphicsBackend()` 会用一张**一次性 canvas** 探测 WebGL 2（探测完主动
`loseContext()`，避免泄漏上下文）；探测失败就直接抛 `AppError('WEBGL_UNAVAILABLE')`，
`BootOverlay.showFatal()` 把面向玩家的中文提示显示在首屏。

排查顺序：

1. 浏览器是否太旧？Three.js r163+ 已不再支持 WebGL 1，本项目没有降级渲染路径。
2. 是否关掉了硬件加速（Chrome：设置 → 系统 → 使用图形加速功能）？
3. 无头 / CI 环境：SwiftShader 需要 `--enable-unsafe-swiftshader`，Playwright 配置里已经带上。
4. 确认不是"显卡驱动崩溃后浏览器临时拉黑 GPU"：访问 `chrome://gpu` 看 WebGL2 状态。

> 软件渲染（SwiftShader）能跑通功能测试，但**帧率不代表真机性能**，不要用它得出性能结论。

### 2. 存档失败 / "浏览器存储不可用，存档无法保存"

`SaveStorage` 在两种情况下抛 `AppError('STORAGE_UNAVAILABLE')`：环境根本没有 `indexedDB`
（隐私模式、被策略禁用、非浏览器环境），或某次 IndexedDB 请求/事务失败。

游戏的处理方式是**降级而不是崩溃**：

- `GameApp.#refreshMenu()` 捕获 `listWorlds()` 的失败，只是把"开始游戏"禁用掉，
  玩家仍然可以**新建世界**继续玩。
- `SaveManager` 接受注入的 `storage`，测试与降级场景可以传入 `InMemorySaveStorage`
  （本次会话内存存档）。
- 世界列表的容错更细：单个损坏的存档只记录 warn 并跳过，一个坏文件不会让整个列表打不开。

要在浏览器里自测这条路径：开一个无痕窗口，或把 `indexedDB` 置为 `undefined` 后刷新。

### 3. 控制台警告"后台线程不可用"（worker 被 CSP 阻止）

`WorkerPool` 在 worker 创建失败时（加固浏览器、CSP 禁止 `blob:` / `worker-src`、
老环境没有 module worker）会**只告警一次**，然后改在主线程同步生成区块——

> 一个能听见卡顿的游戏，好过一个打不开的游戏。

表现：游戏功能完整，但玩家跨区块时会有可感知的掉帧。`WorkerPool.usingFallback` 为 `true`
时可以从代码里断言这一点。对应 `AppErrorCode.WORKER_UNAVAILABLE` 的提示文案是
"后台线程不可用，游戏将以较低性能运行（区块生成可能造成卡顿）"。

想在本机复现，可以在启动前给页面注入一条 CSP（禁止 `worker-src` / `blob:`）再加载游戏。

### 4. `pnpm run test:e2e` 偶发失败，单独跑同一个用例却通过

浏览器套件以 `fullyParallel` 运行，每个用例都是一个独立的软件渲染 WebGL 页面。在只有
CPU 光栅化的机器上，多个页面同时抢 CPU 会让依赖"墙钟时间"的用例（例如按住 `W` 若干毫秒后
断言位移超过 1 格）拿到偏小的结果。

如果怀疑是这类抖动而不是真缺陷：

```bash
pnpm exec playwright test tests/e2e/boot.spec.ts --reporter=line   # 单 suite
pnpm exec playwright test --grep "move with WASD" --reporter=line  # 单用例
```

在本机（Apple Silicon、headless SwiftShader）实测：整个浏览器套件（当时 19 个用例）并行跑时
出现过一次 `lets the player move with WASD` 失败（位移 0.22 格 < 1 格），随后单 suite 与
单用例均通过。**这类结果要按"可能是负载抖动"处理，但同时记录在案**，不要直接当绿灯。

> 另一个常见原因是**两个人同时在跑 E2E**：`vite preview` 只有一个 4173 端口，
> `pnpm run build` 又会先清空 `dist/`。如果另一个人正在构建，你会看到
> `The directory "dist" does not exist` 或成片的用例失败——先确认没有并发的构建 / 测试，
> 再判断是不是真缺陷。

### 5. `dist/` 与源码不一致

`pnpm run test:e2e:run` 只跑浏览器测试、**不会**重新构建，所以它测的是上一次
`pnpm run build` 的产物。改了 `src/` 之后要么用 `pnpm run test:e2e`（先构建），要么先手动
构建。判断 `dist/` 是否过期可以直接比较时间戳：

```bash
ls -la --time-style=full-iso dist/assets    # macOS: ls -laT dist/assets
find src -type f -newer dist/index.html     # 有输出说明 dist 已过期
```

---

## V. 加新东西之前

1. 新模块放哪个顶层目录？`tests/unit/architecture.test.ts` 里的层白名单是**强制**的。
2. 是否需要 `dispose()`？是否与某个 `create*` 成对？（体素游戏不漏 GPU 内存的前提）
3. 需要新的存档字段吗？在 `src/save/saveSchema.ts` 提升 `SAVE_SCHEMA_VERSION` 并补
   `MIGRATIONS[n]`，否则旧存档会读不出来。
4. 需要新的调试指标吗？加到 `GameApp` 的 `WORLD_ROWS`。
5. 需要新事件吗？`GameEventMap` 是跨模块隐式接口，只放"别的系统真的需要知道的事实"。

契约细节见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)，提交规范见 [`../CONTRIBUTING.md`](../CONTRIBUTING.md)。
