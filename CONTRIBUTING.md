# 贡献指南

感谢你有兴趣参与 My MC v2。本项目对**工程质量的要求高于功能数量**：一个功能只有在
"实现 + 集成 + 测试 + 实际运行 + 视觉检查"全部通过后，才算完成。

---

## 1. 本地开发流程

```bash
pnpm install
pnpm run dev            # 开发服务器
pnpm run check          # 提交前必须通过
```

推送前请确保 `pnpm run check` 全绿。它依次执行：

1. `typecheck` —— 四个 tsconfig 项目的类型检查（应用 / 工具 / E2E 测试）
2. `lint` —— ESLint，含类型感知规则
3. `format:check` —— Prettier
4. `test` —— Vitest 单元 + 集成测试
5. `build` —— 生产构建

涉及渲染或 UI 的改动，额外运行：

```bash
pnpm run test:e2e       # 真实浏览器 + 像素级视觉断言
```

---

## 2. 分支模型

| 分支           | 用途                                                           |
| -------------- | -------------------------------------------------------------- |
| `main`         | 可部署的稳定版本，每次推送都会触发 CI 与 Cloudflare Pages 部署 |
| `develop`      | 集成分支，功能分支合并到这里                                   |
| `feat/<scope>` | 新功能，例如 `feat/chunk-greedy-meshing`                       |
| `fix/<scope>`  | 缺陷修复                                                       |
| `perf/<scope>` | 性能优化（必须附实测数据）                                     |

---

## 3. 提交信息规范

采用 **Emoji + Conventional Commits**：

```
<emoji> <type>(<scope>): <subject>

<body>

<footer>
```

| Type       | Emoji | 场景               |
| ---------- | ----- | ------------------ |
| `feat`     | ✨    | 新功能             |
| `fix`      | 🐛    | 缺陷修复           |
| `docs`     | 📝    | 文档               |
| `style`    | 💄    | 纯格式化           |
| `refactor` | ♻️    | 重构（无行为变化） |
| `perf`     | ⚡    | 性能优化           |
| `test`     | ✅    | 测试               |
| `build`    | 📦    | 构建 / 依赖        |
| `ci`       | 🤖    | CI/CD              |
| `chore`    | 🔧    | 杂项               |
| `revert`   | 🔙    | 回退               |

要求：

- 首行（含 emoji）≤ 72 字符，使用祈使句，首字母小写，结尾不加句号
- Body 说明 **为什么**（Why）与 **影响**（What），而不是复述实现细节
- 例：`✨ feat(world): add greedy meshing for chunk geometry`

---

## 4. 代码规范

### 类型

- 禁止 `any`（ESLint 强制）；不确定的外部输入用 `unknown` 再收窄
- 禁止非空断言 `!`；通过边界检查让类型自然收窄
- 项目开启了 `noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes`：
  索引访问返回 `T | undefined`，可选属性不能显式传 `undefined`
- 访问 TypedArray 时在**一处**做好边界检查并返回默认值，而不是到处写 `?? 0`

### 结构

- 组合优于继承，避免超过三层的继承链
- 单个函数保持单一职责；超过约 60 行的方法应拆分
- 任何 `create*` 工厂都要返回配套的 `dispose()`——GPU 资源泄漏在体素游戏里累积极快

### 注释

注释解释 **为什么**，而不是重复代码在做什么：

```ts
// BAD：重复代码
i = i + 1; // i 加一

// GOOD：解释原因
// 探测用的上下文会被主动销毁，因此这里必须使用一次性 canvas，
// 否则 Three.js 会拿到一个已丢失的上下文。
const probe = document.createElement('canvas');
```

多层次说明严格使用 `I.` / `1.` / `(1)` 层级，避免跳级。

### 测试

- 修复 bug 时先写一个能复现的失败测试
- 新增引擎逻辑（噪声、区块、碰撞、背包规则）必须有单元测试
- **禁止为了让测试通过而删除或弱化断言**；测试失败说明代码或假设有误

---

## 5. 架构约束

`tests/unit/architecture.test.ts` 会静态检查依赖图，违反以下任一规则都会导致测试失败：

1. **不允许循环依赖**
2. **底层模块不得依赖 UI 或应用装配层**（`world` 不能 import `ui`）
3. **生产代码不得 import 测试代码**

新增顶层目录时，需要同步更新该测试里的层级清单。

---

## 6. 拉取请求

PR 描述请包含：

- 解决的问题 / 新增的能力
- 验证方式（跑了哪些命令、看到了什么结果）
- 视觉改动请附截图（`pnpm run test:e2e` 会把截图输出到 `test-results/visual/`）
- 若涉及性能，附 Profile 数据而不是感觉
