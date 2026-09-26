/**
 * 右上角提示栈（保存成功、资源不足、存档损坏……）。
 *
 * I. 为什么要一个栈而不是单个提示
 *
 * 1. 挖掘失败、背包已满、保存完成可能在同一秒内发生；单条提示会被后来的覆盖，
 *    玩家只看到最后一条，等于丢失信息。
 * 2. 同时可见数量有上限（默认 5），超出时丢弃最旧的一条：提示是"打断性"的
 *    信息，屏幕右上角不能被它刷屏。
 *
 * II. 为什么容器不吃指针事件，而单条提示吃
 *
 * 容器覆盖右上角一整块区域，如果可交互就会挡住画布右上角的点击。因此容器
 * `pointer-events: none`，只有关闭按钮所在的单条提示 `pointer-events: auto`。
 *
 * III. 关于 `update()`
 *
 * 提示是事件驱动的，没有"快照"可同步。为了让本组件与其它面板遵守同一套
 * 组件契约（constructor / update / show / hide / dispose），`update()` 就是
 * "推入一条提示"的语义入口。
 *
 * @module ui/NoticeStack
 */

import { createEl, setVisible } from './dom';

/** 提示语气，决定配色与自动消失时长。 */
export type NoticeKind = 'info' | 'success' | 'warning' | 'error';

/** 一次提示的呈现选项。 */
export interface NoticePushOptions {
  /** 省略时为 `info`。 */
  readonly kind?: NoticeKind;
  /** 覆盖该语气默认的停留时长，单位毫秒。 */
  readonly durationMs?: number;
}

/** 一次提示的内容（`update()` 的入参）。 */
export interface NoticeInput extends NoticePushOptions {
  readonly message: string;
}

export interface NoticeStackOptions {
  /** 默认停留时长（毫秒）。单条提示可覆盖。 */
  readonly durationMs?: number;
  /** 同时可见的最大条数，超出丢弃最旧的。 */
  readonly maxVisible?: number;
}

const ROOT_CLASS = 'notice-stack';
const NOTICE_CLASS = 'notice';

/** 淡出动画时长，与 CSS 中的 transition 保持一致。 */
const FADE_MS = 220;

/** 各语气的默认停留时长：越需要玩家注意的留得越久。 */
const DURATIONS: Readonly<Record<NoticeKind, number>> = {
  info: 3200,
  success: 3000,
  warning: 4200,
  error: 6000,
};

export class NoticeStack {
  readonly #element: HTMLElement;
  readonly #defaultDuration: number | null;
  readonly #maxVisible: number;
  readonly #notices: HTMLElement[] = [];
  readonly #timers = new Map<HTMLElement, number[]>();
  #disposed = false;

  /**
   * @param root - 宿主元素，通常是 `#app`。
   * @param options - 时长与并发上限。
   */
  public constructor(root: HTMLElement, options: NoticeStackOptions = {}) {
    this.#element = createEl('div', { className: ROOT_CLASS, testId: 'notice-stack' });
    // 提示是"事后告知"，不该打断读屏正在朗读的内容，因此用 polite。
    this.#element.setAttribute('aria-live', 'polite');
    this.#defaultDuration = options.durationMs ?? null;
    this.#maxVisible = Math.max(1, Math.trunc(options.maxVisible ?? 5));

    setVisible(this.#element, false);
    root.append(this.#element);
  }

  /** 当前可见条数。 */
  public get count(): number {
    return this.#notices.length;
  }

  /** 是否可见。 */
  public get visible(): boolean {
    return !this.#element.hidden;
  }

  /**
   * 推入一条提示。
   *
   * @param message - 文案；只用 `textContent` 写入，不解析 HTML。
   * @param options - 语气与停留时长。
   */
  public push(message: string, options: NoticePushOptions = {}): void {
    if (this.#disposed) {
      return;
    }

    const kind = options.kind ?? 'info';
    const notice = createEl('div', {
      className: `${NOTICE_CLASS} ${NOTICE_CLASS}--${kind}`,
      testId: 'notice',
    });
    notice.dataset['kind'] = kind;

    const text = createEl('span', { className: `${NOTICE_CLASS}__text`, text: message });
    const close = createEl('button', {
      className: `${NOTICE_CLASS}__close`,
      testId: 'notice-close',
      text: '✕',
    });
    close.setAttribute('aria-label', '关闭提示');
    close.addEventListener('click', () => {
      this.#dismiss(notice);
    });

    notice.append(text, close);
    this.#element.append(notice);
    this.#notices.push(notice);
    this.show();

    // I. 超出上限时立即丢弃最旧的。
    // 1. 用 `while` 而不是 `if`：上限可以在构造后被外部数据放大，保持幂等更安全。
    while (this.#notices.length > this.#maxVisible) {
      const oldest = this.#notices[0];
      if (oldest === undefined) {
        break;
      }
      this.#forget(oldest);
    }

    const duration = options.durationMs ?? this.#defaultDuration ?? DURATIONS[kind];
    const timer = window.setTimeout(() => {
      this.#dismiss(notice);
    }, duration);
    this.#timers.set(notice, [timer]);
  }

  /**
   * 组件契约里的"更新"入口：提示栈没有快照状态，更新即推入一条。
   *
   * @param notice - 提示内容。
   */
  public update(notice: NoticeInput): void {
    this.push(notice.message, notice);
  }

  /** 显示容器（推入提示时会自动调用）。 */
  public show(): void {
    setVisible(this.#element, true);
  }

  /** 隐藏容器；已存在的提示保留，下次 `show()` 会重新出现。 */
  public hide(): void {
    setVisible(this.#element, false);
  }

  /** 立即移除全部提示。 */
  public clear(): void {
    for (const notice of [...this.#notices]) {
      this.#forget(notice);
    }
  }

  /** 移除子树、清掉所有定时器。幂等。 */
  public dispose(): void {
    this.#disposed = true;
    for (const timers of this.#timers.values()) {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    }
    this.#timers.clear();
    this.#notices.length = 0;
    this.#element.remove();
  }

  /** 触发淡出，稍后移除；重复调用无副作用。 */
  #dismiss(notice: HTMLElement): void {
    if (!this.#notices.includes(notice) || notice.classList.contains(`${NOTICE_CLASS}--leaving`)) {
      return;
    }
    notice.classList.add(`${NOTICE_CLASS}--leaving`);
    // jsdom 不会触发 transitionend，因此淡出结束后用定时器兜底移除，
    // 这样单元测试里时间前进后 DOM 一定干净。
    const timer = window.setTimeout(() => {
      this.#forget(notice);
    }, FADE_MS);
    const timers = this.#timers.get(notice);
    if (timers !== undefined) {
      timers.push(timer);
    } else {
      this.#timers.set(notice, [timer]);
    }
  }

  /** 移除节点、清掉它的定时器，并从可见列表里摘掉。 */
  #forget(notice: HTMLElement): void {
    this.#removeNow(notice);
    const index = this.#notices.indexOf(notice);
    if (index >= 0) {
      this.#notices.splice(index, 1);
    }
  }

  /** 立刻移除节点与其定时器。 */
  #removeNow(notice: HTMLElement): void {
    const timers = this.#timers.get(notice);
    if (timers !== undefined) {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
      this.#timers.delete(notice);
    }
    notice.remove();
  }
}
