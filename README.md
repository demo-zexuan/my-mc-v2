# My MC v2 — Three.js 体素沙盒游戏

> 一款使用 **Three.js + TypeScript** 从零实现的类 Minecraft 3D 体素沙盒游戏。
> 工程化优先：类型严格、测试分层、CI 质量门禁、可重复部署到 Cloudflare Pages。

[![CI](https://github.com/demo-zexuan/my-mc-v2/actions/workflows/ci.yml/badge.svg)](https://github.com/demo-zexuan/my-mc-v2/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

<!-- 部署完成后替换为真实的 Pages 地址 -->
<!-- [在线试玩](https://my-mc-v2.pages.dev) -->

---

## 1. 项目简介

My MC v2 是一个**方块构成的三维开放世界沙盒**：玩家以第一人称在程序化生成的地形中探索、挖掘、放置方块、管理背包并建造。

与"渲染一堆 Cube Mesh"的玩具实现不同，本项目按**体素引擎**的真实做法构建：

- 世界由 **Chunk** 分块管理，方块数据存放在扁平 `TypedArray` 中，而不是对象列表；
- 区块网格通过 **面剔除 + 贪心合并** 生成，一个区块合并为极少数 Draw Call；
- 地形由**带种子的多层噪声**确定性生成，相同种子必然得到相同世界；
- 物理使用**固定时间步**推进，帧率波动不会让玩家穿墙；
- 重计算（地形生成、网格构建）运行在 **Web Worker** 中，不阻塞主线程。

游戏目前处于**持续迭代**中，阶段性成果与路线图见 [第 10 节](#10-后续路线图)。

### Overview (English)

A Minecraft-like 3D voxel sandbox built from scratch with Three.js and
TypeScript, structured as a real voxel engine: typed-array chunk storage,
greedy-meshed chunk geometry, seeded multi-octave terrain generation, fixed-timestep
player physics, worker-based chunk generation, browser persistence via IndexedDB,
and a CI pipeline that gates type safety, linting, unit/integration tests, browser
E2E tests, pixel-level visual checks and the production build.

---

## 2. 技术栈

| 领域           | 选型                                                                    | 版本         | 选择理由                                                                  |
| -------------- | ----------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| 3D 渲染        | [Three.js](https://threejs.org/)                                        | 0.186        | 需求指定；WebGL2 渲染器、成熟的 BufferGeometry 与材质体系                 |
| 语言           | [TypeScript](https://www.typescriptlang.org/)                           | 5.9          | 需求指定；开启全部严格检查（见 [tsconfig.json](./tsconfig.json)）         |
| 构建           | [Vite](https://vite.dev/)                                               | 8.3          | 原生 ESM、模块 Worker、`import.meta.env` 静态替换、极快的 HMR             |
| 包管理         | [pnpm](https://pnpm.io/)                                                | 12.6         | 严格依赖布局，避免幽灵依赖；锁文件在 CI 中冻结                            |
| 单元/集成测试  | [Vitest](https://vitest.dev/)                                           | 5.0          | 与 Vite 共用转换管线，零额外配置；原生支持 jsdom 与 v8 覆盖率             |
| E2E / 视觉测试 | [Playwright](https://playwright.dev/)                                   | 1.63         | 真实 Chromium 中运行生产构建；`page.screenshot()` 配合 pngjs 做像素级断言 |
| 代码检查       | [ESLint](https://eslint.org/) + typescript-eslint                       | 10.11 / 8.70 | 开启类型感知规则（`no-floating-promises`、`no-explicit-any` 等）          |
| 格式化         | [Prettier](https://prettier.io/)                                        | 3.9          | 格式化交给 Prettier，ESLint 不参与风格争论                                |
| 运行时校验     | [Zod](https://zod.dev/)                                                 | 4.6          | 环境变量与存档数据在启动/读取时校验，损坏数据不会静默传播                 |
| 部署           | [Cloudflare Pages](https://developers.cloudflare.com/pages/) + Wrangler | 4.140        | 全球边缘静态托管，零运维，GitHub 集成或直接上传均支持                     |

> **关于 TypeScript 版本**：npm 上的 `latest` 是 7.0.2，但 `typescript-eslint@8.70` 的
> peer 约束为 `<6.1.0`。为保证"类型检查 + 类型感知 lint"整条链路自洽，项目固定使用
> 5.9.3，而不是盲目跟随 `latest`。

**刻意没有引入的依赖**：`React/Vue/Svelte`（UI 用原生 DOM + CSS，避免框架与 60Hz 游戏
循环耦合）、`stats.js`/`lil-gui`（自建面板才能显示区块数、渲染距离等引擎指标）、
`simplex-noise`（自研噪声可保证**跨版本确定性**，否则升级依赖会改变已保存世界的地形）。

---

## 3. 安装

**前置要求**：Node.js ≥ 22.12（推荐 24 LTS）、pnpm ≥ 10、支持 WebGL 2 的浏览器。

```bash
# 1. 克隆仓库
git clone git@github.com:demo-zexuan/my-mc-v2.git
cd my-mc-v2

# 2. 安装依赖（pnpm 会自动读取 packageManager 字段）
corepack enable          # 可选：让 corepack 管理 pnpm 版本
pnpm install

# 3. 准备本地环境变量
cp .env.example .env     # 全部变量都有默认值，可以直接跳过这一步

# 4. 首次运行 E2E 前下载浏览器
pnpm exec playwright install chromium
```

> **pnpm 构建脚本白名单**：pnpm ≥ 10 默认阻止依赖的安装脚本。`pnpm-workspace.yaml`
> 中显式放行了 `esbuild`（平台二进制）与 `workerd`（Wrangler 运行时），其余依赖保持
> 被阻止状态，避免供应链风险。

---

## 4. 运行

```bash
pnpm run dev
```

打开 <http://127.0.0.1:5173>。开发服务器具备 HMR；修改 `src/` 下任意文件即时生效。

预览**生产构建**（与 Cloudflare Pages 上完全一致的产物）：

```bash
pnpm run build
pnpm run preview        # http://127.0.0.1:4173
```

---

## 5. 测试

测试分三层，全部可在本地与 CI 中重复执行。

```bash
pnpm run test           # 单元测试 + 集成测试（Vitest）
pnpm run test:watch     # 监听模式
pnpm run test:coverage  # 生成覆盖率报告到 coverage/

pnpm run test:e2e       # 构建 + 真实浏览器 E2E / 视觉测试（Playwright）
pnpm run test:e2e:run   # 仅跑浏览器测试，复用已有 dist/
```

### 测试分层

| 层级     | 位置                       | 覆盖内容                                                                                    |
| -------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| 单元测试 | `tests/unit/**`            | 游戏循环固定步长、帧统计、WebGL 能力探测、环境变量校验、日志、错误模型、UI 面板             |
| 集成测试 | `tests/integration/**`     | 场景装配（光照 / 阴影 / 相机 / 纹理生成）、模块间协作                                       |
| E2E 测试 | `tests/e2e/**`             | 真实 Chromium 加载**生产构建**：引擎启动、WebGL2 上下文、帧循环、F3 调试面板、resize 自适应 |
| 视觉测试 | `tests/e2e/visual.spec.ts` | 解码截图后做像素断言：画面非纯色、天空偏冷、地面偏暖、UI 不被裁切、**禁用 JS 时首屏不空白** |

视觉测试的关键点：它不只是"截图存档"，而是**解码 PNG 后断言像素分布**（`tests/e2e/support/image.ts`）。
这能捕获 DOM 断言完全看不到的问题——黑屏、相机朝向虚空、着色器编译成功但输出纯色。

### 质量门禁

```bash
pnpm run check        # typecheck → lint → format:check → test → build
pnpm run check:full   # check + 浏览器 E2E
```

`check` 是提交前的唯一入口，也是 CI 的 `quality` job 内容。**任一环节失败都不应继续开发。**

---

## 6. 构建

```bash
pnpm run build
```

产物输出到 `dist/`：

```
dist/
├── index.html                  # 含静态首屏骨架，JS 未加载时也不会白屏
├── assets/index-<hash>.js      # 应用代码
├── assets/three-<hash>.js      # Three.js（独立 chunk，跨部署稳定缓存）
├── assets/index-<hash>.css
├── favicon.svg
├── _headers                    # Cloudflare Pages 响应头（缓存 + 安全）
└── _redirects                  # SPA 回退规则
```

构建前会先执行完整 `typecheck`——**类型错误不可能进入产物**。

---

## 7. 部署

目标平台为 **Cloudflare Pages**（纯静态 SPA，无 Functions）。

### 方式一：直接上传（推荐，`pnpm run deploy`）

```bash
export CLOUDFLARE_API_TOKEN=...     # 权限：Cloudflare Pages: Edit
export CLOUDFLARE_ACCOUNT_ID=...
pnpm run deploy                     # = build + wrangler pages deploy dist
```

首次部署会自动创建 Pages 项目 `my-mc-v2`。

### 方式二：GitHub Actions 自动部署

`.github/workflows/deploy-cloudflare-pages.yml` 会在推送到 `main` 时构建并部署。
需要在仓库 **Settings → Secrets and variables → Actions** 中配置：

| Secret                  | 说明                                                |
| ----------------------- | --------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API Token，权限 `Cloudflare Pages: Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID                                  |

缺少 Secret 时工作流会**明确报错**而不是静默跳过。

### 方式三：Cloudflare Pages Git 集成

在 Cloudflare Dashboard 连接本仓库，配置：

- Build command：`pnpm run build`
- Build output directory：`dist`

### 部署配置

- [`wrangler.toml`](./wrangler.toml)：项目名与 `pages_build_output_dir`
- [`public/_headers`](./public/_headers)：`assets/*` 一年不可变缓存（文件名带 hash），
  `index.html` 强制回源，避免旧 HTML 指向已删除的 hash 资源
- [`public/_redirects`](./public/_redirects)：SPA 回退，深链不会 404

---

## 8. 项目架构

```
src/
├── main.ts                 # 浏览器入口：挂载 + 全局错误兜底
├── app/                    # 应用装配与生命周期（GameApp）
├── config/                 # 环境变量校验（Zod）
├── engine/core/            # 与渲染无关的引擎内核：固定步长游戏循环、帧统计
├── rendering/              # 渲染层：渲染器工厂、光照环境、能力探测、程序化纹理
├── world/                  # 体素世界：方块注册表、区块、坐标系统
├── terrain/                # 程序化地形：噪声、生物群系、特征生成
├── player/                 # 玩家：控制器、相机、状态
├── physics/                # 物理：AABB、体素碰撞、射线检测
├── input/                  # 输入：键鼠绑定、指针锁定
├── inventory/              # 物品与背包：ItemStack、槽位规则
├── interaction/            # 交互：挖掘、放置、掉落物
├── particles/              # 粒子系统（对象池）
├── ui/                     # DOM UI：启动屏、主菜单、HUD、背包界面
├── debug/                  # 调试面板
├── audio/                  # 音频（AudioContext 延迟初始化）
├── save/                   # 存档：IndexedDB + 版本迁移
├── workers/                # Web Worker（地形生成、区块网格构建）
├── settings/               # 设置项与持久化
└── utils/                  # 无状态工具：日志、错误模型、异步辅助
```

### 架构约束

1. **单向依赖**：`ui`/`debug` 可以依赖下层，下层**不得**反向依赖 UI；`engine` 不知道
   Three.js 以外任何游戏概念。
2. **无循环依赖**：通过 `tests/unit/architecture.test.ts` 静态扫描 import 图强制执行。
3. **入口不持有游戏规则**：`GameApp` 只负责创建与销毁资源，玩法规则属于各自系统。
4. **资源成对管理**：任何 `create*` 都返回配套的 `dispose()`，这是体素游戏不泄漏 GPU
   内存的前提。

架构细节与模块契约见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

---

## 9. 操作方式

| 按键            | 功能                               |
| --------------- | ---------------------------------- |
| `W` `A` `S` `D` | 前后左右移动                       |
| `Shift`         | 疾跑                               |
| `Space`         | 跳跃                               |
| 鼠标移动        | 转动视角（进入世界后自动锁定指针） |
| 鼠标左键        | 破坏方块                           |
| 鼠标右键        | 放置方块                           |
| `1`–`9`         | 选择快捷栏槽位                     |
| 鼠标滚轮        | 切换快捷栏槽位                     |
| `E`             | 打开/关闭背包                      |
| `Esc`           | 暂停 / 释放指针                    |
| `F3`            | 显示/隐藏调试面板                  |

> 上表中 Phase 4 之后的功能随开发进度逐步启用，当前已实现的部分以实际版本为准。

---

## 10. 后续路线图

| 阶段     | 内容                                                                | 状态      |
| -------- | ------------------------------------------------------------------- | --------- |
| Phase 0  | 工程闭环：TS/Vite/ESLint/Vitest/Playwright/CI/Cloudflare 配置       | ✅ 已完成 |
| Phase 1  | Three.js 基础引擎：Scene/Camera/Renderer/Light/GameLoop/Input/Debug | ✅ 已完成 |
| Phase 2  | 体素引擎：Block 注册表、Chunk、World、面剔除 + 贪心网格             | 🚧 进行中 |
| Phase 3  | 程序化地形：种子、多层噪声、生物群系、树木、水体                    | ⏳        |
| Phase 4  | 玩家：第一人称相机、重力、跳跃、AABB 碰撞、射线检测                 | ⏳        |
| Phase 5  | 沙盒交互：方块选中轮廓、破坏、放置、掉落物、拾取                    | ⏳        |
| Phase 6  | 物品与背包：ItemStack、9 格快捷栏、27 格背包、拖拽                  | ⏳        |
| Phase 7  | 环境：昼夜循环、天空/日月/云、雾、水体、粒子、音频                  | ⏳        |
| Phase 8  | 存档：世界种子、玩家状态、背包、已修改区块、设置                    | ⏳        |
| Phase 9  | 性能：按实测 Profile 优化区块网格、Draw Call、内存与 GC             | ⏳        |
| Phase 10 | QA：功能/UI/性能/浏览器兼容/长时间运行                              | ⏳        |
| Phase 11 | 发布：GitHub 仓库、README、生产构建、Cloudflare Pages 验收          | ⏳        |

### 对标 Minecraft 的扩展方向（核心稳定后再做）

洞穴与矿脉、更多生物群系、结构与村庄、生物与简单 AI、生命值/食物/合成、工具与装备、
熔炉与工作台、箱子与门、火把与光照传播、天气（雨雪雷）、水流扩散、岩浆、
多人联机（WebSocket + 服务器权威）。

判断标准始终是：**是否提升可玩性、是否符合体素沙盒方向、是否值得当前阶段做**。
不值得的功能进入路线图，而不是硬塞进代码。

---

## 开发规范

- **提交信息**：Emoji + [Conventional Commits](https://www.conventionalcommits.org/)，例如
  `✨ feat(world): add chunk greedy meshing`。首行 ≤ 72 字符。
- **注释**：解释 _为什么_，而不是重复代码在做什么；多层次说明使用 `I.` / `1.` / `(1)` 层级。
- **代码质量**：禁止 `any`、禁止非空断言、禁止超级类；组合优于继承。
- 详见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## 许可证

[MIT](./LICENSE)
