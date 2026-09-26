/**
 * 方块 → 物品的展示信息。
 *
 * I. 为什么需要这一层
 *
 * 同一个方块 id 在三个地方被"翻译"成玩家可见的东西：Hotbar 的图标颜色、
 * 掉落物的实例颜色、粒子爆发的颜色。如果三处各自去读 `texturesOf(id).side.baseColor`，
 * 一旦日后想给矿石加"高光描边"或给工具物品换配色，就要改三个地方并保证它们不漂移。
 * 这里做成唯一真源：世界层只描述方块长什么样，物品层决定"作为物品"怎么被展示。
 *
 * II. 颜色的来源
 *
 * 取侧面贴图的 `TileStyle.baseColor`，而不是定义里的随意常量：
 * 侧面是玩家在快捷栏里最常看到的那一面（草方块的绿色顶面在物品图标里会误导），
 * 因此图标颜色与场景中该方块的外观天然一致。
 *
 * III. 为什么要有缓存
 *
 * HUD 每帧都可能为 36 个槽位取一次名字与颜色。返回同一个不可变对象既避免了
 * 每帧分配，又让调用方可以安全地长期持有引用。缓存内容完全由静态的方块表推导，
 * 不涉及可变游戏状态，因此不存在"测试之间互相污染"的风险（`clearItemInfoCache`
 * 只是给需要显式隔离的用例准备的）。
 *
 * @module inventory/ItemRegistry
 */

import type { BlockDefinition } from '@/world/blocks';

import {
  BLOCK_TYPE_COUNT,
  definitionOf,
  dropOf,
  isLiquid,
  texturesOf,
  type BlockId,
} from '@/world/BlockRegistry';

/** 物品类别；当前只有方块，工具/食物等未来在这里扩展。 */
export type ItemKind = 'block' | 'material';

/** 物品的展示信息（不可变）。 */
export interface ItemInfo {
  /** 物品 id；与 `ItemStack.item` 同一命名空间。 */
  readonly id: number;
  /** 物品类别。 */
  readonly kind: ItemKind;
  /** 机器名（存档/测试用，永不面向玩家）。 */
  readonly name: string;
  /** 面向玩家的中文名。 */
  readonly displayName: string;
  /** 图标/实例颜色，`0xRRGGBB`。 */
  readonly color: number;
  /** 图标/实例颜色的 CSS 形式，`#rrggbb`。 */
  readonly colorHex: string;
}

/** 未知 id 的兜底信息：洋红色是经典的"缺失贴图"提示色。 */
const UNKNOWN_ITEM: ItemInfo = {
  id: -1,
  kind: 'material',
  name: 'unknown',
  displayName: '未知物品',
  color: 0xff00ff,
  colorHex: '#ff00ff',
};

const CACHE = new Map<number, ItemInfo>();

/** 清空缓存；仅供需要隔离状态的测试使用。 */
export function clearItemInfoCache(): void {
  CACHE.clear();
}

/**
 * 把 `0xRRGGBB` 转成 CSS 颜色串。
 *
 * @param color - 24 位整数颜色。
 */
export function colorToHex(color: number): string {
  const clamped = Math.max(0, Math.min(0xffffff, Math.trunc(color)));
  return `#${clamped.toString(16).padStart(6, '0')}`;
}

/** id 是否落在方块表范围内。 */
function isKnownBlockId(id: BlockId): boolean {
  return Number.isInteger(id) && id >= 0 && id < BLOCK_TYPE_COUNT;
}

/**
 * 取方块作为物品的展示信息。
 *
 * @param id - 方块 id。
 * @returns 展示信息；id 非法时返回 `null`（调用方据此回退到兜底显示）。
 */
export function blockItemInfo(id: BlockId): ItemInfo | null {
  const cached = CACHE.get(id);
  if (cached !== undefined) {
    return cached;
  }
  if (!isKnownBlockId(id)) {
    return null;
  }

  let definition: BlockDefinition;
  try {
    definition = definitionOf(id);
  } catch {
    // 方块表在模块加载时已校验过下标，走到这里说明调用方传入了越界 id。
    return null;
  }

  const info: ItemInfo = {
    id,
    kind: 'block',
    name: definition.name,
    displayName: definition.displayName,
    color: texturesOf(id).side.baseColor,
    colorHex: colorToHex(texturesOf(id).side.baseColor),
  };
  CACHE.set(id, info);
  return info;
}

/**
 * 取展示信息，永不返回 `null`。
 *
 * 设计取舍：HUD 与渲染层不应该为了一个异常的 id 就中断整帧渲染，
 * 因此这里回退到"未知物品"而不是抛错。真正的非法 id 会在世界层被拦截。
 *
 * @param id - 物品 id。
 */
export function itemInfoFor(id: BlockId): ItemInfo {
  return blockItemInfo(id) ?? { ...UNKNOWN_ITEM, id };
}

/**
 * 方块被破坏后掉落的物品。
 *
 * @param block - 被破坏的方块 id。
 * @returns 掉落物 id；不产出掉落物（玻璃、冰、水、基岩）时返回 `null`。
 */
export function itemForBlock(block: BlockId): BlockId | null {
  return dropOf(block);
}

/**
 * 方块能否作为物品被放置回世界。
 *
 * I. 拒绝的两类
 *
 * 1. 空气：放下空气等于没放，而且会让放置的消耗逻辑出现"扣了物品但世界没变"。
 * 2. 液体（水）：目前没有流体扩散模拟，允许放置会在世界里留下一格悬空的静止水，
 *    与地形生成的水体行为不一致。等有了流体模拟再放开。
 *
 * @param id - 候选方块 id。
 */
export function isPlaceableBlock(id: BlockId): boolean {
  if (!isKnownBlockId(id) || id === 0) {
    return false;
  }
  if (isLiquid(id)) {
    return false;
  }
  return blockItemInfo(id) !== null;
}

/** 方块作为物品的颜色，供粒子与掉落物渲染使用。 */
export function blockColorOf(id: BlockId): number {
  return itemInfoFor(id).color;
}
