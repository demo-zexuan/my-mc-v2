/**
 * 模态界面基类（主菜单 / 暂停菜单 / 设置 / 背包）。
 *
 * I. 模态界面的三条共同义务
 *
 * 1. **不吃指针事件是错的**：模态层必须自己接管点击，否则玩家点到的是画布，会在
 *    菜单打开时意外挖掘方块。因此根元素带 `pointer-events: auto` 与不透明背板。
 * 2. **打开/关闭必须通知调用方**：调用方据此释放或重新获取指针锁定，并在
 *    `GameStateMachine` 上迁移状态。回调在这里统一触发，避免四个界面各写一遍。
 * 3. **可见性用 `hidden` 属性**：CSS 里每个自定义 display 的类都配了
 *    `[hidden] { display: none }`，所以 `hidden` 与 `display` 不会打架。
 *
 * II. 为什么重复触发要挡掉
 *
 * `show()` 在已可见时直接返回。指针锁定是"获取一次、释放一次"的配对操作，
 * 重复的 `onOpen` 会让调用方多释放一次，把状态机推到一个本不该有的状态。
 *
 * @module ui/ModalScreen
 */

import { createEl } from './dom';

/** 所有模态界面共有的回调。 */
export interface ModalScreenOptions {
  /** 界面显示后调用：调用方应释放指针锁定并暂停模拟。 */
  readonly onOpen?: () => void;
  /** 界面隐藏后调用：调用方可在确认状态允许时重新获取指针锁定。 */
  readonly onClose?: () => void;
}

/** 基类需要的静态描述。 */
export interface ModalScreenSpec {
  /** 附加在 `modal-screen` 之后的专属类名，例如 `main-menu`。 */
  readonly className: string;
  /** `data-testid`，供测试与 E2E 定位。 */
  readonly testId: string;
  /** 无障碍名称，通常是界面标题。 */
  readonly ariaLabel: string;
}

export abstract class ModalScreen {
  readonly #element: HTMLElement;
  readonly #card: HTMLElement;
  readonly #onOpen: (() => void) | null;
  readonly #onClose: (() => void) | null;

  /**
   * @param root - 宿主元素，通常是 `#app`。
   * @param spec - 类名、testId 与无障碍名称。
   * @param options - 打开/关闭回调。
   */
  protected constructor(
    root: HTMLElement,
    spec: ModalScreenSpec,
    options: ModalScreenOptions = {},
  ) {
    this.#element = createEl('div', {
      className: `modal-screen ${spec.className}`,
      testId: spec.testId,
    });
    this.#element.setAttribute('role', 'dialog');
    this.#element.setAttribute('aria-modal', 'true');
    this.#element.setAttribute('aria-label', spec.ariaLabel);

    this.#card = createEl('div', { className: 'modal-screen__card' });
    this.#element.append(this.#card);
    this.#element.hidden = true;

    this.#onOpen = options.onOpen ?? null;
    this.#onClose = options.onClose ?? null;

    root.append(this.#element);
  }

  /** 是否可见。 */
  public get visible(): boolean {
    return !this.#element.hidden;
  }

  /** 背板元素，子类可在此挂载内容（不暴露给外部调用方）。 */
  protected get card(): HTMLElement {
    return this.#card;
  }

  /** 显示界面；重复调用不会重复触发 `onOpen`。 */
  public show(): void {
    if (this.visible) {
      return;
    }
    this.#element.hidden = false;
    this.#onOpen?.();
  }

  /** 隐藏界面；重复调用不会重复触发 `onClose`。 */
  public hide(): void {
    if (!this.visible) {
      return;
    }
    this.#element.hidden = true;
    this.#onClose?.();
  }

  /** 移除自己的子树。子类覆写时应先清理监听器，再调用 `super.dispose()`。 */
  public dispose(): void {
    this.#element.remove();
  }
}
