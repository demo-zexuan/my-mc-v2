import { describe, expect, it } from 'vitest';

import { BLOCK_DEFINITIONS } from '@/world/blocks';
import {
  BLOCK_DROP,
  BLOCK_FLAGS,
  BLOCK_FLAG,
  BLOCK_HARDNESS,
  BLOCK_LIGHT_ATTENUATION,
  BLOCK_TYPE_COUNT,
  BlockId,
  MAX_BLOCK_ID,
  blockIdByName,
  definitionOf,
  dropOf,
  hardnessOf,
  isBreakable,
  isEmissive,
  isLiquid,
  isOpaque,
  isSolid,
  isTransparent,
  lightAttenuationOf,
} from '@/world/BlockRegistry';

/**
 * Adversarial registry tests (T7 QA).
 *
 * I. What is being protected
 *
 * `BLOCK_DEFINITIONS` is indexed by id and the chunk payload stores raw bytes.
 * If the array index and the declared id ever disagree, stone renders as water
 * and, worse, a save file written by the previous build silently changes
 * meaning. The tables are also typed arrays, so an out-of-range id does not
 * throw: every accessor has to fail *safely* and predictably.
 */

/**
 * Reinterprets a raw byte the way a corrupt chunk payload would.
 *
 * @param id - Value read out of the byte-level block storage.
 */
function asRawId(id: number): BlockId {
  return id as unknown as BlockId;
}

/** Ids that have no definition in the catalogue. */
const UNKNOWN_IDS: readonly number[] = [22, 23, 100, 200, 254, 255];

describe('BlockRegistry: id and table-index agreement', () => {
  it('has definition.id === array index for every entry', () => {
    BLOCK_DEFINITIONS.forEach((definition, index) => {
      expect(definition.id, `entry ${index} (${definition.name}) declares a different id`).toBe(
        index,
      );
    });
  });

  it('keeps every typed-array table at MAX_BLOCK_ID + 1 slots', () => {
    expect(MAX_BLOCK_ID).toBe(255);
    expect(BLOCK_FLAGS.length).toBe(MAX_BLOCK_ID + 1);
    expect(BLOCK_HARDNESS.length).toBe(MAX_BLOCK_ID + 1);
    expect(BLOCK_DROP.length).toBe(MAX_BLOCK_ID + 1);
    expect(BLOCK_LIGHT_ATTENUATION.length).toBe(MAX_BLOCK_ID + 1);
    expect(BLOCK_TYPE_COUNT).toBe(BLOCK_DEFINITIONS.length);
  });

  it('keeps the BlockId constant table in sync with the definitions', () => {
    const byId = new Map(BLOCK_DEFINITIONS.map((definition) => [definition.id, definition]));
    const constants = Object.entries(BlockId) as ReadonlyArray<readonly [string, BlockId]>;

    expect(constants.length).toBeGreaterThan(0);
    for (const [key, id] of constants) {
      // Every exported constant must point at a definition...
      const definition = byId.get(id);
      expect(definition, `BlockId.${key} = ${id} has no definition`).toBeDefined();

      // ...and its PascalCase key must be the definition's stable name without
      // separators (`CoalOre` <-> `coal_ore`). The two spellings differ by
      // design, so a save format that persisted constant keys would silently
      // stop resolving; `blockIdByName` only accepts the snake_case name.
      expect(key.toLowerCase(), `key of BlockId.${key}`).toBe(
        (definition?.name ?? '').replaceAll('_', ''),
      );
    }

    // ...and the other way round: no definition may be missing a constant.
    expect(constants.length).toBe(BLOCK_DEFINITIONS.length);
  });

  it('assigns every definition a unique name and a unique id', () => {
    const names = new Set(BLOCK_DEFINITIONS.map((definition) => definition.name));
    const ids = new Set(BLOCK_DEFINITIONS.map((definition) => definition.id));
    expect(names.size).toBe(BLOCK_DEFINITIONS.length);
    expect(ids.size).toBe(BLOCK_DEFINITIONS.length);
  });

  it('keeps air as id 0, because chunk storage is zero-initialised', () => {
    expect(BlockId.Air).toBe(0);
    expect(BLOCK_DEFINITIONS[0]?.name).toBe('air');
    expect(definitionOf(BlockId.Air).name).toBe('air');
  });
});

describe('BlockRegistry: packed flag bits match the declarative definitions', () => {
  it('packs every boolean property into the matching bit', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      const flags = BLOCK_FLAGS[definition.id] ?? 0;
      const packed = {
        solid: (flags & BLOCK_FLAG.SOLID) !== 0,
        opaque: (flags & BLOCK_FLAG.OPAQUE) !== 0,
        transparent: (flags & BLOCK_FLAG.TRANSPARENT) !== 0,
        liquid: (flags & BLOCK_FLAG.LIQUID) !== 0,
        breakable: (flags & BLOCK_FLAG.BREAKABLE) !== 0,
      };

      expect(packed, `flags of ${definition.name}`).toEqual({
        solid: definition.solid,
        opaque: definition.opaque,
        transparent: definition.transparent,
        liquid: definition.liquid,
        breakable: definition.breakable,
      });

      expect(isSolid(definition.id)).toBe(definition.solid);
      expect(isOpaque(definition.id)).toBe(definition.opaque);
      expect(isTransparent(definition.id)).toBe(definition.transparent);
      expect(isLiquid(definition.id)).toBe(definition.liquid);
      expect(isBreakable(definition.id)).toBe(definition.breakable);
    }
  });

  it('uses only the six declared bits', () => {
    const allowed =
      BLOCK_FLAG.SOLID |
      BLOCK_FLAG.OPAQUE |
      BLOCK_FLAG.TRANSPARENT |
      BLOCK_FLAG.LIQUID |
      BLOCK_FLAG.BREAKABLE |
      BLOCK_FLAG.EMISSIVE;

    for (const definition of BLOCK_DEFINITIONS) {
      const flags = BLOCK_FLAGS[definition.id] ?? 0;
      expect(flags & ~allowed, `unknown bit set on ${definition.name}`).toBe(0);
    }
  });

  it('derives the emissive flag from the tile styles', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      const { top, side, bottom } = definition.textures;
      const expected = [top, side, bottom].some((style) => (style.emissive ?? 0) > 0);
      expect(isEmissive(definition.id), `emissive flag of ${definition.name}`).toBe(expected);
    }
    expect(isEmissive(BlockId.Lamp)).toBe(true);
  });
});

describe('BlockRegistry: unknown ids fail safe instead of throwing', () => {
  it('answers every predicate with false for ids that have no definition', () => {
    for (const id of UNKNOWN_IDS) {
      expect(isSolid(asRawId(id)), `isSolid(${id})`).toBe(false);
      expect(isOpaque(asRawId(id)), `isOpaque(${id})`).toBe(false);
      expect(isTransparent(asRawId(id)), `isTransparent(${id})`).toBe(false);
      expect(isLiquid(asRawId(id)), `isLiquid(${id})`).toBe(false);
      expect(isBreakable(asRawId(id)), `isBreakable(${id})`).toBe(false);
      expect(isEmissive(asRawId(id)), `isEmissive(${id})`).toBe(false);
      expect(hardnessOf(asRawId(id)), `hardnessOf(${id})`).toBe(0);
      expect(dropOf(asRawId(id)), `dropOf(${id})`).toBe(null);
      expect(isEmissive(asRawId(id)), `isEmissive(${id})`).toBe(false);
    }
  });

  it('reports attenuation 0 rather than the documented 1 fallback for unknown ids', () => {
    // `lightAttenuationOf` is written as `BLOCK_LIGHT_ATTENUATION[id] ?? 1`, but
    // the table has a slot for every representable byte, so the fallback can only
    // be reached with an id outside 0..255 or a non-integer. For a corrupt byte
    // the answer is therefore the zero-initialised 0 — "light passes through" —
    // and the `?? 1` branch is dead code for real payloads.
    for (const id of UNKNOWN_IDS) {
      expect(lightAttenuationOf(asRawId(id)), `lightAttenuationOf(${id})`).toBe(0);
    }
    expect(lightAttenuationOf(256 as unknown as BlockId)).toBe(1);
    expect(lightAttenuationOf(-1 as unknown as BlockId)).toBe(1);
  });

  it('throws a RangeError when a definition is actually requested', () => {
    for (const id of [...UNKNOWN_IDS, -1, MAX_BLOCK_ID + 1]) {
      // The accessor must throw rather than return a wrong block: a mesher that
      // silently rendered id 200 as stone would hide a corrupt save file.
      expect(() => definitionOf(asRawId(id)), `definitionOf(${id})`).toThrow(RangeError);
    }
  });

  it('treats an unknown id as neither air nor a solid block (documented risk)', () => {
    // `Chunk` stores raw bytes and casts them to BlockId, so any byte in 22..255
    // is representable but undefined. Such a block is *not* air, yet it is not
    // solid and not opaque: the mesher would emit every neighbouring face around
    // it. This is a fail-open path — a corrupt save would not crash, but it would
    // render an invisible hole the player can neither stand on nor see.
    const rawByte = 200;
    expect(rawByte).not.toBe(BlockId.Air);
    expect(isSolid(asRawId(rawByte))).toBe(false);
    expect(isOpaque(asRawId(rawByte))).toBe(false);
    expect(isTransparent(asRawId(rawByte))).toBe(false);
  });
});

describe('BlockRegistry: drop and hardness semantics', () => {
  it('defaults an unspecified drop to the block itself', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      if (definition.drop === undefined) {
        expect(dropOf(definition.id), `default drop of ${definition.name}`).toBe(definition.id);
      }
    }
  });

  it('maps an explicit null drop to "drops nothing"', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      if (definition.drop === null) {
        expect(dropOf(definition.id), `null drop of ${definition.name}`).toBe(null);
      }
    }
    expect(dropOf(BlockId.Glass)).toBe(null);
    expect(dropOf(BlockId.Water)).toBe(null);
    expect(dropOf(BlockId.Bedrock)).toBe(null);
    expect(dropOf(BlockId.Air)).toBe(null);
  });

  it('keeps the one non-identity drop correct (grass -> dirt)', () => {
    expect(dropOf(BlockId.Grass)).toBe(BlockId.Dirt);
  });

  it('reports hardness and breakability coherently', () => {
    expect(hardnessOf(BlockId.Stone)).toBeCloseTo(1.5, 5);
    expect(hardnessOf(BlockId.Bedrock)).toBe(Number.POSITIVE_INFINITY);
    expect(isBreakable(BlockId.Bedrock)).toBe(false);
    expect(hardnessOf(BlockId.Air)).toBe(0);

    for (const definition of BLOCK_DEFINITIONS) {
      const stored = hardnessOf(definition.id);
      if (Number.isFinite(definition.hardness)) {
        // A Float32Array cannot store every decimal exactly; compare with a
        // tolerance rather than for equality.
        expect(stored, `hardness of ${definition.name}`).toBeCloseTo(definition.hardness, 5);
        expect(stored).toBeGreaterThanOrEqual(0);
      } else {
        expect(stored, `hardness of ${definition.name}`).toBe(definition.hardness);
      }
      expect(Number.isNaN(stored)).toBe(false);
    }
  });

  it('keeps every light attenuation inside the documented 0..1 range', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      const value = lightAttenuationOf(definition.id);
      expect(value, `attenuation of ${definition.name}`).toBeGreaterThanOrEqual(0);
      expect(value, `attenuation of ${definition.name}`).toBeLessThanOrEqual(1);
    }
  });
});

describe('BlockRegistry: name lookup', () => {
  it('resolves every registered name and rejects unknown ones', () => {
    for (const definition of BLOCK_DEFINITIONS) {
      expect(blockIdByName(definition.name)).toBe(definition.id);
    }
    expect(blockIdByName('stone')).toBe(BlockId.Stone);
    expect(blockIdByName('Stone')).toBe(null);
    expect(blockIdByName('')).toBe(null);
    expect(blockIdByName('obsidian')).toBe(null);
  });
});
