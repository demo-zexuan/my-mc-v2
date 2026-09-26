/**
 * UI 单元测试共用的小工具。
 *
 * 所有使用它的测试文件都在文件头声明了 `// @vitest-environment jsdom`；
 * 本文件自己不声明环境，因为它只在别的测试文件里被 import，不会单独执行。
 *
 * @module tests/unit/ui/helpers
 */

import { INVENTORY_SLOTS, type InventorySnapshot, type ItemStack } from '@/inventory/types';

/** 创建一个挂在 body 上的宿主元素，模拟 `#app`。 */
export function createRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  return root;
}

/** 构造一个物品栈；id 走 `BlockId` 的字面量联合，写错编号编译期就会报错。 */
export function stack(item: ItemStack['item'], count: number): ItemStack {
  return { item, count };
}

/**
 * 用"槽位号 → 物品栈"的稀疏写法构造快照。
 *
 * @param entries - 只列出非空格子，其余自动填 `null`。
 * @param selected - 选中的快捷栏格，默认 0。
 */
export function snapshotOf(
  entries: Readonly<Record<number, ItemStack>>,
  selected = 0,
): InventorySnapshot {
  const slots: (ItemStack | null)[] = new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null);
  for (const [key, value] of Object.entries(entries)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < INVENTORY_SLOTS) {
      slots[index] = value;
    }
  }
  return { slots, selected };
}
