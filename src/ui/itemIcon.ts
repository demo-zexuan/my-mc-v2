/**
 * 物品图标：把 `ItemVisual` 画成一个纯 CSS 的方块色块。
 *
 * I. 为什么不用贴图
 *
 * 1. 图标只出现在快捷栏与背包里，尺寸 30px 上下；真实贴图在这个尺寸下既看不出
 *    细节，还要把图集加载、纹理尺寸这类渲染层知识带进 UI。
 * 2. 主色 + 点缀色的两层渐变已经足够让 22 种方块彼此可辨，而且颜色直接来自
 *    `itemVisuals.ts`，与场景中的方块同源。
 *
 * II. 为什么通过 CSS 自定义属性传色
 *
 * 颜色随物品变化，但底纹结构（噪点、木纹、矿点）由类名决定。把颜色写进
 * `--item-color` / `--item-accent`，底纹规则就只需写一条，而不是给每种方块
 * 生成一套选择器。
 *
 * @module ui/itemIcon
 */

import { createEl } from './dom';
import { toCssColor, visualFor } from './itemVisuals';

/** 图标的类名，Hotbar 与 InventoryScreen 共用。 */
export const ITEM_ICON_CLASS = 'item-icon';

/**
 * 把一个元素改造成指定物品的图标。
 *
 * 复用同一个元素（而不是每次新建）可以让快捷栏在拾取/丢弃物品时不必重建
 * DOM，颜色变化由 CSS 自定义属性直接过渡。
 *
 * @param icon - 目标元素，通常是 `createItemIcon` 的产物。
 * @param item - 物品（方块）id。
 */
export function applyItemVisual(icon: HTMLElement, item: number): void {
  const visual = visualFor(item);
  icon.className = `${ITEM_ICON_CLASS} ${ITEM_ICON_CLASS}--${visual.pattern}`;
  icon.style.setProperty('--item-color', toCssColor(visual.baseColor));
  icon.style.setProperty('--item-accent', toCssColor(visual.accentColor));
  icon.dataset['item'] = String(item);
  icon.dataset['itemName'] = visual.displayName;
  // 图标本身是装饰，语义由所在槽位的 `aria-label` / `title` 提供；
  // 这里只保证它在无障碍树里可被读出名字。
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', visual.displayName);
}

/**
 * 创建一个物品图标元素。
 *
 * @param item - 物品（方块）id。
 * @returns 已完成着色与底纹设置的 `div`。
 */
export function createItemIcon(item: number): HTMLElement {
  const icon = createEl('div', { className: ITEM_ICON_CLASS });
  applyItemVisual(icon, item);
  return icon;
}
