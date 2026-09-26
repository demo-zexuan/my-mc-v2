/**
 * 主菜单。
 *
 * I. 信息结构
 *
 * 1. 顶部是身份（标题 + 一句话说明），中部是唯一的主动作"开始游戏"，其余选项
 *    （新建世界、设置、返回）按使用频率往下排，底部是操作提示与版本号。
 * 2. 种子输入与"新建世界"放在同一行：种子是这个世界独有的东西，挨着它的动作才
 *    不会被误读成"设置里的某个字段"。
 *
 * II. 为什么种子要在这里校验
 *
 * 非法种子如果直接传给世界生成器，玩家要等到世界加载失败才知道输错了。这里用
 * 一条与生成器无关的宽松规则（中英文、数字、空格、下划线、连字符，最多 32 个
 * 字）在输入时就给出反馈，空字符串则代表"随机种子"。UI 不决定种子的语义，
 * 只保证交出去的字符串是干净的。
 *
 * III. 模态
 *
 * 继承 `ModalScreen`：打开时通过 `onOpen` 通知调用方释放指针锁定，关闭时
 * `onClose` 通知回去。
 *
 * @module ui/MainMenu
 */

import { createButton, createEl } from './dom';
import { ModalScreen, type ModalScreenOptions } from './ModalScreen';

export interface MainMenuOptions extends ModalScreenOptions {
  /** 继续上一次的世界。 */
  readonly onStart: () => void;
  /**
   * 新建世界。
   *
   * @param seed - 已 trim 的种子；空字符串表示由生成器随机选取。
   */
  readonly onNewWorld: (seed: string) => void;
  /** 进入设置界面。 */
  readonly onSettings: () => void;
  /** 返回；省略时"返回"按钮会被隐藏，而不是留一个点了没反应的控件。 */
  readonly onBack?: () => void;
  /** 版本号，显示为 `版本 v0.1.0`；省略时显示"开发构建"。 */
  readonly version?: string;
  /** 覆盖内置的操作提示行。 */
  readonly controlHints?: readonly string[];
}

/** 由调用方按当前会话状态刷新的信息。 */
export interface MainMenuInfo {
  /** 是否存在可继续的存档；false 时"开始游戏"不可用。 */
  readonly hasSave?: boolean;
  /** 版本号，运行时发现的（例如构建注入）；`null` 或空串显示"开发构建"。 */
  readonly version?: string | null;
  /** 预填的种子。 */
  readonly seed?: string;
}

/** 种子允许的字符：任意语言的字母、数字、空格、下划线、连字符，最长 32。 */
const SEED_PATTERN = /^[\p{L}\p{N} _-]{0,32}$/u;

const DEFAULT_HINTS: readonly string[] = [
  'WASD 移动 · 空格 跳跃 · Shift 疾跑',
  '左键 挖掘 · 右键 放置 · 滚轮或 1-9 切换物品',
  'E 背包 · ESC 暂停并保存',
];

export class MainMenu extends ModalScreen {
  readonly #startButton: HTMLButtonElement;
  readonly #startHint: HTMLElement;
  readonly #seedInput: HTMLInputElement;
  readonly #seedError: HTMLElement;
  readonly #versionElement: HTMLElement;
  readonly #backButton: HTMLButtonElement;
  readonly #onStart: () => void;
  readonly #onNewWorld: (seed: string) => void;
  readonly #onSettings: () => void;
  readonly #onBack: (() => void) | null;

  public constructor(root: HTMLElement, options: MainMenuOptions) {
    super(root, { className: 'main-menu', testId: 'main-menu', ariaLabel: '主菜单' }, options);

    this.#onStart = options.onStart;
    this.#onNewWorld = options.onNewWorld;
    this.#onSettings = options.onSettings;
    this.#onBack = options.onBack ?? null;

    // I. 标题区：这是屏幕上唯一"宣告这是什么游戏"的地方。
    const header = createEl('header', { className: 'menu-header' });
    header.append(
      createEl('span', { className: 'menu-header__eyebrow', text: 'VOXEL SANDBOX' }),
      createEl('h1', {
        className: 'menu-header__title',
        text: 'My MC v2',
        testId: 'main-menu-title',
      }),
      createEl('p', {
        className: 'menu-header__subtitle',
        text: '在程序化生成的地形里挖掘、建造、探索到天亮。',
      }),
    );

    // II. 主操作 + 存档提示。
    const startBlock = createEl('div', { className: 'menu-block' });
    this.#startButton = createButton('开始游戏', {
      className: 'menu-button menu-button--primary menu-button--wide',
      testId: 'main-menu-start',
    });
    this.#startButton.addEventListener('click', () => {
      this.#onStart();
    });
    this.#startHint = createEl('p', {
      className: 'menu-block__hint',
      text: '从上次存档继续。',
      testId: 'main-menu-start-hint',
    });
    startBlock.append(this.#startButton, this.#startHint);

    // III. 新建世界：种子输入与动作在同一行。
    const newWorldBlock = createEl('div', { className: 'menu-block' });
    const seedRow = createEl('div', { className: 'seed-row' });
    const seedLabel = createEl('label', { className: 'seed-row__label', text: '世界种子' });
    this.#seedInput = createEl('input', { className: 'seed-row__input', testId: 'main-menu-seed' });
    this.#seedInput.type = 'text';
    this.#seedInput.maxLength = 32;
    this.#seedInput.placeholder = '留空则随机';
    this.#seedInput.id = 'main-menu-seed-input';
    seedLabel.htmlFor = this.#seedInput.id;
    this.#seedInput.addEventListener('input', () => {
      this.#validateSeed();
    });
    this.#seedInput.addEventListener('keydown', (event) => {
      // 回车等同于点击"新建世界"，这是表单型输入框的通用预期。
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#submitSeed();
      }
    });
    const newWorldButton = createButton('新建世界', {
      className: 'menu-button',
      testId: 'main-menu-new-world',
    });
    newWorldButton.addEventListener('click', () => {
      this.#submitSeed();
    });
    seedRow.append(seedLabel, this.#seedInput, newWorldButton);

    this.#seedError = createEl('p', {
      className: 'seed-row__error',
      testId: 'main-menu-seed-error',
    });
    this.#seedError.hidden = true;
    newWorldBlock.append(seedRow, this.#seedError);

    // IV. 次级操作：设置与返回。
    const secondary = createEl('div', { className: 'menu-row' });
    const settingsButton = createButton('设置', {
      className: 'menu-button',
      testId: 'main-menu-settings',
    });
    settingsButton.addEventListener('click', () => {
      this.#onSettings();
    });
    this.#backButton = createButton('返回', {
      className: 'menu-button menu-button--ghost',
      testId: 'main-menu-back',
    });
    this.#backButton.addEventListener('click', () => {
      this.#onBack?.();
    });
    this.#backButton.hidden = this.#onBack === null;
    secondary.append(settingsButton, this.#backButton);

    // V. 底部：操作提示与版本号。
    const footer = createEl('footer', { className: 'menu-footer' });
    const hints = createEl('ul', { className: 'menu-footer__hints', testId: 'main-menu-controls' });
    for (const hint of options.controlHints ?? DEFAULT_HINTS) {
      hints.append(createEl('li', { className: 'menu-footer__hint', text: hint }));
    }
    this.#versionElement = createEl('p', {
      className: 'menu-footer__version',
      testId: 'main-menu-version',
    });
    footer.append(hints, this.#versionElement);

    this.card.append(header, startBlock, newWorldBlock, secondary, footer);

    this.update({ version: options.version ?? null, hasSave: true });
  }

  /**
   * 种子输入框的当前内容。
   *
   * I. 为什么主菜单要暴露这个
   *
   * "开始游戏"在没有存档时会走新建世界这条路径，如果它忽略玩家刚输入的种子，
   * 就会出现"填了种子却拿到随机世界"的困惑。让调用方读取同一个输入框，两条路径
   * 的行为就完全一致。
   */
  public getSeedText(): string {
    return this.#seedInput.value.trim();
  }

  /**
   * 刷新会话相关信息。
   *
   * @param info - 只传需要变化的字段；未传的字段保持原样。
   */
  public update(info: MainMenuInfo): void {
    if (info.hasSave !== undefined) {
      // I. 开始游戏永远可点。
      // 1. 之前在没有存档时把它禁用，玩家的第一反应是"这个按钮坏了" —— 主按钮
      //    点不动是最容易被当成缺陷的交互，即使旁边写了解释。
      // 2. 现在没有存档时它就等价于"用下面的种子新建世界"（留空即随机），按钮文案
      //    与提示同步说明会发生什么，玩家不需要先理解"继续"和"新建"的区别。
      this.#startButton.disabled = false;
      this.#startButton.textContent = info.hasSave ? '开始游戏' : '开始新世界';
      this.#startHint.textContent = info.hasSave
        ? '从上次存档继续。'
        : '还没有存档：将按下方种子创建一个新世界（留空则随机）。';
    }

    if (info.version !== undefined) {
      const version = info.version;
      this.#versionElement.textContent =
        version === null || version === '' ? '开发构建' : `版本 v${version}`;
    }

    if (info.seed !== undefined) {
      this.#seedInput.value = info.seed;
      this.#validateSeed();
    }
  }

  /**
   * 控制"返回"按钮是否出现。
   *
   * 从暂停菜单回到主菜单时它有意义；首次启动时没有可返回的会话，按钮应消失。
   *
   * @param canReturn - 是否显示返回按钮。
   */
  public setCanReturn(canReturn: boolean): void {
    this.#backButton.hidden = !canReturn || this.#onBack === null;
  }

  /** 提交种子；非法时只提示、不回调。 */
  #submitSeed(): void {
    if (!this.#validateSeed()) {
      this.#seedInput.focus();
      return;
    }
    this.#onNewWorld(this.#seedInput.value.trim());
  }

  /** 实时校验种子并把结果写进错误行。 */
  #validateSeed(): boolean {
    const valid = SEED_PATTERN.test(this.#seedInput.value.trim());
    this.#seedError.hidden = valid;
    if (!valid) {
      this.#seedError.textContent =
        '种子只能包含中英文、数字、空格、下划线与连字符，最多 32 个字。';
      this.#seedInput.setAttribute('aria-invalid', 'true');
      return false;
    }
    this.#seedInput.removeAttribute('aria-invalid');
    return true;
  }
}
