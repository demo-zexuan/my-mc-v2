/**
 * 暂停菜单。
 *
 * I. 为什么它是三个动作而不是更多
 *
 * 暂停菜单是"我在游戏里按了 ESC"的直接回答：继续、改设置、存档退出。任何第四
 * 个选项（回到标题画面但不保存、重新开始……）都会让玩家在按 ESC 时开始犹豫。
 * 需要更多动作的功能应放到设置或背包里。
 *
 * II. 保存态
 *
 * "保存并退出"是一个耗时动作，期间它必须变成不可重复点击的"正在保存…"，
 * 并且**同时锁住继续与设置**：正在写存档时回到世界会让玩家以为进度已保住。
 * 这个状态由调用方通过 `update({ saving: true })` 推进来。
 *
 * @module ui/PauseMenu
 */

import { createButton, createEl, setVisible } from './dom';
import { ModalScreen, type ModalScreenOptions } from './ModalScreen';

export interface PauseMenuOptions extends ModalScreenOptions {
  /** 回到游戏。 */
  readonly onResume: () => void;
  /** 进入设置界面（返回后仍停在暂停态）。 */
  readonly onSettings: () => void;
  /** 保存并退回主菜单。 */
  readonly onSaveAndQuit: () => void;
}

/** 暂停界面顶部的会话信息。 */
export interface PauseSnapshot {
  /** 本次会话已游玩时长（毫秒）。 */
  readonly playTimeMs: number;
  /** 世界种子标签，例如 `seed-42` 或 `随机`。 */
  readonly seedLabel: string;
  /** 是否正在保存；true 时三个动作都不可用。 */
  readonly saving: boolean;
}

/**
 * 把毫秒格式化为 `HH:MM:SS`。
 *
 * @param milliseconds - 已游玩时长；负数按 0 处理。
 * @returns 等宽的时长文本。
 */
export function formatPlayTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export class PauseMenu extends ModalScreen {
  readonly #resumeButton: HTMLButtonElement;
  readonly #settingsButton: HTMLButtonElement;
  readonly #quitButton: HTMLButtonElement;
  readonly #meta: HTMLElement;
  readonly #status: HTMLElement;
  readonly #onResume: () => void;
  readonly #onSettings: () => void;
  readonly #onSaveAndQuit: () => void;

  public constructor(root: HTMLElement, options: PauseMenuOptions) {
    super(root, { className: 'pause-menu', testId: 'pause-menu', ariaLabel: '暂停菜单' }, options);

    this.#onResume = options.onResume;
    this.#onSettings = options.onSettings;
    this.#onSaveAndQuit = options.onSaveAndQuit;

    const header = createEl('header', { className: 'menu-header menu-header--compact' });
    header.append(
      createEl('h2', {
        className: 'menu-header__title',
        text: '已暂停',
        testId: 'pause-menu-title',
      }),
      createEl('p', {
        className: 'menu-header__subtitle',
        text: '世界已停止模拟，松开鼠标即可操作菜单。',
      }),
    );

    const actions = createEl('div', { className: 'menu-block' });
    this.#resumeButton = createButton('继续游戏', {
      className: 'menu-button menu-button--primary menu-button--wide',
      testId: 'pause-menu-resume',
    });
    this.#resumeButton.addEventListener('click', () => {
      this.#onResume();
    });
    this.#settingsButton = createButton('设置', {
      className: 'menu-button menu-button--wide',
      testId: 'pause-menu-settings',
    });
    this.#settingsButton.addEventListener('click', () => {
      this.#onSettings();
    });
    this.#quitButton = createButton('保存并退出到主菜单', {
      className: 'menu-button menu-button--wide menu-button--danger',
      testId: 'pause-menu-quit',
    });
    this.#quitButton.addEventListener('click', () => {
      this.#onSaveAndQuit();
    });
    actions.append(this.#resumeButton, this.#settingsButton, this.#quitButton);

    this.#meta = createEl('p', { className: 'pause-meta', testId: 'pause-menu-meta' });
    this.#status = createEl('p', { className: 'pause-status', testId: 'pause-menu-status' });
    this.#status.hidden = true;

    this.card.append(header, actions, this.#meta, this.#status);

    this.update({ playTimeMs: 0, seedLabel: '随机', saving: false });
  }

  /**
   * 刷新会话信息。
   *
   * @param snapshot - 时长、种子与保存状态。
   */
  public update(snapshot: PauseSnapshot): void {
    this.#meta.textContent = `本次游玩 ${formatPlayTime(snapshot.playTimeMs)} · 种子 ${snapshot.seedLabel}`;

    const saving = snapshot.saving;
    this.#resumeButton.disabled = saving;
    this.#settingsButton.disabled = saving;
    this.#quitButton.disabled = saving;
    this.#quitButton.textContent = saving ? '正在保存…' : '保存并退出到主菜单';
    this.#status.textContent = saving ? '正在写入存档，请不要关闭页面。' : '';
    setVisible(this.#status, saving);
  }
}
