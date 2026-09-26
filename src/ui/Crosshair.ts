/**
 * 准星。
 *
 * I. 为什么用四个线段而不是"一横一竖"
 *
 * 1. 四种形态（左/右/上/下）各自锚定在屏幕正中心的同一个点上，用
 *    `translate(±(100% + gap))` 偏移，因此**无论线段多长，中心永远精确重合**
 *    ——不存在"加个 margin 后整体偏半像素"的问题。
 * 2. 中间留出的空隙让准星不遮挡瞄准点，这在挖掘方块时能看清目标面。
 *
 * II. 两种形态
 *
 * 1. `default`：细的冷白色十字，用于探索。
 * 2. `interactive`：瞄准可交互方块（可挖掘/可放置）时，线段缩短、变成阳光色，
 *    并出现一个圆环。这个变化是纯视觉反馈，不改变任何游戏状态——UI 仍然只
 *    接收快照与回调。
 *
 * III. 非模态
 *
 * 准星永远是 `pointer-events: none`，否则它会吃掉正中心的点击，玩家就无法
 * 挖掘正前方一格。
 *
 * @module ui/Crosshair
 */

import { createEl, setVisible } from './dom';

/** 准星形态。 */
export type CrosshairMode = 'default' | 'interactive';

/** 一帧的瞄准信息，由交互系统提供。 */
export interface CrosshairAim {
  /** 当前准星指向的方块是否可交互。 */
  readonly interactable: boolean;
  /**
   * 可选的方块名提示，显示在准星下方。
   * 省略（或传空字符串）表示不显示，例如指向空气时。
   */
  readonly label?: string;
}

const ROOT_CLASS = 'crosshair';

/** 四段线段的方位，顺序与 DOM 顺序一致。 */
const SEGMENTS = ['left', 'right', 'top', 'bottom'] as const;

export class Crosshair {
  readonly #element: HTMLElement;
  readonly #label: HTMLElement;
  #mode: CrosshairMode = 'default';

  /**
   * @param root - 宿主元素，通常是 `#app`。
   */
  public constructor(root: HTMLElement) {
    this.#element = createEl('div', {
      className: `${ROOT_CLASS} ${ROOT_CLASS}--default`,
      testId: 'crosshair',
    });
    // 准星是纯装饰：读屏软件不需要知道它的存在，游戏状态由 HUD 文本负责。
    this.#element.setAttribute('aria-hidden', 'true');
    this.#element.dataset['mode'] = 'default';

    for (const segment of SEGMENTS) {
      this.#element.append(
        createEl('span', {
          className: `${ROOT_CLASS}__segment ${ROOT_CLASS}__segment--${segment}`,
        }),
      );
    }

    this.#element.append(createEl('span', { className: `${ROOT_CLASS}__ring` }));

    this.#label = createEl('span', {
      className: `${ROOT_CLASS}__label`,
      testId: 'crosshair-label',
    });
    this.#label.hidden = true;
    this.#element.append(this.#label);

    setVisible(this.#element, false);
    root.append(this.#element);
  }

  /** 当前形态。 */
  public get mode(): CrosshairMode {
    return this.#mode;
  }

  /** 是否可见。 */
  public get visible(): boolean {
    return !this.#element.hidden;
  }

  /**
   * 切换形态。
   *
   * @param mode - `default` 或 `interactive`。
   */
  public setMode(mode: CrosshairMode): void {
    this.#mode = mode;
    this.#element.classList.toggle(`${ROOT_CLASS}--interactive`, mode === 'interactive');
    this.#element.classList.toggle(`${ROOT_CLASS}--default`, mode === 'default');
    this.#element.dataset['mode'] = mode;
  }

  /**
   * 按瞄准信息更新形态与提示。
   *
   * @param aim - 本帧的瞄准结果。
   */
  public update(aim: CrosshairAim): void {
    this.setMode(aim.interactable ? 'interactive' : 'default');
    const label = aim.label ?? '';
    this.#label.textContent = label;
    this.#label.hidden = label === '';
  }

  /** 显示准星，通常与"进入 playing 状态"绑定。 */
  public show(): void {
    setVisible(this.#element, true);
  }

  /** 隐藏准星，通常与"打开任意模态界面"绑定。 */
  public hide(): void {
    setVisible(this.#element, false);
  }

  /** 移除自己创建的子树。幂等。 */
  public dispose(): void {
    this.#element.remove();
  }
}
