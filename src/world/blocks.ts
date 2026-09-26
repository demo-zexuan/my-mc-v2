/**
 * Block type catalogue.
 *
 * I. Why blocks are data rather than classes
 *
 * 1. There are tens of thousands of block *instances* per loaded chunk and only
 *    a few dozen block *types*. Representing instances as numbers and types as
 *    a flat table removes both the allocation and the pointer chasing that a
 *    class-per-block design would introduce.
 * 2. Properties that the mesher and the collider query per block — solid,
 *    opaque, liquid — are summarised into bit flags in
 *    `BlockRegistry.BLOCK_FLAGS`, so a hot loop performs one array read and one
 *    bitwise test instead of following an object pointer.
 *
 * II. Identifier stability
 *
 * The numeric ids below are part of the save format: a chunk stores raw ids, so
 * **existing values must never be renumbered**. New blocks are appended with the
 * next free id. `BlockRegistry` validates this invariant in its unit tests.
 *
 * @module world/blocks
 */

import type { BlockId } from './BlockRegistry';

/** How a procedural texture tile should be drawn by the atlas generator. */
export type TilePattern =
  'solid' | 'noise' | 'grass' | 'wood' | 'leaves' | 'liquid' | 'glass' | 'ore' | 'crystal';

/**
 * Declarative description of one 16x16 texture tile.
 *
 * I. Why the world layer describes textures declaratively
 *
 * The definition of a block (what it is made of) belongs with the block, but the
 * rendering layer must stay the only place that knows about canvases, mipmaps
 * and Three.js. A structured descriptor satisfies both: `world/` never imports
 * Three.js, and `rendering/` can turn the descriptor into pixels however it
 * likes — including inside a worker.
 */
export interface TileStyle {
  /** Base colour as `0xRRGGBB`. */
  readonly baseColor: number;
  /** Pattern family used to derive per-pixel variation. */
  readonly pattern: TilePattern;
  /** Secondary colour for patterns that blend two tones (grass, ore, leaves). */
  readonly accentColor?: number;
  /**
   * High-frequency variation strength in `0 .. 1`. Lower values read as smooth
   * stone, higher values as gravelly dirt.
   */
  readonly speckle?: number;
  /** Emissive strength in `0 .. 1`; non-zero tiles are not darkened at night. */
  readonly emissive?: number;
}

/** Per-face tile assignment. A cube block needs at least these three. */
export interface BlockTextures {
  readonly top: TileStyle;
  readonly side: TileStyle;
  readonly bottom: TileStyle;
}

/** Immutable definition of one block type. */
export interface BlockDefinition {
  readonly id: BlockId;
  /**
   * Stable machine name. Used by the save format and by tests; never shown to
   * players and never translated.
   */
  readonly name: string;
  /** Player facing name (Chinese). */
  readonly displayName: string;
  /** Blocks movement and supports the player standing on it. */
  readonly solid: boolean;
  /**
   * Fully hides the face of the neighbour behind it. The chunk mesher emits a
   * face only when the neighbouring block is not opaque, so this flag is the
   * single most performance-relevant property in the table.
   */
  readonly opaque: boolean;
  /** Rendered in a separate pass sorted back-to-front. */
  readonly transparent: boolean;
  /** Behaves as a fluid: no collision, slower movement, rendered as water. */
  readonly liquid: boolean;
  /** Can be destroyed by the player. */
  readonly breakable: boolean;
  /** Seconds required to break by hand; scaled by tool speed later. */
  readonly hardness: number;
  /**
   * Item produced when broken. Defaults to the block's own id.
   * A block that drops nothing uses `null`.
   */
  readonly drop?: BlockId | null;
  readonly textures: BlockTextures;
  /** Amount of light removed when passing through; `0` for opaque blocks. */
  readonly lightAttenuation?: number;
}

// ---------------------------------------------------------------------------
// Texture palettes
//
// Keeping the palettes in one place is what makes the world look coherent:
// terrain reads as a single art direction instead of a bag of unrelated colours.
// ---------------------------------------------------------------------------

const TILE = {
  grassTop: { baseColor: 0x6cae4a, pattern: 'grass', accentColor: 0x86c95c, speckle: 0.35 },
  grassSide: { baseColor: 0x7a5a3a, pattern: 'grass', accentColor: 0x6cae4a, speckle: 0.3 },
  dirt: { baseColor: 0x7a5a3a, pattern: 'noise', accentColor: 0x8d6a45, speckle: 0.5 },
  stone: { baseColor: 0x8a8a8f, pattern: 'noise', accentColor: 0x9c9ca2, speckle: 0.28 },
  cobblestone: { baseColor: 0x6f6f74, pattern: 'noise', accentColor: 0x929297, speckle: 0.7 },
  gravel: { baseColor: 0x8b8579, pattern: 'noise', accentColor: 0x6a655c, speckle: 0.85 },
  sand: { baseColor: 0xdcd0a0, pattern: 'noise', accentColor: 0xeee3b8, speckle: 0.22 },
  sandstone: { baseColor: 0xd6c894, pattern: 'noise', accentColor: 0xc4b482, speckle: 0.18 },
  logSide: { baseColor: 0x6b4f2a, pattern: 'wood', accentColor: 0x8a6b3a, speckle: 0.25 },
  logTop: { baseColor: 0xa9884f, pattern: 'wood', accentColor: 0x6b4f2a, speckle: 0.3 },
  leaves: { baseColor: 0x3f7a30, pattern: 'leaves', accentColor: 0x59a044, speckle: 0.6 },
  planks: { baseColor: 0xa9834f, pattern: 'wood', accentColor: 0x8c6a3d, speckle: 0.2 },
  water: { baseColor: 0x2f6fb5, pattern: 'liquid', accentColor: 0x4d9ad8, speckle: 0.18 },
  ice: { baseColor: 0x9fd0ef, pattern: 'crystal', accentColor: 0xd6ecf8, speckle: 0.15 },
  glass: { baseColor: 0xcfe6f2, pattern: 'glass', accentColor: 0xffffff, speckle: 0.05 },
  snow: { baseColor: 0xf2f6fa, pattern: 'noise', accentColor: 0xdfe8f2, speckle: 0.12 },
  bedrock: { baseColor: 0x3a3a40, pattern: 'noise', accentColor: 0x53535c, speckle: 0.9 },
  coalOre: { baseColor: 0x8a8a8f, pattern: 'ore', accentColor: 0x22222a, speckle: 0.3 },
  ironOre: { baseColor: 0x8a8a8f, pattern: 'ore', accentColor: 0xb07a52, speckle: 0.3 },
  goldOre: { baseColor: 0x8a8a8f, pattern: 'ore', accentColor: 0xe0b73c, speckle: 0.3 },
  diamondOre: { baseColor: 0x8a8a8f, pattern: 'ore', accentColor: 0x4fd8de, speckle: 0.3 },
  lamp: {
    baseColor: 0xffd98a,
    pattern: 'crystal',
    accentColor: 0xfff0c4,
    speckle: 0.2,
    emissive: 1,
  },
  brick: { baseColor: 0x9c5744, pattern: 'noise', accentColor: 0xc7b5a8, speckle: 0.4 },
} as const satisfies Record<string, TileStyle>;

/** Convenience: a block whose six faces share one tile. */
function uniform(style: TileStyle): BlockTextures {
  return { top: style, side: style, bottom: style };
}

/** Convenience: distinct top, side and bottom tiles. */
function column(top: TileStyle, side: TileStyle, bottom: TileStyle): BlockTextures {
  return { top, side, bottom };
}

/**
 * The block catalogue.
 *
 * Ordered by id. The array index must equal `definition.id`; `BlockRegistry`
 * asserts that at module load so a mis-numbered entry fails immediately instead
 * of producing a world where stone renders as water.
 */
export const BLOCK_DEFINITIONS: readonly BlockDefinition[] = [
  {
    id: 0,
    name: 'air',
    displayName: '空气',
    solid: false,
    opaque: false,
    transparent: true,
    liquid: false,
    breakable: false,
    hardness: 0,
    drop: null,
    textures: uniform(TILE.stone),
  },
  {
    id: 1,
    name: 'stone',
    displayName: '石头',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 1.5,
    textures: uniform(TILE.stone),
  },
  {
    id: 2,
    name: 'dirt',
    displayName: '泥土',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 0.6,
    textures: uniform(TILE.dirt),
  },
  {
    id: 3,
    name: 'grass',
    displayName: '草方块',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 0.7,
    drop: 2,
    textures: column(TILE.grassTop, TILE.grassSide, TILE.dirt),
  },
  {
    id: 4,
    name: 'sand',
    displayName: '沙子',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 0.6,
    textures: uniform(TILE.sand),
  },
  {
    id: 5,
    name: 'water',
    displayName: '水',
    solid: false,
    opaque: false,
    transparent: true,
    liquid: true,
    breakable: false,
    hardness: 0,
    drop: null,
    textures: uniform(TILE.water),
    lightAttenuation: 0.35,
  },
  {
    id: 6,
    name: 'log',
    displayName: '木头',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 1.2,
    textures: column(TILE.logTop, TILE.logSide, TILE.logTop),
  },
  {
    id: 7,
    name: 'leaves',
    displayName: '树叶',
    solid: true,
    opaque: false,
    transparent: true,
    liquid: false,
    breakable: true,
    hardness: 0.25,
    textures: uniform(TILE.leaves),
    lightAttenuation: 0.15,
  },
  {
    id: 8,
    name: 'glass',
    displayName: '玻璃',
    solid: true,
    opaque: false,
    transparent: true,
    liquid: false,
    breakable: true,
    hardness: 0.4,
    drop: null,
    textures: uniform(TILE.glass),
  },
  {
    id: 9,
    name: 'planks',
    displayName: '木板',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 1.0,
    textures: uniform(TILE.planks),
  },
  {
    id: 10,
    name: 'cobblestone',
    displayName: '圆石',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 1.8,
    textures: uniform(TILE.cobblestone),
  },
  {
    id: 11,
    name: 'bedrock',
    displayName: '基岩',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: false,
    hardness: Number.POSITIVE_INFINITY,
    drop: null,
    textures: uniform(TILE.bedrock),
  },
  {
    id: 12,
    name: 'gravel',
    displayName: '砾石',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 0.7,
    textures: uniform(TILE.gravel),
  },
  {
    id: 13,
    name: 'sandstone',
    displayName: '砂岩',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 1.4,
    textures: uniform(TILE.sandstone),
  },
  {
    id: 14,
    name: 'snow',
    displayName: '雪块',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 0.4,
    textures: uniform(TILE.snow),
  },
  {
    id: 15,
    name: 'ice',
    displayName: '冰',
    solid: true,
    opaque: false,
    transparent: true,
    liquid: false,
    breakable: true,
    hardness: 0.6,
    drop: null,
    textures: uniform(TILE.ice),
  },
  {
    id: 16,
    name: 'coal_ore',
    displayName: '煤矿石',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 2.2,
    textures: uniform(TILE.coalOre),
  },
  {
    id: 17,
    name: 'iron_ore',
    displayName: '铁矿石',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 2.6,
    textures: uniform(TILE.ironOre),
  },
  {
    id: 18,
    name: 'gold_ore',
    displayName: '金矿石',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 2.8,
    textures: uniform(TILE.goldOre),
  },
  {
    id: 19,
    name: 'diamond_ore',
    displayName: '钻石矿石',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 3.2,
    textures: uniform(TILE.diamondOre),
  },
  {
    id: 20,
    name: 'lamp',
    displayName: '萤石灯',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 0.5,
    textures: uniform(TILE.lamp),
    lightAttenuation: 0,
  },
  {
    id: 21,
    name: 'brick',
    displayName: '砖块',
    solid: true,
    opaque: true,
    transparent: false,
    liquid: false,
    breakable: true,
    hardness: 1.6,
    textures: uniform(TILE.brick),
  },
];
