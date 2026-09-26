/**
 * Boot overlay.
 *
 * I. Responsibilities
 *
 * 1. Shows the loading state between "HTML parsed" and "first frame rendered",
 *    which is the only moment the player would otherwise stare at a black page.
 * 2. Renders unrecoverable failures (no WebGL, bad configuration) as readable
 *    text with a retry action. This satisfies the "error handling" requirement
 *    without letting game code touch the DOM directly.
 *
 * II. Ownership
 *
 * The overlay owns its subtree only. It never removes the canvas, so a failed
 * later stage can still show the last rendered frame behind the error card.
 *
 * @module ui/BootOverlay
 */

import type { AppError } from '@/utils/errors';

/** Visual state of the overlay. */
export type BootOverlayState = 'loading' | 'fatal' | 'hidden';

const ROOT_CLASS = 'boot-screen';

export class BootOverlay {
  readonly #root: HTMLElement;
  #state: BootOverlayState = 'loading';
  #element: HTMLElement | null = null;
  #messageElement: HTMLElement | null = null;
  #progressElement: HTMLElement | null = null;
  #detailElement: HTMLElement | null = null;

  public constructor(root: HTMLElement) {
    this.#root = root;

    // I. Adopt the static loading card from `index.html`.
    // 1. It is already on screen before the bundle is parsed; taking ownership
    //    instead of appending a second card avoids a visible duplicate and lets
    //    the first `showLoading()` swap the text in place.
    const existing = root.querySelector<HTMLElement>(`.${ROOT_CLASS}`);
    if (existing !== null) {
      this.#element = existing;
      this.#messageElement = existing.querySelector<HTMLElement>(`.${ROOT_CLASS}__message`);
      this.#progressElement = existing.querySelector<HTMLElement>(`.${ROOT_CLASS}__progress`);
    }
  }

  public get state(): BootOverlayState {
    return this.#state;
  }

  /** Renders the loading card, replacing any previous content. */
  public showLoading(message = '正在初始化引擎…'): void {
    this.#state = 'loading';
    this.#render('正在启动', message, { testId: 'boot-loading', variant: 'loading' });
  }

  /**
   * Updates the loading message and optional progress bar.
   *
   * @param message - Text shown under the title.
   * @param fraction - `null` hides the bar; `0..1` fills it.
   */
  public setProgress(message: string, fraction: number | null): void {
    if (this.#state !== 'loading') {
      return;
    }
    if (this.#messageElement !== null) {
      this.#messageElement.textContent = message;
    }
    if (this.#progressElement !== null) {
      if (fraction === null) {
        this.#progressElement.hidden = true;
      } else {
        this.#progressElement.hidden = false;
        const clamped = Math.max(0, Math.min(1, fraction));
        const fill = this.#progressElement.firstElementChild;
        if (fill instanceof HTMLElement) {
          fill.style.width = `${(clamped * 100).toFixed(1)}%`;
        }
      }
    }
  }

  /**
   * Replaces the overlay with an error card.
   *
   * @param error - Failure to present to the player.
   */
  public showFatal(error: AppError): void {
    this.#state = 'fatal';
    this.#render('无法启动游戏', error.userMessage, {
      testId: 'boot-fatal',
      variant: 'fatal',
    });
    if (this.#detailElement !== null) {
      this.#detailElement.textContent = `错误代码：${error.code}｜技术信息：${error.message}`;
    }
  }

  /** Fades the overlay out and detaches it. */
  public hide(): void {
    const element = this.#element;
    this.#state = 'hidden';
    this.#element = null;
    this.#messageElement = null;
    this.#progressElement = null;
    this.#detailElement = null;

    if (element === null) {
      return;
    }

    element.classList.add(`${ROOT_CLASS}--leaving`);
    // `remove()` after the transition keeps the DOM clean but must not depend on
    // the transition firing (headless browsers can skip it), hence the timeout.
    const remove = (): void => {
      element.remove();
    };
    element.addEventListener('transitionend', remove, { once: true });
    window.setTimeout(remove, 400);
  }

  /** Immediate teardown, used when the app is disposed in tests. */
  public dispose(): void {
    this.#element?.remove();
    this.#element = null;
    this.#messageElement = null;
    this.#progressElement = null;
    this.#detailElement = null;
    this.#state = 'hidden';
  }

  #render(
    title: string,
    message: string,
    options: { readonly testId: string; readonly variant: 'loading' | 'fatal' },
  ): void {
    this.#element?.remove();

    const element = document.createElement('div');
    element.className = `${ROOT_CLASS} ${ROOT_CLASS}--${options.variant}`;
    element.dataset['testid'] = options.testId;

    const card = document.createElement('div');
    card.className = `${ROOT_CLASS}__card`;

    const heading = document.createElement('h1');
    heading.className = `${ROOT_CLASS}__title`;
    heading.textContent = title;

    const paragraph = document.createElement('p');
    paragraph.className = `${ROOT_CLASS}__message`;
    paragraph.textContent = message;

    card.append(heading, paragraph);

    if (options.variant === 'loading') {
      const progress = document.createElement('div');
      progress.className = `${ROOT_CLASS}__progress`;
      progress.hidden = true;
      const fill = document.createElement('div');
      fill.className = `${ROOT_CLASS}__progress-fill`;
      progress.append(fill);
      card.append(progress);
      this.#progressElement = progress;
    } else {
      const detail = document.createElement('p');
      detail.className = `${ROOT_CLASS}__detail`;
      const reload = document.createElement('button');
      reload.type = 'button';
      reload.className = `${ROOT_CLASS}__action`;
      reload.textContent = '重新加载';
      reload.addEventListener('click', () => {
        window.location.reload();
      });
      card.append(detail, reload);
      this.#detailElement = detail;
    }

    element.append(card);
    this.#root.append(element);

    this.#element = element;
    this.#messageElement = paragraph;
  }
}
