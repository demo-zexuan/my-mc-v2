/**
 * UI 层的架构守卫。
 *
 * I. 为什么用 `import.meta.glob` 而不是 `node:fs`
 *
 * 1. `tests/unit` 由浏览器 tsconfig 检查（`types: ["vite/client"]`，没有 node
 *    类型），直接用 `node:fs` 会让 `pnpm typecheck` 失败。
 * 2. `import.meta.glob(..., { query: '?raw' })` 在 Vite 构建期就把源码当成字符串
 *    读进来，既能做文本级检查，也仍然是类型安全的。
 *
 * II. 检查的两件事
 *
 * 1. `src/ui/**` 只能依赖"数据 + 回调"：导入 world / physics / player / app 会让
 *    UI 组件无法脱离引擎在 jsdom 里测试，这是本层可测试性的前提。
 * 2. 每个交互组件都必须提供 `dispose()`，否则页面级重载（E2E 与热更新）会留下
 *    游离的 DOM 与全局监听。
 *
 * @module tests/unit/ui/boundaries
 */

import { describe, expect, it } from 'vitest';

/** 以源码文本形式加载整个 UI 层。 */
const UI_SOURCES: Record<string, string> = import.meta.glob<string>('/src/ui/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** 禁止被 UI 导入的层前缀。 */
const FORBIDDEN_PREFIXES = ['@/world/', '@/physics/', '@/player/', '@/app/', '@/rendering/'];

/** 与 `tests/unit/architecture.test.ts` 保持同一套提取规则。 */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /(?:^|\n)\s*import\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*export\s+[^'"]*from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** 只承载数据结构、不需要 dispose 的模块。 */
const NON_COMPONENT_FILES: readonly string[] = [
  '/src/ui/dom.ts',
  '/src/ui/itemIcon.ts',
  '/src/ui/itemVisuals.ts',
  '/src/ui/ModalScreen.ts',
];

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        found.push(specifier);
      }
    }
  }
  return found;
}

describe('ui layer boundaries', () => {
  it('finds the UI sources', () => {
    expect(Object.keys(UI_SOURCES).length).toBeGreaterThanOrEqual(10);
    expect(Object.keys(UI_SOURCES)).toContain('/src/ui/Crosshair.ts');
  });

  it('never imports the world, physics, player, rendering or app layers', () => {
    const violations: string[] = [];

    for (const [path, source] of Object.entries(UI_SOURCES)) {
      for (const specifier of specifiersOf(source)) {
        const forbidden = FORBIDDEN_PREFIXES.find(
          (prefix) => specifier.startsWith(prefix) || specifier.includes(prefix),
        );
        if (forbidden !== undefined) {
          violations.push(`${path} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('exposes a dispose() on every interactive component', () => {
    const offenders: string[] = [];

    for (const [path, source] of Object.entries(UI_SOURCES)) {
      if (NON_COMPONENT_FILES.includes(path)) {
        continue;
      }
      // 组件可以自己实现 dispose()，也可以继承 ModalScreen 的实现——
      // 两条路径都要存在；其它写法说明这个组件无法被干净地卸载。
      if (!/dispose\s*\(/.test(source) && !/extends\s+ModalScreen/.test(source)) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('never assigns innerHTML inside the UI layer', () => {
    // 提示文案与种子来自玩家输入，拼 HTML 就是注入漏洞；一律走 textContent。
    const offenders = Object.entries(UI_SOURCES)
      .filter(([, source]) => /\.innerHTML\b/.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});
