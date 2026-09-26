import { describe, expect, it } from 'vitest';

import { createFlatTerrainGenerator, createTerrainGenerator } from '@/terrain';
import { BlockId } from '@/world/BlockRegistry';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y } from '@/world/coords';

import { generateChunk } from './helpers';

/**
 * 超平坦生成器的测试。
 *
 * I. 为什么要测它
 *
 * 1. 它是世界/网格化/物理测试的地基：那些测试会写死"y=68 是草方块"这样的坐标，
 *    一旦分层规则变了而这里没测出来，故障会以"物理测试莫名其妙失败"的形式出现。
 * 2. 它同时也是性能基准的左边界：如果平坦世界都不够快，噪声世界的性能问题就
 *    不在噪声上。
 */

const BASE_HEIGHT = 68;

describe('FlatTerrainGenerator', () => {
  const flat = createFlatTerrainGenerator(1);

  it('reports a walkable surface and a plains biome', () => {
    expect(flat.surfaceHeightAt(0, 0)).toBe(BASE_HEIGHT + 1);
    expect(flat.surfaceHeightAt(-100, 250)).toBe(BASE_HEIGHT + 1);
    expect(flat.biomeAt(0, 0)).toBe('plains');
    expect(flat.biomeAt(-9999, 9999)).toBe('plains');
  });

  it('lays out bedrock, stone, dirt and grass in fixed layers', () => {
    const target = generateChunk(flat, 0, 0);

    expect(target.at(0, 0, 0)).toBe(BlockId.Bedrock);
    expect(target.at(0, 1, 0)).toBe(BlockId.Stone);
    expect(target.at(0, BASE_HEIGHT - 3, 0)).toBe(BlockId.Stone);
    expect(target.at(0, BASE_HEIGHT - 2, 0)).toBe(BlockId.Dirt);
    expect(target.at(0, BASE_HEIGHT - 1, 0)).toBe(BlockId.Dirt);
    expect(target.at(0, BASE_HEIGHT, 0)).toBe(BlockId.Grass);

    for (let lz = 0; lz < 16; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        expect(target.at(lx, 0, lz)).toBe(BlockId.Bedrock);
        for (let y = BASE_HEIGHT + 1; y < CHUNK_SIZE_Y; y += 1) {
          expect(target.at(lx, y, lz)).toBe(BlockId.Air);
        }
      }
    }
  });

  it('is identical for every chunk and every seed', () => {
    const other = createFlatTerrainGenerator(-424242);
    const reference = generateChunk(flat, 0, 0);

    expect(generateChunk(flat, 0, 0).blocks).toEqual(reference.blocks);
    expect(generateChunk(flat, 7, -3).blocks).toEqual(reference.blocks);
    expect(generateChunk(other, -12, 40).blocks).toEqual(reference.blocks);
  });

  it('floods the surface when the sea level is above it', () => {
    const drowned = createFlatTerrainGenerator(1, { baseHeight: 20, seaLevel: 30 });
    const target = generateChunk(drowned, 0, 0);

    expect(drowned.surfaceHeightAt(0, 0)).toBe(31);
    expect(target.at(0, 20, 0)).toBe(BlockId.Grass);
    expect(target.at(0, 21, 0)).toBe(BlockId.Water);
    expect(target.at(0, 30, 0)).toBe(BlockId.Water);
    expect(target.at(0, 31, 0)).toBe(BlockId.Air);
  });

  it('has no caves, ores or decoration by construction', () => {
    const target = generateChunk(flat, 3, 3);
    for (let y = 1; y < BASE_HEIGHT; y += 1) {
      expect(target.at(4, y, 4)).not.toBe(BlockId.Air);
    }
    for (const id of [
      BlockId.CoalOre,
      BlockId.IronOre,
      BlockId.GoldOre,
      BlockId.DiamondOre,
      BlockId.Log,
      BlockId.Leaves,
    ]) {
      expect(target.count(id)).toBe(0);
    }
  });

  it('shares the option validation with the noise generator', () => {
    expect(() => createFlatTerrainGenerator(1, { seaLevel: 500 })).toThrow(RangeError);
    expect(() => createFlatTerrainGenerator(1, { baseHeight: -3 })).toThrow(RangeError);
    expect(createFlatTerrainGenerator(1, { seaLevel: 50 }).options.seaLevel).toBe(50);
    expect(createFlatTerrainGenerator(1).options).toEqual(createTerrainGenerator(1).options);
  });
});
