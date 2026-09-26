/**
 * 玩家背包的具体实现。
 *
 * I. 为什么用一个纯数组而不是 Map/链表
 *
 * 1. 背包的槽位是**位置语义**的：第 0 格就是快捷栏第一格，UI 直接按照下标绘制。
 *    换成 Map 之后每次渲染都要排序，而且"第 N 格为空"这一状态无法表达。
 * 2. 槽位数量（36）固定且极小，按下标访问是 O(1) 且对 JIT 友好。
 *
 * II. 为什么 ItemStack 在写入时会被规范化
 *
 * `ItemStack` 是只读值对象，但它的 count 可能来自存档、UI 或测试桩，
 * 存在 0、负数、小数、超过 MAX_STACK_SIZE 甚至 NaN 的可能。
 * 与其让这些脏数据在后续的合并/拆分里扩散，不如在**唯一的写入口**统一收敛：
 * count <= 0 视为空槽，count 取整并钳制到 `MAX_STACK_SIZE`。
 * 这样 `getSlot` / `snapshot` 的返回值永远满足 `1 .. MAX_STACK_SIZE` 的契约。
 *
 * III. 为什么 select 可以发事件
 *
 * 接口冻结时没有规定选中变化的广播方式，但 Hotbar（UI 层）需要知道高亮格变了。
 * 与其让 app 装配层在每次滚轮/数字键后手动补一次 emit（漏掉一处就出现 UI 不同步），
 * 不如让背包在**实际发生改变**时广播一次。EventBus 是可选依赖：
 * 不传 bus 时背包退化为纯数据结构，单元测试无需任何事件基础设施。
 *
 * @module inventory/Inventory
 */

import type { EventBus } from '@/engine/events/EventBus';
import type { BlockId } from '@/world/BlockRegistry';

import {
  HOTBAR_SLOTS,
  INVENTORY_SLOTS,
  MAX_STACK_SIZE,
  type Inventory,
  type InventorySnapshot,
  type ItemStack,
} from './types';

/** 构造参数。 */
export interface InventoryOptions {
  /** 事件总线；不传则不发任何事件。 */
  readonly bus?: EventBus;
  /** 槽位总数；默认 `INVENTORY_SLOTS`，测试里可以缩小。 */
  readonly size?: number;
}

/**
 * 把一个可能非法的栈收敛为合法值。
 *
 * @param stack - 待规范化的栈。
 * @returns 合法栈；数量非正或非有限时返回 `null`（等价于空槽）。
 */
function normalizeStack(stack: ItemStack | null): ItemStack | null {
  if (stack === null) {
    return null;
  }
  const count = Math.floor(stack.count);
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }
  return { item: stack.item, count: Math.min(count, MAX_STACK_SIZE) };
}

export class PlayerInventory implements Inventory {
  public readonly size: number;

  readonly #slots: (ItemStack | null)[];
  readonly #bus: EventBus | null;
  /** 快捷栏长度；当 `size` 小于 `HOTBAR_SLOTS` 时以 `size` 为准，避免越界。 */
  readonly #hotbarLength: number;
  #selected = 0;

  public constructor(options: InventoryOptions = {}) {
    const requested = options.size ?? INVENTORY_SLOTS;
    const size = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : INVENTORY_SLOTS;
    this.size = size;
    this.#hotbarLength = Math.min(size, HOTBAR_SLOTS);
    this.#slots = new Array<ItemStack | null>(size).fill(null);
    this.#bus = options.bus ?? null;
  }

  /** 当前选中的快捷栏下标。 */
  public get selectedIndex(): number {
    return this.#selected;
  }

  /** I. 读取。 */
  public getSlot(index: number): ItemStack | null {
    if (!this.#isIndex(index)) {
      return null;
    }
    return this.#slots[index] ?? null;
  }

  public peek(index: number): ItemStack | null {
    return this.getSlot(index);
  }

  public selectedStack(): ItemStack | null {
    return this.#slots[this.#selected] ?? null;
  }

  /** II. 写入。 */
  public setSlot(index: number, stack: ItemStack | null): void {
    if (!this.#isIndex(index)) {
      return;
    }
    this.#slots[index] = normalizeStack(stack);
  }

  /**
   * 添加物品。
   *
   * I. 两趟扫描的必要性
   *
   * 1. 第一趟只填**未满的同类堆**，这样已有的 "37 个石头" 会先补到 64，
   *    而不是在旁边新开一格——否则玩家长时间采集后背包会被大量 1 格堆填满。
   * 2. 第二趟才占用空槽。两趟分开写比单趟 "遇到空槽就用" 更容易验证，
   *    也让 `add` 的结果与槽位顺序无关地可预测。
   *
   * @param item - 物品 id。
   * @param count - 添加数量；非正或非有限值视为 0。
   * @returns 未能放入的数量，调用方据此决定是否把剩余量留在地上。
   */
  public add(item: BlockId, count: number): number {
    const requested = Math.floor(count);
    if (!Number.isFinite(requested) || requested <= 0) {
      return 0;
    }

    let remaining = requested;

    // 1. 先补未满的同类堆。
    for (let i = 0; i < this.#slots.length && remaining > 0; i += 1) {
      const stack = this.#slots[i];
      if (stack === undefined || stack === null || stack.item !== item) {
        continue;
      }
      const space = MAX_STACK_SIZE - stack.count;
      if (space <= 0) {
        continue;
      }
      const moved = Math.min(space, remaining);
      this.#slots[i] = { item, count: stack.count + moved };
      remaining -= moved;
    }

    // 2. 再占用空槽。
    for (let i = 0; i < this.#slots.length && remaining > 0; i += 1) {
      if (this.#slots[i] !== null) {
        continue;
      }
      const moved = Math.min(MAX_STACK_SIZE, remaining);
      this.#slots[i] = { item, count: moved };
      remaining -= moved;
    }

    return remaining;
  }

  /**
   * 从选中槽位取出物品。
   *
   * @param count - 取出数量，默认 1；非正或非有限值视为 0（不取任何东西）。
   * @returns 实际取出的栈；槽位为空或数量非法时返回 `null`。
   */
  public consumeSelected(count = 1): ItemStack | null {
    const stack = this.#slots[this.#selected] ?? null;
    if (stack === null) {
      return null;
    }
    const take = Math.floor(count);
    if (!Number.isFinite(take) || take <= 0) {
      return null;
    }

    if (take >= stack.count) {
      this.#slots[this.#selected] = null;
      return stack;
    }
    this.#slots[this.#selected] = { item: stack.item, count: stack.count - take };
    return { item: stack.item, count: take };
  }

  /**
   * 选中快捷栏槽位。
   *
   * I. 为什么用取模而不是抛错
   *
   * 滚轮每滚一格传入 +1/-1，数字键 1-9 传入 0-8，两者都可能越界（滚轮会一直累加）。
   * 把越界值折返到合法区间，可以让调用方完全不关心边界，也不会因为一次越界
   * 就让整个交互静默失效。
   *
   * @param index - 任意整数。
   */
  public select(index: number): void {
    if (!Number.isFinite(index)) {
      return;
    }
    const wrapped =
      ((Math.trunc(index) % this.#hotbarLength) + this.#hotbarLength) % this.#hotbarLength;
    if (wrapped === this.#selected) {
      return;
    }
    this.#selected = wrapped;
    this.#bus?.emit('hotbar:selection-changed', { index: wrapped });
  }

  /**
   * 在两个槽位之间移动物品。
   *
   * I. 三种情形的处理
   *
   * 1. 目标为空：直接搬运。
   * 2. 目标同类：合并，只填到 `MAX_STACK_SIZE`，装不下的留在原格。
   * 3. 目标异类：交换。UI 的拖拽语义期望如此——玩家把泥土拖到石头上，
   *    希望两者互换，而不是让石头凭空消失。
   */
  public moveSlot(from: number, to: number): void {
    if (!this.#isIndex(from) || !this.#isIndex(to) || from === to) {
      return;
    }
    const source = this.#slots[from] ?? null;
    if (source === null) {
      return;
    }
    const target = this.#slots[to] ?? null;

    if (target === null) {
      this.#slots[to] = source;
      this.#slots[from] = null;
      return;
    }

    if (target.item === source.item) {
      const space = MAX_STACK_SIZE - target.count;
      if (space <= 0) {
        return;
      }
      const moved = Math.min(space, source.count);
      this.#slots[to] = { item: target.item, count: target.count + moved };
      const left = source.count - moved;
      this.#slots[from] = left > 0 ? { item: source.item, count: left } : null;
      return;
    }

    this.#slots[to] = source;
    this.#slots[from] = target;
  }

  /**
   * 对半拆分。
   *
   * I. 奇数与 1 个的情况
   *
   * 1. 奇数时留在原格的是**较大的一半**：玩家拖动时更希望原格保留主堆。
   * 2. 只有 1 个物品时 `floor(1 / 2) === 0`，什么都不会发生——这符合直觉，
   *    也给调用方一个"拆分失败但无副作用"的安静结果。
   * 3. 目标格必须为空；否则宁可不动，也不要覆盖玩家已有的物品。
   */
  public splitSlot(from: number, to: number): void {
    if (!this.#isIndex(from) || !this.#isIndex(to) || from === to) {
      return;
    }
    const source = this.#slots[from] ?? null;
    if (source === null || this.#slots[to] !== null) {
      return;
    }
    const moved = Math.floor(source.count / 2);
    if (moved <= 0) {
      return;
    }
    this.#slots[to] = { item: source.item, count: moved };
    this.#slots[from] = { item: source.item, count: source.count - moved };
  }

  /**
   * 丢弃整格。
   *
   * @returns 被丢弃的栈，调用方通常把它变成地上的掉落物。
   */
  public dropSlot(index: number): ItemStack | null {
    if (!this.#isIndex(index)) {
      return null;
    }
    const stack = this.#slots[index] ?? null;
    if (stack === null) {
      return null;
    }
    this.#slots[index] = null;
    return stack;
  }

  /** III. 查询。 */
  public findItem(item: BlockId): number {
    for (let i = 0; i < this.#slots.length; i += 1) {
      if (this.#slots[i]?.item === item) {
        return i;
      }
    }
    return -1;
  }

  public countItem(item: BlockId): number {
    let total = 0;
    for (const stack of this.#slots) {
      if (stack !== null && stack.item === item) {
        total += stack.count;
      }
    }
    return total;
  }

  public isEmpty(): boolean {
    return this.#slots.every((stack) => stack === null);
  }

  /** IV. 快照与恢复。 */
  public snapshot(): InventorySnapshot {
    // 只复制槽位数组本身：ItemStack 是只读值，共享引用不会产生别名写入问题。
    return { slots: [...this.#slots], selected: this.#selected };
  }

  /**
   * 用快照整体替换背包。
   *
   * I. 为什么允许长度不一致
   *
   * 快照可能来自旧版本存档（槽位更少或更多）。按 `min(本背包长度, 快照长度)`
   * 复制并补空，比抛错更宽容：玩家不会因为一次版本升级就丢档，
   * 而多出来的格子自然是空的。
   */
  public restore(snapshot: InventorySnapshot): void {
    for (let i = 0; i < this.#slots.length; i += 1) {
      this.#slots[i] = normalizeStack(snapshot.slots[i] ?? null);
    }
    this.#selected = this.#wrapSelection(snapshot.selected);
  }

  public clear(): void {
    this.#slots.fill(null);
  }

  /** 下标必须是 0..size-1 的整数；浮点、NaN、越界一律拒绝。 */
  #isIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.#slots.length;
  }

  #wrapSelection(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    const truncated = Math.trunc(value);
    if (truncated >= 0 && truncated < this.#hotbarLength) {
      return truncated;
    }
    return ((truncated % this.#hotbarLength) + this.#hotbarLength) % this.#hotbarLength;
  }
}
