/**
 * 快捷栏（9 格，屏幕底部居中）。
 *
 * I. 职责边界
 *
 * 1. 组件只把 `InventorySnapshot` 画出来，并向下发"玩家想切换高亮格"的意图
 *    （`onSelect`）。真正的选中状态由背包实现持有，切换后调用方应立刻用新快照
 *    调一次 `update()` —— 这就是"快照 + 回调"的闭环。
 * 2. 因为不持有背包，1-9 数字键与滚轮放在这里也不会产生第二份状态；如果调用方
 *    的输入层已经处理了滚轮，用 `inputEnabled: false` 关掉即可，避免一次滚动
 *    切换两格。
 *
 * II. 为什么 update() 做差量渲染
 *
 * 拾取/放置只会让某一格变化，但 `update()` 可能每帧都被调用。逐格比较
 * (item, count) 后只重建真正变化的槽位，既省下每帧 9 次 DOM 重建，也避免悬停
 * 中的槽位被整体替换导致 `title` 提示闪烁。
 *
 * III. 居中与不吃指针事件
 *
 * 容器用 `left: 50%` + `translateX(-50%)` 精确水平居中（与内容宽度无关）；整块
 * `pointer-events: none`，点击底部不会挡住画布。正因为槽位不可点击，键盘与滚轮
 * 监听挂在 `window` 上。
 *
 * @module ui/Hotbar
 */

import { HOTBAR_SLOTS, type InventorySnapshot, type ItemStack } from '@/inventory/types';

import { createEl, setVisible } from './dom';
import { createItemIcon, ITEM_ICON_CLASS } from './itemIcon';
import { visualFor } from './itemVisuals';

export interface HotbarOptions {
  /**
   * 玩家请求切换高亮格时调用。
   *
   * @param index - 已在 `0 .. slotCount - 1` 内回绕的目标格。
   */
  readonly onSelect?: (index: number) => void;
  /** 槽位数，默认 9（`HOTBAR_SLOTS`）。 */
  readonly slotCount?: number;
  /** 是否自行接管 1-9 与滚轮，默认 true。 */
  readonly inputEnabled?: boolean;
}

const ROOT_CLASS = 'hotbar';
const SELECTED_CLASS = `${ROOT_CLASS}__slot--selected`;

/** 滚轮累计到该阈值才切换一格，避免触摸板的高频小 delta 一次跳很多格。 */
const WHEEL_THRESHOLD = 40;

/** 数字键：主键盘与数字小键盘都支持。 */
const DIGIT_PATTERN = /^(?:Digit|Numpad)([1-9])$/;

interface SlotParts {
  readonly root: HTMLElement;
  /** 物品种类变化时整个图标节点会被替换，因此不是 readonly 引用。 */
  icon: HTMLElement;
  readonly count: HTMLElement;
  /** 当前图标对应的物品 id，用于跳过重复着色。 */
  iconItem: number | null;
}

export class Hotbar {
  readonly #element: HTMLElement;
  readonly #label: HTMLElement;
  readonly #slots: SlotParts[] = [];
  readonly #stacks: (ItemStack | null)[] = [];
  readonly #slotCount: number;
  readonly #onSelect: ((index: number) => void) | null;
  /** 上一次写入标签的 "item:count" 键，避免每帧重写文本。 */
  #labelKey = '';
  #selectedIndex = 0;
  #inputEnabled: boolean;
  #visible = false;
  #wheelAccumulator = 0;

  /**
   * @param root - 宿主元素，通常是 `#app`。
   * @param options - 回调、槽位数与输入接管开关。
   */
  public constructor(root: HTMLElement, options: HotbarOptions = {}) {
    this.#slotCount = Math.max(1, Math.trunc(options.slotCount ?? HOTBAR_SLOTS));
    this.#inputEnabled = options.inputEnabled ?? true;
    this.#onSelect = options.onSelect ?? null;

    this.#element = createEl('div', { className: ROOT_CLASS, testId: 'hotbar' });

    this.#label = createEl('div', {
      className: `${ROOT_CLASS}__label`,
      testId: 'hotbar-label',
    });
    // 选中的物品名变化时让读屏播报一次；槽位本身是装饰性的。
    this.#label.setAttribute('aria-live', 'polite');
    this.#label.hidden = true;

    const slotRow = createEl('div', { className: `${ROOT_CLASS}__slots`, testId: 'hotbar-slots' });
    slotRow.setAttribute('aria-hidden', 'true');

    for (let index = 0; index < this.#slotCount; index += 1) {
      const slot = createEl('div', { className: `${ROOT_CLASS}__slot`, testId: 'hotbar-slot' });
      slot.dataset['index'] = String(index);
      slot.dataset['empty'] = 'true';

      const key = createEl('span', { className: `${ROOT_CLASS}__key`, text: String(index + 1) });
      const icon = createEl('div', { className: ITEM_ICON_CLASS });
      icon.hidden = true;
      const count = createEl('span', { className: 'slot-count' });

      slot.append(key, icon, count);
      slotRow.append(slot);

      this.#slots.push({ root: slot, icon, count, iconItem: null });
      this.#stacks.push(null);
    }

    this.#element.append(this.#label, slotRow);
    setVisible(this.#element, false);
    root.append(this.#element);

    this.#applySelection(0);

    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('wheel', this.#onWheel, { passive: false });
  }

  /** 当前高亮格索引。 */
  public get selectedIndex(): number {
    return this.#selectedIndex;
  }

  /** 槽位总数。 */
  public get slotCount(): number {
    return this.#slotCount;
  }

  /** 是否可见。 */
  public get visible(): boolean {
    return this.#visible;
  }

  /**
   * 用最新快照刷新各格。
   *
   * @param snapshot - 背包快照，`slots[0..8]` 为快捷栏。
   */
  public update(snapshot: InventorySnapshot): void {
    for (let index = 0; index < this.#slots.length; index += 1) {
      const stack = snapshot.slots[index] ?? null;
      if (!isSameStack(this.#stacks[index] ?? null, stack)) {
        this.#stacks[index] = stack;
        this.#renderSlot(index, stack);
      }
    }

    const selected = wrapIndex(snapshot.selected, this.#slotCount);
    if (selected !== this.#selectedIndex) {
      this.#applySelection(selected);
    }
    this.#syncLabel(selected);
  }

  /**
   * 请求切换到指定格（会回绕）。
   *
   * @param index - 目标索引；越界值按槽位数回绕。
   */
  public select(index: number): void {
    this.#emit(wrapIndex(index, this.#slotCount));
  }

  /**
   * 相对切换高亮格。
   *
   * @param delta - 正数向后、负数向前。
   */
  public step(delta: number): void {
    this.#emit(wrapIndex(this.#selectedIndex + delta, this.#slotCount));
  }

  /**
   * 开关内置输入。
   *
   * @param enabled - false 时忽略 1-9 与滚轮，交给外部输入层处理，避免双重切换。
   */
  public setInputEnabled(enabled: boolean): void {
    this.#inputEnabled = enabled;
  }

  /** 显示快捷栏（进入 playing 状态时调用）。 */
  public show(): void {
    this.#visible = true;
    setVisible(this.#element, true);
  }

  /** 隐藏快捷栏（进入菜单/加载时调用）。 */
  public hide(): void {
    this.#visible = false;
    setVisible(this.#element, false);
  }

  /** 注销全局监听并移除子树。幂等。 */
  public dispose(): void {
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('wheel', this.#onWheel);
    this.#slots.length = 0;
    this.#stacks.length = 0;
    this.#element.remove();
  }

  /** 数字键：只认 1-9，且不抢带修饰键的组合键与长按重复。 */
  #onKeyDown = (event: KeyboardEvent): void => {
    if (!this.#inputEnabled || !this.#visible) {
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) {
      return;
    }
    const match = DIGIT_PATTERN.exec(event.code);
    const digit = match?.[1];
    if (digit === undefined) {
      return;
    }
    this.select(Number(digit) - 1);
  };

  /**
   * 滚轮：累加 deltaY 到阈值后切换一格。
   *
   * 触摸板一次手势会产生几十个事件，逐个切换会让高亮瞬间跳过整条快捷栏，
   * 因此这里做累计 + 归零。
   */
  #onWheel = (event: WheelEvent): void => {
    if (!this.#inputEnabled || !this.#visible) {
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      return;
    }
    this.#wheelAccumulator += event.deltaY;
    if (Math.abs(this.#wheelAccumulator) < WHEEL_THRESHOLD) {
      return;
    }
    const delta = this.#wheelAccumulator > 0 ? 1 : -1;
    this.#wheelAccumulator = 0;
    // 指针锁定期间阻止页面被滚轮带着走。
    event.preventDefault();
    this.step(delta);
  };

  /** 移动高亮类。 */
  #applySelection(selected: number): void {
    this.#slots[this.#selectedIndex]?.root.classList.remove(SELECTED_CLASS);
    this.#selectedIndex = selected;
    this.#slots[selected]?.root.classList.add(SELECTED_CLASS);
  }

  /** 选中格上方的物品名标签。 */
  #syncLabel(selected: number): void {
    const stack = this.#stacks[selected] ?? null;
    const key = stack === null ? '' : `${stack.item}:${stack.count}`;
    if (key === this.#labelKey) {
      return;
    }
    this.#labelKey = key;

    if (stack === null) {
      this.#label.textContent = '';
      this.#label.hidden = true;
      return;
    }
    const visual = visualFor(stack.item);
    this.#label.textContent =
      stack.count > 1 ? `${visual.displayName} ×${stack.count}` : visual.displayName;
    this.#label.hidden = false;
  }

  /** 重建单个槽位的内容。 */
  #renderSlot(index: number, stack: ItemStack | null): void {
    const slot = this.#slots[index];
    if (slot === undefined) {
      return;
    }

    if (stack === null) {
      slot.root.dataset['empty'] = 'true';
      delete slot.root.dataset['item'];
      delete slot.root.dataset['count'];
      slot.root.title = '';
      slot.icon.hidden = true;
      slot.count.textContent = '';
      slot.iconItem = null;
      return;
    }

    const visual = visualFor(stack.item);
    slot.root.dataset['empty'] = 'false';
    slot.root.dataset['item'] = String(stack.item);
    slot.root.dataset['count'] = String(stack.count);
    slot.root.title = `${visual.displayName} ×${stack.count}`;

    slot.icon.hidden = false;
    if (slot.iconItem !== stack.item) {
      // 只在物品种类变化时重算颜色与底纹，数量变化不需要动图标。
      slot.iconItem = stack.item;
      const replacement = createItemIcon(stack.item);
      slot.icon.replaceWith(replacement);
      slot.icon = replacement;
    }
    slot.count.textContent = stack.count > 1 ? String(stack.count) : '';
  }

  #emit(index: number): void {
    this.#onSelect?.(index);
  }
}

/** 把任意整数回绕到 `0 .. count-1`。 */
function wrapIndex(index: number, count: number): number {
  if (!Number.isFinite(index)) {
    return 0;
  }
  const wrapped = Math.trunc(index) % count;
  return wrapped < 0 ? wrapped + count : wrapped;
}

/** 内容相同则视为同一栈，用于跳过无意义的重绘。 */
function isSameStack(a: ItemStack | null, b: ItemStack | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.item === b.item && a.count === b.count;
}
