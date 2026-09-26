/**
 * 物品图标的 presentation 数据表。
 *
 * I. 为什么在 UI 层复制一份调色板
 *
 * 1. 架构约束禁止 `src/ui/**` 依赖 `src/world/**`：UI 只接受"快照数据 + 回调"，
 *    这样组件才能在 jsdom 里脱离引擎被测试。
 * 2. 因此 `visualFor(id)` 不能去问 `BlockRegistry`。这里保存的是**展示数据**
 *    （玩家看到的名字与颜色），与世界的物理定义（硬度、是否透明）不是同一份
 *    契约；两者的数值刻意与 `world/blocks.ts` 的 TILE 调色板保持一致，避免
 *    快捷栏图标和地面上的方块看起来像两种材质。
 *
 * II. 未知 id 的处理
 *
 * 存档可能来自更新过的版本。遇到表里没有的 id 时不抛异常，而是回退到一个中性
 * 的"未知方块"外观：UI 不该因为一条脏数据而整屏崩掉。
 *
 * @module ui/itemVisuals
 */

/** 图标底纹族；与 `world/blocks.ts` 的 `TilePattern` 同名，便于人工核对。 */
export type ItemPattern =
  'solid' | 'noise' | 'grass' | 'wood' | 'leaves' | 'liquid' | 'glass' | 'ore' | 'crystal';

/** 一个物品的展示外观。 */
export interface ItemVisual {
  /** 玩家可见名称。 */
  readonly displayName: string;
  /** 主色，`0xRRGGBB`。 */
  readonly baseColor: number;
  /** 点缀色，用于程序化底纹。 */
  readonly accentColor: number;
  /** 底纹族。 */
  readonly pattern: ItemPattern;
}

/** 未注册 id 的回退外观。 */
const UNKNOWN_VISUAL: ItemVisual = {
  displayName: '未知方块',
  baseColor: 0x4a4f57,
  accentColor: 0x6c7480,
  pattern: 'noise',
};

/**
 * 按 id 排列的展示表（索引即 id）。
 *
 * 改动这里时请同步 `src/world/blocks.ts`，否则图标与场景中的方块会不同色。
 */
const ITEM_VISUALS: readonly ItemVisual[] = [
  { displayName: '空气', baseColor: 0x8a8a8f, accentColor: 0x9c9ca2, pattern: 'solid' },
  { displayName: '石头', baseColor: 0x8a8a8f, accentColor: 0x9c9ca2, pattern: 'noise' },
  { displayName: '泥土', baseColor: 0x7a5a3a, accentColor: 0x8d6a45, pattern: 'noise' },
  { displayName: '草方块', baseColor: 0x6cae4a, accentColor: 0x86c95c, pattern: 'grass' },
  { displayName: '沙子', baseColor: 0xdcd0a0, accentColor: 0xeee3b8, pattern: 'noise' },
  { displayName: '水', baseColor: 0x2f6fb5, accentColor: 0x4d9ad8, pattern: 'liquid' },
  { displayName: '木头', baseColor: 0x6b4f2a, accentColor: 0x8a6b3a, pattern: 'wood' },
  { displayName: '树叶', baseColor: 0x3f7a30, accentColor: 0x59a044, pattern: 'leaves' },
  { displayName: '玻璃', baseColor: 0xcfe6f2, accentColor: 0xffffff, pattern: 'glass' },
  { displayName: '木板', baseColor: 0xa9834f, accentColor: 0x8c6a3d, pattern: 'wood' },
  { displayName: '圆石', baseColor: 0x6f6f74, accentColor: 0x929297, pattern: 'noise' },
  { displayName: '基岩', baseColor: 0x3a3a40, accentColor: 0x53535c, pattern: 'noise' },
  { displayName: '砾石', baseColor: 0x8b8579, accentColor: 0x6a655c, pattern: 'noise' },
  { displayName: '砂岩', baseColor: 0xd6c894, accentColor: 0xc4b482, pattern: 'noise' },
  { displayName: '雪块', baseColor: 0xf2f6fa, accentColor: 0xdfe8f2, pattern: 'noise' },
  { displayName: '冰', baseColor: 0x9fd0ef, accentColor: 0xd6ecf8, pattern: 'crystal' },
  { displayName: '煤矿石', baseColor: 0x8a8a8f, accentColor: 0x22222a, pattern: 'ore' },
  { displayName: '铁矿石', baseColor: 0x8a8a8f, accentColor: 0xb07a52, pattern: 'ore' },
  { displayName: '金矿石', baseColor: 0x8a8a8f, accentColor: 0xe0b73c, pattern: 'ore' },
  { displayName: '钻石矿石', baseColor: 0x8a8a8f, accentColor: 0x4fd8de, pattern: 'ore' },
  { displayName: '萤石灯', baseColor: 0xffd98a, accentColor: 0xfff0c4, pattern: 'crystal' },
  { displayName: '砖块', baseColor: 0x9c5744, accentColor: 0xc7b5a8, pattern: 'noise' },
];

/**
 * 查询物品的展示外观。
 *
 * @param item - 物品（方块）id；负数、越界或非整数都会得到回退外观。
 * @returns 展示数据，永不为 null。
 */
export function visualFor(item: number): ItemVisual {
  if (!Number.isInteger(item) || item < 0) {
    return UNKNOWN_VISUAL;
  }
  return ITEM_VISUALS[item] ?? UNKNOWN_VISUAL;
}

/**
 * 把 `0xRRGGBB` 转成 CSS 颜色字符串。
 *
 * 掩码到 24 位并补零，避免 `0x0000ff` 被格式化成 `#ff` 这种非法值。
 *
 * @param value - 24 位颜色数值。
 * @returns `#rrggbb` 小写字符串。
 */
export function toCssColor(value: number): string {
  const masked = value & 0xffffff;
  return `#${masked.toString(16).padStart(6, '0')}`;
}
