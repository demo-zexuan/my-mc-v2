/**
 * UI 层的 DOM 构造小工具。
 *
 * I. 为什么不引入 UI 框架
 *
 * 1. 本项目的界面只是"快照数据 + 回调"之上的一层薄渲染，组件总量不到十个；
 *    框架带来的运行时体积、构建配置和心智负担换不来收益。
 * 2. 原生 DOM 让每个组件都能在 jsdom 里被完整测试，也让 `dispose()` 的语义
 *    变得简单：移除自己创建的那棵子树即可，不存在虚拟 DOM 的残留状态。
 *
 * II. 为什么把这些工具集中在一个文件
 *
 * 八个组件都要创建同一种按钮、遵守同一套 `data-testid` 命名。集中一次，
 * 才能保证 `type="button"`（避免在表单里意外提交）、testId 写入方式这类
 * 细节不会在八个文件里各自漂移。
 *
 * @module ui/dom
 */

/** 构造元素时的描述信息。字段都可省略，省略即"不设置"。 */
export interface ElementSpec {
  readonly className?: string;
  readonly text?: string;
  /** 写入 `data-testid`，供单元测试与 E2E 定位。 */
  readonly testId?: string;
}

/**
 * 创建一个带类名 / 文本 / testId 的元素。
 *
 * @param tag - 标签名，由 `HTMLElementTagNameMap` 约束，返回值类型随之收窄。
 * @param spec - 可选的类名、文本与 testId。
 * @returns 新建的元素；调用方负责把它挂到文档树上。
 */
export function createEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElementSpec = {},
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (spec.className !== undefined) {
    element.className = spec.className;
  }
  if (spec.text !== undefined) {
    // 一律用 textContent 而非 innerHTML：提示文案里可能包含玩家输入的种子，
    // 走文本节点可以彻底排除注入问题。
    element.textContent = spec.text;
  }
  if (spec.testId !== undefined) {
    element.dataset['testid'] = spec.testId;
  }
  return element;
}

/**
 * 创建一个 `<button type="button">`。
 *
 * @param label - 按钮文案。
 * @param spec - 可选的类名与 testId；`text` 由 `label` 决定。
 * @returns 新建的按钮元素。
 */
export function createButton(label: string, spec: ElementSpec = {}): HTMLButtonElement {
  const button = createEl('button', spec);
  // 显式 type 而不是依赖默认值：默认值是 `submit`，在多表单布局里会带来意外提交。
  button.type = 'button';
  button.textContent = label;
  return button;
}

/**
 * 通过 `hidden` 属性控制显隐。
 *
 * 统一走 `hidden` 而不是 `style.display`，是为了让 CSS 用
 * `[hidden] { display: none }` 一处收口；组件内部也只需读 `element.hidden`
 * 就能知道自己的可见状态。
 *
 * @param element - 目标元素。
 * @param visible - true 显示，false 隐藏。
 */
export function setVisible(element: HTMLElement, visible: boolean): void {
  element.hidden = !visible;
}

/** 把 `value` 限制在 `[min, max]` 内。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
