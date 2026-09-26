/**
 * Block registry and hot-path lookup tables.
 *
 * I. Why this module converts definitions into typed arrays
 *
 * The chunk mesher asks "is the neighbour opaque?" once per candidate face, and
 * the collider asks "is this solid?" once per axis per step. Both run tens of
 * thousands of times per frame. Reading a boolean out of a `Uint8Array` costs a
 * single bounds-checked load, whereas following an object reference to a
 * property costs a pointer dereference plus a shape lookup that the JIT cannot
 * always hoist. The definitions stay readable and the accessors stay free.
 *
 * II. Identifier validation
 *
 * `BLOCK_DEFINITIONS` is indexed by id, so a mis-numbered entry would silently
 * map stone to water. The table is validated at module load: the game must fail
 * loudly during development rather than corrupt player worlds.
 *
 * @module world/BlockRegistry
 */

import { BLOCK_DEFINITIONS, type BlockDefinition, type BlockTextures } from './blocks';

/** Stable numeric ids. **Do not renumber**: chunk payloads store raw ids. */
export const BlockId = {
  Air: 0,
  Stone: 1,
  Dirt: 2,
  Grass: 3,
  Sand: 4,
  Water: 5,
  Log: 6,
  Leaves: 7,
  Glass: 8,
  Planks: 9,
  Cobblestone: 10,
  Bedrock: 11,
  Gravel: 12,
  Sandstone: 13,
  Snow: 14,
  Ice: 15,
  CoalOre: 16,
  IronOre: 17,
  GoldOre: 18,
  DiamondOre: 19,
  Lamp: 20,
  Brick: 21,
} as const;

/** Union of every valid block id. */
export type BlockId = (typeof BlockId)[keyof typeof BlockId];

/** Highest id the registry supports. Chunk storage is a `Uint8Array`. */
export const MAX_BLOCK_ID = 255;

// ---------------------------------------------------------------------------
// Property bit flags
// ---------------------------------------------------------------------------

export const BLOCK_FLAG = {
  SOLID: 1 << 0,
  OPAQUE: 1 << 1,
  TRANSPARENT: 1 << 2,
  LIQUID: 1 << 3,
  BREAKABLE: 1 << 4,
  EMISSIVE: 1 << 5,
} as const;

/** Number of slots in every lookup table. */
const TABLE_SIZE = MAX_BLOCK_ID + 1;

/** Property flags indexed by block id. */
export const BLOCK_FLAGS = new Uint8Array(TABLE_SIZE);
/** Break time in seconds indexed by block id. */
export const BLOCK_HARDNESS = new Float32Array(TABLE_SIZE);
/** Item id dropped when broken; `-1` means "nothing". */
export const BLOCK_DROP = new Int16Array(TABLE_SIZE);
/** Light removed per block traversed, in `0 .. 1`. */
export const BLOCK_LIGHT_ATTENUATION = new Float32Array(TABLE_SIZE);

// ---------------------------------------------------------------------------
// Table construction and validation
// ---------------------------------------------------------------------------

function buildTables(): void {
  BLOCK_DROP.fill(-1);

  for (const [index, definition] of BLOCK_DEFINITIONS.entries()) {
    // I. Structural validation.
    // 1. Index and id must agree, otherwise `definitionOf(id)` would return a
    //    different block than the one the mesher is looking at.
    if (definition.id !== index) {
      throw new Error(
        `Block definitions must be indexed by id: entry ${index} declares id ${definition.id} (${definition.name}).`,
      );
    }
    if (definition.id < 0 || definition.id > MAX_BLOCK_ID) {
      throw new Error(
        `Block id ${definition.id} is outside the supported range 0..${MAX_BLOCK_ID}.`,
      );
    }

    // II. Flag packing.
    let flags = 0;
    if (definition.solid) flags |= BLOCK_FLAG.SOLID;
    if (definition.opaque) flags |= BLOCK_FLAG.OPAQUE;
    if (definition.transparent) flags |= BLOCK_FLAG.TRANSPARENT;
    if (definition.liquid) flags |= BLOCK_FLAG.LIQUID;
    if (definition.breakable) flags |= BLOCK_FLAG.BREAKABLE;
    if (facesAreEmissive(definition)) flags |= BLOCK_FLAG.EMISSIVE;

    BLOCK_FLAGS[definition.id] = flags;
    BLOCK_HARDNESS[definition.id] = definition.hardness;
    BLOCK_DROP[definition.id] =
      definition.drop === undefined ? definition.id : (definition.drop ?? -1);
    BLOCK_LIGHT_ATTENUATION[definition.id] =
      definition.lightAttenuation ?? (definition.opaque ? 1 : 0.2);
  }
}

function facesAreEmissive(definition: BlockDefinition): boolean {
  const { top, side, bottom } = definition.textures;
  return (top.emissive ?? 0) > 0 || (side.emissive ?? 0) > 0 || (bottom.emissive ?? 0) > 0;
}

buildTables();

/** Name to id index, used by the save format and by tests. */
const ID_BY_NAME: ReadonlyMap<string, BlockId> = new Map(
  BLOCK_DEFINITIONS.map((definition) => [definition.name, definition.id]),
);

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

/**
 * Returns the definition of a block id.
 *
 * @param id - Block id.
 * @throws {RangeError} When the id has no definition, which means a corrupt
 *         chunk or a bug in a generator.
 */
export function definitionOf(id: BlockId): BlockDefinition {
  const definition = BLOCK_DEFINITIONS[id];
  if (definition === undefined) {
    throw new RangeError(`No block definition registered for id ${id}.`);
  }
  return definition;
}

/** True when the block stops the player. */
export function isSolid(id: BlockId): boolean {
  return ((BLOCK_FLAGS[id] ?? 0) & BLOCK_FLAG.SOLID) !== 0;
}

/** True when the block hides the face of its neighbour. */
export function isOpaque(id: BlockId): boolean {
  return ((BLOCK_FLAGS[id] ?? 0) & BLOCK_FLAG.OPAQUE) !== 0;
}

/** True when the block belongs to the sorted transparent pass. */
export function isTransparent(id: BlockId): boolean {
  return ((BLOCK_FLAGS[id] ?? 0) & BLOCK_FLAG.TRANSPARENT) !== 0;
}

/** True when the block behaves as a fluid. */
export function isLiquid(id: BlockId): boolean {
  return ((BLOCK_FLAGS[id] ?? 0) & BLOCK_FLAG.LIQUID) !== 0;
}

/** True when the player can destroy the block. */
export function isBreakable(id: BlockId): boolean {
  return ((BLOCK_FLAGS[id] ?? 0) & BLOCK_FLAG.BREAKABLE) !== 0;
}

/** True when the block contributes light of its own. */
export function isEmissive(id: BlockId): boolean {
  return ((BLOCK_FLAGS[id] ?? 0) & BLOCK_FLAG.EMISSIVE) !== 0;
}

/** Seconds needed to break the block by hand. */
export function hardnessOf(id: BlockId): number {
  return BLOCK_HARDNESS[id] ?? 0;
}

/**
 * Item produced when the block is broken.
 *
 * @returns The dropped item id, or `null` when the block drops nothing.
 */
export function dropOf(id: BlockId): BlockId | null {
  const drop = BLOCK_DROP[id] ?? -1;
  return drop < 0 ? null : (drop as BlockId);
}

/** Light removed when a ray passes through the block. */
export function lightAttenuationOf(id: BlockId): number {
  return BLOCK_LIGHT_ATTENUATION[id] ?? 1;
}

/** Texture descriptor set for a block. */
export function texturesOf(id: BlockId): BlockTextures {
  return definitionOf(id).textures;
}

/**
 * Looks a block up by its stable name.
 *
 * @param name - Value of `BlockDefinition.name`.
 * @returns The matching id, or `null` when the name is unknown (for example a
 *          save written by a newer version).
 */
export function blockIdByName(name: string): BlockId | null {
  return ID_BY_NAME.get(name) ?? null;
}

/** Every registered definition, in id order. */
export function allBlocks(): readonly BlockDefinition[] {
  return BLOCK_DEFINITIONS;
}

/** Total number of registered block types. */
export const BLOCK_TYPE_COUNT = BLOCK_DEFINITIONS.length;
