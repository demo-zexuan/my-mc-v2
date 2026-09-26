/**
 * 背包界面（27 格物品栏 + 9 格独立快捷栏）。
 *
 * I. 交互模型：为什么要"先拾取、再放下"，而不是拖拽
 *
 * 1. 拖拽需要跟踪 pointerdown/move/up 与一个浮动的物品层，在指针被锁定、画布
 *    占据全屏的游戏里非常脆弱；点击式模型只有"已拾取格"一个状态，任何时刻都可
 *    用一个整数描述。
 * 2. 这个模型正好映射到冻结的 `Inventory` 接口：第一次点击记住来源格，第二次
 *    点击调用 `onMove(from, to)`；右键对应 `onSplit`，Shift+左键对应
 *    `onQuickMove`。UI 不自己搬数据，只报告意图——因此物品永远不会出现"UI 里
 *    有、背包里没有"的分裂状态。
 *
 * II. 精确的槽位索引
 *
 * 快照的 `slots[0..8]` 是快捷栏，`slots[9..35]` 是物品栏。界面把物品栏放在上
 * 面、快捷栏放在下面，但**索引用的是快照索引**，因此调用方拿到的 `from/to` 可以
 * 直接喂给 `Inventory.moveSlot`，不需要任何换算。
 *
 * III. 悬停提示
 *
 * 提示层是卡片内的绝对定位元素（不是全局 tooltip）：它随面板一起销毁，也不会在
 * 玩家点开背包时跑到屏幕其它位置去。
 *
 * @module ui/InventoryScreen
 */

import {
  BACKPACK_SLOTS,
  HOTBAR_SLOTS,
  type InventorySnapshot,
  type ItemStack,
} from '@/inventory/types';

import { createButton, createEl, setVisible } from './dom';
import { createItemIcon, ITEM_ICON_CLASS } from './itemIcon';
import { visualFor } from './itemVisuals';
import { ModalScreen, type ModalScreenOptions } from './ModalScreen';

export interface InventoryScreenOptions extends ModalScreenOptions {
  /**
   * 把整组物品从 `from` 移到 `to`。
   *
   * @param from - 来源槽位（快照索引）。
   * @param to - 目标槽位（快照索引）。
   */
  readonly onMove: (from: number, to: number) => void;
  /**
   * 把 `from` 的一半移到 `to`。
   *
   * @param from - 来源槽位。
   * @param to - 目标槽位。
   */
  readonly onSplit: (from: number, to: number) => void;
  /**
   * Shift+左键：在物品栏与快捷栏之间快速移动一格。
   *
   * @param index - 被点击的槽位。
   */
  readonly onQuickMove: (index: number) => void;
}

/** 槽位总数：快捷栏在前，物品栏在后，与快照一致。 */
const SLOT_COUNT = HOTBAR_SLOTS + BACKPACK_SLOTS;

const ROOT_CLASS = 'inventory';
const SLOT_SELECTOR = '[data-testid="inventory-slot"]';

interface SlotParts {
  readonly root: HTMLElement;
  icon: HTMLElement;
  readonly count: HTMLElement;
  iconItem: number | null;
}

export class InventoryScreen extends ModalScreen {
  readonly #slots: SlotParts[] = [];
  readonly #stacks: (ItemStack | null)[] = [];
  readonly #status: HTMLElement;
  readonly #usage: HTMLElement;
  readonly #tooltip: HTMLElement;
  readonly #body: HTMLElement;
  readonly #onMove: (from: number, to: number) => void;
  readonly #onSplit: (from: number, to: number) => void;
  readonly #onQuickMove: (index: number) => void;
  /** 已拾取但尚未放下的槽位；`null` 表示手上没有东西。 */
  #picked: number | null = null;
  #selected = 0;

  public constructor(root: HTMLElement, options: InventoryScreenOptions) {
    super(
      root,
      { className: 'inventory-screen', testId: 'inventory-screen', ariaLabel: '背包' },
      options,
    );

    this.#onMove = options.onMove;
    this.#onSplit = options.onSplit;
    this.#onQuickMove = options.onQuickMove;

    const header = createEl('header', { className: 'menu-header menu-header--compact' });
    const titleRow = createEl('div', { className: `${ROOT_CLASS}__title-row` });
    titleRow.append(
      createEl('h2', {
        className: 'menu-header__title',
        text: '背包',
        testId: 'inventory-title',
      }),
      this.#buildCloseButton(),
    );
    header.append(
      titleRow,
      createEl('p', {
        className: 'menu-header__subtitle',
        text: '左键 拾取 / 放下 · 右键 放下半组 · Shift+左键 在物品栏与快捷栏之间移动',
      }),
    );

    this.#status = createEl('p', {
      className: `${ROOT_CLASS}__status`,
      testId: 'inventory-status',
    });

    this.#usage = createEl('span', {
      className: `${ROOT_CLASS}__usage`,
      testId: 'inventory-usage',
    });

    this.#body = createEl('div', { className: `${ROOT_CLASS}__body` });
    this.#body.append(
      this.#buildSection('物品栏', this.#usage, 'inventory-grid', BACKPACK_SLOTS, HOTBAR_SLOTS),
      this.#buildSection('快捷栏', undefined, 'inventory-hotbar', HOTBAR_SLOTS, 0),
    );

    this.#tooltip = createEl('div', {
      className: `${ROOT_CLASS}__tooltip`,
      testId: 'inventory-tooltip',
    });
    this.#tooltip.hidden = true;

    this.card.append(header, this.#status, this.#body, this.#tooltip);

    // I. 事件委托：36 个槽位共用一组监听器。
    // 1. 槽位内容会被频繁重建，逐个挂监听会在重建时丢失；委托给不重建的容器就没有
    //    这个问题，也让 `dispose()` 只需要丢弃整棵子树。
    this.#body.addEventListener('click', this.#onClick);
    this.#body.addEventListener('contextmenu', this.#onContextMenu);
    this.#body.addEventListener('mouseover', this.#onMouseOver);
    this.#body.addEventListener('mouseout', this.#onMouseOut);
    this.#body.addEventListener('keydown', this.#onKeyDown);

    this.#renderStatus();
    this.#renderUsage();
  }

  /** 已拾取槽位；`null` 表示手上没有东西。 */
  public get pickedIndex(): number | null {
    return this.#picked;
  }

  /**
   * 用最新快照刷新 36 个槽位。
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

    // 外部逻辑可能已经把拾取格的物品搬走（例如快捷栏被键盘切换消耗）。
    // 此时必须取消拾取，否则界面会显示"手上拿着一个已经不存在的物品"。
    if (this.#picked !== null && (this.#stacks[this.#picked] ?? null) === null) {
      this.#setPicked(null);
    }

    this.#selected = snapshot.selected;
    this.#renderSelection();
    this.#renderUsage();
    this.#renderStatus();
  }

  /** 移除子树并释放槽位引用。 */
  public override dispose(): void {
    this.#slots.length = 0;
    this.#stacks.length = 0;
    this.#picked = null;
    super.dispose();
  }

  #buildCloseButton(): HTMLButtonElement {
    const close = createButton('✕', {
      className: 'modal-screen__close',
      testId: 'inventory-close',
    });
    close.setAttribute('aria-label', '关闭背包');
    close.addEventListener('click', () => {
      this.hide();
    });
    return close;
  }

  /** 一个区块：标题 + 计数 + 网格。 */
  #buildSection(
    title: string,
    badge: HTMLElement | undefined,
    testId: string,
    count: number,
    firstIndex: number,
  ): HTMLElement {
    const section = createEl('section', { className: `${ROOT_CLASS}__section` });
    const label = createEl('h3', { className: `${ROOT_CLASS}__label`, text: title });
    if (badge !== undefined) {
      label.append(badge);
    }

    const grid = createEl('div', { className: `${ROOT_CLASS}__grid`, testId });
    for (let offset = 0; offset < count; offset += 1) {
      const index = firstIndex + offset;
      const slot = createEl('div', {
        className: 'slot slot--inventory',
        testId: 'inventory-slot',
      });
      slot.dataset['index'] = String(index);
      slot.dataset['empty'] = 'true';
      slot.tabIndex = 0;
      // 槽位是按钮语义：可用键盘聚焦并用回车/空格移动物品。
      slot.setAttribute('role', 'button');
      slot.setAttribute('aria-label', '空格子');

      const icon = createEl('div', { className: ITEM_ICON_CLASS });
      icon.hidden = true;
      const count_ = createEl('span', { className: 'slot-count' });
      slot.append(icon, count_);
      grid.append(slot);

      this.#slots[index] = { root: slot, icon, count: count_, iconItem: null };
      this.#stacks[index] = null;
    }

    section.append(label, grid);
    return section;
  }

  /** 左键：拾取 / 放下。 */
  #onClick = (event: MouseEvent): void => {
    const index = this.#indexFromEvent(event);
    if (index === null) {
      return;
    }
    this.#handlePrimary(index, event.shiftKey);
  };

  /** 右键：放下半组。 */
  #onContextMenu = (event: MouseEvent): void => {
    const index = this.#indexFromEvent(event);
    if (index === null) {
      return;
    }
    // 屏蔽系统右键菜单，否则玩家每次分堆都会弹出浏览器菜单。
    event.preventDefault();
    this.#handleSecondary(index);
  };

  /** 键盘等价操作，保证背包在纯键盘下可用。 */
  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    const index = this.#indexFromEvent(event);
    if (index === null) {
      return;
    }
    event.preventDefault();
    this.#handlePrimary(index, event.shiftKey);
  };

  #onMouseOver = (event: MouseEvent): void => {
    const index = this.#indexFromEvent(event);
    const slot = this.#slotElementFromEvent(event);
    if (index === null || slot === null) {
      this.#tooltip.hidden = true;
      return;
    }
    this.#showTooltip(index, slot);
  };

  #onMouseOut = (event: MouseEvent): void => {
    const related = event.relatedTarget;
    // 在同一行内从图标移到数量文本时也会触发 mouseout，此时不应隐藏提示。
    if (related instanceof HTMLElement && related.closest(SLOT_SELECTOR) !== null) {
      return;
    }
    this.#tooltip.hidden = true;
  };

  #handlePrimary(index: number, quick: boolean): void {
    if (quick) {
      if ((this.#stacks[index] ?? null) === null) {
        return;
      }
      this.#setPicked(null);
      this.#onQuickMove(index);
      return;
    }

    const picked = this.#picked;
    if (picked === null) {
      if ((this.#stacks[index] ?? null) === null) {
        // 拾取空格子没有意义：不改变状态，也不回调。
        return;
      }
      this.#setPicked(index);
      return;
    }
    if (picked === index) {
      this.#setPicked(null);
      return;
    }

    // 先清空拾取状态再回调：调用方通常会同步 `update()`，这样重绘时已经不再有
    // "已拾取"高亮，不会出现把同一组物品放两次的错觉。
    this.#setPicked(null);
    this.#onMove(picked, index);
  }

  #handleSecondary(index: number): void {
    const picked = this.#picked;
    if (picked === null) {
      if ((this.#stacks[index] ?? null) === null) {
        return;
      }
      this.#setPicked(index);
      return;
    }
    if (picked === index) {
      this.#setPicked(null);
      return;
    }
    this.#setPicked(null);
    this.#onSplit(picked, index);
  }

  #setPicked(index: number | null): void {
    if (this.#picked !== null) {
      this.#slots[this.#picked]?.root.classList.remove('slot--picked');
    }
    this.#picked = index;
    if (index !== null) {
      this.#slots[index]?.root.classList.add('slot--picked');
    }
    this.#renderStatus();
  }

  /** 快捷栏当前选中格的描边。 */
  #renderSelection(): void {
    for (let index = 0; index < HOTBAR_SLOTS; index += 1) {
      this.#slots[index]?.root.classList.toggle('slot--selected', index === this.#selected);
    }
  }

  /** 已用格数。 */
  #renderUsage(): void {
    let used = 0;
    for (let index = HOTBAR_SLOTS; index < SLOT_COUNT; index += 1) {
      if ((this.#stacks[index] ?? null) !== null) {
        used += 1;
      }
    }
    this.#usage.textContent = `${used}/${BACKPACK_SLOTS}`;
  }

  /** 顶部状态行：说明当前手势或下一步操作。 */
  #renderStatus(): void {
    const picked = this.#picked;
    const stack = picked === null ? null : (this.#stacks[picked] ?? null);
    if (picked === null || stack === null) {
      this.#status.textContent = '点击格子拾取整组；Shift+左键 可在物品栏与快捷栏之间快速移动。';
      return;
    }
    const visual = visualFor(stack.item);
    this.#status.textContent = `已拾取 ${visual.displayName} ×${stack.count} —— 点击目标格放下，右键放下半组。`;
  }

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
      slot.root.setAttribute('aria-label', '空格子');
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
    slot.root.setAttribute(
      'aria-label',
      `${visual.displayName} ×${stack.count}${index < HOTBAR_SLOTS ? '（快捷栏）' : ''}`,
    );

    slot.icon.hidden = false;
    if (slot.iconItem !== stack.item) {
      slot.iconItem = stack.item;
      const replacement = createItemIcon(stack.item);
      slot.icon.replaceWith(replacement);
      slot.icon = replacement;
    }
    slot.count.textContent = stack.count > 1 ? String(stack.count) : '';
  }

  /** 悬停提示：贴着槽位右侧显示，位置相对卡片计算。 */
  #showTooltip(index: number, slot: HTMLElement): void {
    const stack = this.#stacks[index] ?? null;
    if (stack === null) {
      this.#tooltip.hidden = true;
      return;
    }

    const visual = visualFor(stack.item);
    this.#tooltip.replaceChildren(
      createEl('span', {
        className: `${ROOT_CLASS}__tooltip-name`,
        text: visual.displayName,
      }),
      createEl('span', {
        className: `${ROOT_CLASS}__tooltip-count`,
        text: `×${stack.count}`,
      }),
      createEl('span', {
        className: `${ROOT_CLASS}__tooltip-hint`,
        text: index < HOTBAR_SLOTS ? '快捷栏物品' : '物品栏物品',
      }),
    );

    // I. 先定位、再兜底翻转。
    // 1. 提示层在卡片内部绝对定位，而卡片是 `overflow: auto` 的：贴右侧的槽位会
    //    把提示推进裁剪区，因此测出尺寸后按需翻到槽位左侧 / 上方。
    // 2. jsdom 里 offsetWidth 恒为 0，两个翻转分支都不会触发，位置退化成相对卡片
    //    的偏移量，不影响结构断言。
    const cardRect = this.card.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    const gap = 10;

    let left = slotRect.right - cardRect.left + gap;
    let top = slotRect.top - cardRect.top;

    const tooltipWidth = this.#tooltip.offsetWidth;
    const tooltipHeight = this.#tooltip.offsetHeight;
    if (tooltipWidth > 0 && left + tooltipWidth > cardRect.width) {
      left = Math.max(4, slotRect.left - cardRect.left - tooltipWidth - gap);
    }
    if (tooltipHeight > 0 && top + tooltipHeight > cardRect.height) {
      top = Math.max(4, slotRect.bottom - cardRect.top - tooltipHeight - gap);
    }

    this.#tooltip.style.left = `${Math.round(left)}px`;
    this.#tooltip.style.top = `${Math.round(top)}px`;
    setVisible(this.#tooltip, true);
  }

  #indexFromEvent(event: Event): number | null {
    const slot = this.#slotElementFromEvent(event);
    if (slot === null) {
      return null;
    }
    const raw = slot.dataset['index'];
    if (raw === undefined) {
      return null;
    }
    const index = Number(raw);
    return Number.isInteger(index) && index >= 0 && index < SLOT_COUNT ? index : null;
  }

  #slotElementFromEvent(event: Event): HTMLElement | null {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return null;
    }
    return target.closest<HTMLElement>(SLOT_SELECTOR);
  }
}

/** 内容相同则视为同一栈，用于跳过无意义的重绘。 */
function isSameStack(a: ItemStack | null, b: ItemStack | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.item === b.item && a.count === b.count;
}
