import { describe, expect, it } from 'vitest';

import { createTerrainGenerator, resolveTerrainOptions } from '@/terrain';
import type { BiomeId, ChunkDataTarget, TerrainGenerator } from '@/terrain/types';
import { BlockId } from '@/world/BlockRegistry';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '@/world/coords';

import {
  buildRegion,
  countBiomes,
  eachColumn,
  generateChunk,
  type RecordingTarget,
  type Region,
} from './helpers';

/**
 * 地形生成器的测试。
 *
 * I. 覆盖顺序
 *
 * 1. 先钉死确定性（同种子同结果、不同种子不同结果、与调用顺序无关）—— 存档只存
 *    种子，这一条塌了玩家的旧世界就会变形。
 * 2. 再验证结构不变量（基岩、地表、水、沙滩、矿脉、洞穴、树），它们跨种子都成立。
 * 3. 最后验证参数开关（洞穴/矿脉/装饰/振幅）真的改变结果。
 */

const SEED = 20240607;
/** 海平面默认值，测试里重复声明以便断言"水下"这类概念。 */
const SEA_LEVEL = 62;

const generator = createTerrainGenerator(SEED);

/** 8x8 区块的拼合区域，所有结构性测试共用，避免重复生成。 */
const region: Region = buildRegion(generator, -4, -4, 8, 8);

/** 深地下采样高度上限：即使最深的海底也在它之上。 */
const DEEP_UNDERGROUND_MAX_Y = 40;

function biomeList(): ReadonlyMap<BiomeId, number> {
  return countBiomes(generator, -512, 512, 8);
}

// ---------------------------------------------------------------------------
// 确定性
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces byte identical chunks for the same seed', () => {
    const first = createTerrainGenerator(SEED);
    const second = createTerrainGenerator(SEED);

    for (const [cx, cz] of [
      [0, 0],
      [3, -7],
      [-5, 2],
    ] as const) {
      expect(generateChunk(first, cx, cz).blocks).toEqual(generateChunk(second, cx, cz).blocks);
    }
  });

  it('produces byte identical chunks when the same instance is reused', () => {
    const shared = createTerrainGenerator(SEED);
    const first = generateChunk(shared, 1, 2);
    const second = generateChunk(shared, 1, 2);

    expect(second.blocks).toEqual(first.blocks);
    expect(second.writeCount).toBe(first.writeCount);
  });

  it('does not depend on the order chunks are requested in', () => {
    const forward = createTerrainGenerator(SEED);
    generateChunk(forward, -1, -1);
    const forwardTarget = generateChunk(forward, 4, 5);

    const backward = createTerrainGenerator(SEED);
    generateChunk(backward, 9, 9);
    generateChunk(backward, 4, 5);
    const backwardTarget = generateChunk(backward, -1, -1);

    expect(forwardTarget.blocks).toEqual(generateChunk(backward, 4, 5).blocks);
    expect(backwardTarget.blocks).toEqual(generateChunk(forward, -1, -1).blocks);
  });

  it('changing the seed changes the world', () => {
    const other = createTerrainGenerator(SEED + 1);
    const reference = generateChunk(generator, 0, 0);
    const changed = generateChunk(other, 0, 0);

    let differences = 0;
    for (let index = 0; index < reference.blocks.length; index += 1) {
      if (reference.blocks[index] !== changed.blocks[index]) {
        differences += 1;
      }
    }
    expect(differences).toBeGreaterThan(1000);
  });

  it('keeps a chunk identical whether or not its neighbours were generated first', () => {
    const solo = generateChunk(createTerrainGenerator(SEED), 0, 0);
    const neighbours = createTerrainGenerator(SEED);
    generateChunk(neighbours, -1, 0);
    generateChunk(neighbours, 0, -1);
    generateChunk(neighbours, -1, -1);
    const fromNeighbours = generateChunk(neighbours, 0, 0);

    expect(fromNeighbours.blocks).toEqual(solo.blocks);
  });
});

// ---------------------------------------------------------------------------
// 目标契约
// ---------------------------------------------------------------------------

describe('chunk target contract', () => {
  it('never writes outside the chunk, even for cross border decorations', () => {
    for (const [cx, cz] of [
      [0, 0],
      [-1, -1],
      [7, -3],
    ] as const) {
      const target = generateChunk(generator, cx, cz);
      expect(target.outOfRangeWrites).toBe(0);
      expect(target.writeCount).toBeGreaterThan(0);
    }
  });

  it('survives a target that rejects out of range coordinates loudly', () => {
    const strict: ChunkDataTarget = {
      setBlock(lx, y, lz) {
        if (lx < 0 || lx >= CHUNK_SIZE_X || lz < 0 || lz >= CHUNK_SIZE_Z) {
          throw new RangeError(`out of range x=${lx} z=${lz}`);
        }
        if (y < 0 || y >= CHUNK_SIZE_Y) {
          throw new RangeError(`out of range y=${y}`);
        }
      },
    };

    expect(() => generator.generate(2, -2, strict)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 地表与高度
// ---------------------------------------------------------------------------

describe('surface height', () => {
  it('stays inside the world and always has ground or water underneath', () => {
    for (const { x, z } of eachColumn(region)) {
      const height = generator.surfaceHeightAt(x, z);
      expect(height).toBeGreaterThanOrEqual(2);
      expect(height).toBeLessThanOrEqual(CHUNK_SIZE_Y - 1);
      expect(region.at(x, height - 1, z)).not.toBe(BlockId.Air);
    }
  });

  it('leaves nothing but air and decorations above the reported height', () => {
    for (const { x, z } of eachColumn(region)) {
      const height = generator.surfaceHeightAt(x, z);
      for (let y = height; y < CHUNK_SIZE_Y; y += 1) {
        const id = region.at(x, y, z);
        if (id === BlockId.Air) {
          continue;
        }
        // 树是唯一会长在地表之上的东西；出现别的方块就意味着 surfaceHeightAt
        // 与实际生成结果不一致。
        expect([BlockId.Log, BlockId.Leaves]).toContain(id);
      }
    }
  });

  it('reports the water surface, not the sea floor, for flooded columns', () => {
    let flooded = 0;
    for (const { x, z } of eachColumn(region)) {
      if (generator.biomeAt(x, z) !== 'ocean') {
        continue;
      }
      flooded += 1;
      expect(generator.surfaceHeightAt(x, z)).toBe(SEA_LEVEL + 1);
      expect(region.at(x, SEA_LEVEL, z)).not.toBe(BlockId.Air);
    }
    expect(flooded).toBeGreaterThan(0);
  });

  it('is cheap enough to call per column', () => {
    // 出生点搜索会对几千根柱子调用它；这里只是防止它退化成"生成整个区块"。
    const started = performance.now();
    let checksum = 0;
    for (let index = 0; index < 2000; index += 1) {
      checksum += generator.surfaceHeightAt(index * 7 - 300, index * -5 + 120);
    }
    const elapsed = performance.now() - started;
    expect(checksum).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 地质分层
// ---------------------------------------------------------------------------

describe('geology', () => {
  it('covers the bottom of every column with bedrock', () => {
    for (const { x, z } of eachColumn(region)) {
      expect(region.at(x, 0, z)).toBe(BlockId.Bedrock);
    }
  });

  it('grows grass on land and sand on beaches', () => {
    let grassColumns = 0;
    let beachColumns = 0;
    for (const { x, z } of eachColumn(region)) {
      const biome = generator.biomeAt(x, z);
      const height = generator.surfaceHeightAt(x, z);
      if (biome === 'plains' || biome === 'forest' || biome === 'hills') {
        grassColumns += 1;
        expect(region.at(x, height - 1, z)).toBe(BlockId.Grass);
        // 草方块下面必须是泥土，不能直接是石头。
        expect(region.at(x, height - 2, z)).toBe(BlockId.Dirt);
      }
      if (biome === 'beach') {
        beachColumns += 1;
        expect(region.at(x, height - 1, z)).toBe(BlockId.Sand);
      }
      if (biome === 'snow') {
        expect(region.at(x, height - 1, z)).toBe(BlockId.Snow);
      }
      if (biome === 'mountains') {
        expect(region.at(x, height - 1, z)).toBe(BlockId.Stone);
      }
    }
    expect(grassColumns).toBeGreaterThan(0);
    expect(beachColumns).toBeGreaterThan(0);
  });

  it('floods everything below sea level and nothing above it', () => {
    let water = 0;
    for (const { x, z } of eachColumn(region)) {
      for (let y = 0; y < CHUNK_SIZE_Y; y += 1) {
        const id = region.at(x, y, z);
        if (id === BlockId.Water || id === BlockId.Ice) {
          water += 1;
          expect(y).toBeLessThanOrEqual(SEA_LEVEL);
        }
      }
    }
    expect(water).toBeGreaterThan(0);
  });

  it('keeps the sea floor shallow near the coast and deep offshore', () => {
    // 海岸线附近的浅滩在原点附近就能看到，深海平原要到更远的地方，所以这里按
    // 区块抽样去覆盖两种海域。
    let shallow = 0;
    let deep = 0;
    for (const cx of [-8, -4, 0, 4, 8]) {
      for (const cz of [-8, -4, 0, 4, 8]) {
        const target = generateChunk(generator, cx, cz);
        for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
          for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
            const worldX = cx * CHUNK_SIZE_X + lx;
            const worldZ = cz * CHUNK_SIZE_Z + lz;
            if (generator.biomeAt(worldX, worldZ) !== 'ocean') {
              continue;
            }
            let floor = SEA_LEVEL;
            while (floor > 0) {
              const id = target.at(lx, floor, lz);
              if (id !== BlockId.Water && id !== BlockId.Ice && id !== BlockId.Air) {
                break;
              }
              floor -= 1;
            }
            const depth = SEA_LEVEL - floor;
            if (depth <= 3) {
              shallow += 1;
            }
            if (depth >= 8) {
              deep += 1;
            }
          }
        }
      }
    }
    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 生物群系
// ---------------------------------------------------------------------------

describe('biomes', () => {
  it('generates every documented biome', () => {
    const counts = biomeList();
    const missing = (
      ['ocean', 'beach', 'plains', 'forest', 'hills', 'mountains', 'snow'] as const
    ).filter((biome) => (counts.get(biome) ?? 0) === 0);

    expect(missing).toEqual([]);
  });

  it('agrees with the reported surface height', () => {
    const counts = biomeList();
    for (const biome of counts.keys()) {
      expect(['ocean', 'beach', 'plains', 'forest', 'hills', 'mountains', 'snow']).toContain(biome);
    }

    for (let x = -512; x < 512; x += 16) {
      for (let z = -512; z < 512; z += 16) {
        const biome = generator.biomeAt(x, z);
        const height = generator.surfaceHeightAt(x, z);
        if (biome === 'ocean') {
          expect(height).toBeLessThanOrEqual(SEA_LEVEL + 1);
        } else {
          expect(height).toBeGreaterThanOrEqual(SEA_LEVEL + 1);
        }
        if (biome === 'beach') {
          expect(height).toBeLessThanOrEqual(SEA_LEVEL + 2);
        }
      }
    }
  });

  it('is stable for repeated queries', () => {
    for (let index = 0; index < 200; index += 1) {
      const x = index * 37 - 900;
      const z = index * -19 + 400;
      expect(generator.biomeAt(x, z)).toBe(generator.biomeAt(x, z));
    }
  });
});

// ---------------------------------------------------------------------------
// 洞穴与矿脉
// ---------------------------------------------------------------------------

describe('caves', () => {
  it('carves holes underground when enabled', () => {
    const target = generateChunk(generator, 0, 0);
    let air = 0;
    for (let y = 4; y <= DEEP_UNDERGROUND_MAX_Y; y += 1) {
      for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
        for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
          if (target.at(lx, y, lz) === BlockId.Air) {
            air += 1;
          }
        }
      }
    }
    expect(air).toBeGreaterThan(0);
  });

  it('leaves the underground solid when disabled', () => {
    const solid = createTerrainGenerator(SEED, { caves: false });
    for (const [cx, cz] of [
      [0, 0],
      [-2, 3],
    ] as const) {
      const target = generateChunk(solid, cx, cz);
      for (let y = 4; y <= DEEP_UNDERGROUND_MAX_Y; y += 1) {
        for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
          for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
            expect(target.at(lx, y, lz)).not.toBe(BlockId.Air);
          }
        }
      }
    }
  });

  it('never breaks the surface open', () => {
    // 地表以下几格必须保持完整，否则玩家会在草原中间掉进竖井。
    for (const { x, z } of eachColumn(region)) {
      const height = generator.surfaceHeightAt(x, z);
      if (generator.biomeAt(x, z) === 'ocean') {
        continue;
      }
      for (let y = height - 1; y >= height - 3; y -= 1) {
        expect(region.at(x, y, z)).not.toBe(BlockId.Air);
      }
    }
  });
});

describe('ore veins', () => {
  it('places every ore type', () => {
    const found = new Set<number>();
    for (const [cx, cz] of [
      [-4, -4],
      [-3, 2],
      [0, 0],
      [1, -3],
      [3, 3],
    ] as const) {
      const target = generateChunk(generator, cx, cz);
      for (const id of target.blocks) {
        found.add(id);
      }
    }
    expect(found.has(BlockId.CoalOre)).toBe(true);
    expect(found.has(BlockId.IronOre)).toBe(true);
    expect(found.has(BlockId.GoldOre)).toBe(true);
    expect(found.has(BlockId.DiamondOre)).toBe(true);
  });

  it('keeps each ore inside its depth band', () => {
    const limits: readonly [BlockId, number][] = [
      [BlockId.CoalOre, 113],
      [BlockId.IronOre, 65],
      [BlockId.GoldOre, 33],
      [BlockId.DiamondOre, 17],
    ];
    for (const [cx, cz] of [
      [-4, -4],
      [0, 0],
      [2, 5],
    ] as const) {
      const target = generateChunk(generator, cx, cz);
      for (const [id, maxY] of limits) {
        for (const { y } of target.positions(id)) {
          expect(y).toBeLessThanOrEqual(maxY);
        }
      }
    }
  });

  it('replaces nothing but stone', () => {
    // I. 判定方法：把同一区块在"开矿"与"关矿"下各生成一次
    // 1. 只统计六邻域里有石头是不够的：矿脉核心被同脉矿石包住，本来就没有石头邻居。
    // 2. 关掉矿脉后，每一块矿石所在的位置都必须还是石头。这正好等价于"只替换石头"，
    //    而且顺带证明关掉矿脉只影响矿石、不改动基础地形。
    const withOres = createTerrainGenerator(SEED, { ores: true });
    const withoutOres = createTerrainGenerator(SEED, { ores: false });
    const oreIds = [BlockId.CoalOre, BlockId.IronOre, BlockId.GoldOre, BlockId.DiamondOre] as const;

    let veins = 0;
    for (const [cx, cz] of [
      [0, 0],
      [-1, 2],
      [3, -3],
    ] as const) {
      const rich = generateChunk(withOres, cx, cz);
      const plain = generateChunk(withoutOres, cx, cz);
      for (const id of oreIds) {
        for (const { lx, y, lz } of rich.positions(id)) {
          veins += 1;
          expect(plain.at(lx, y, lz)).toBe(BlockId.Stone);
        }
      }
    }
    expect(veins).toBeGreaterThan(0);
  });

  it('places no ore at all when disabled', () => {
    const noOres = createTerrainGenerator(SEED, { ores: false });
    const target = generateChunk(noOres, 0, 0);
    for (const id of [BlockId.CoalOre, BlockId.IronOre, BlockId.GoldOre, BlockId.DiamondOre]) {
      expect(target.count(id)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 树木与跨区块特征
// ---------------------------------------------------------------------------

/** 区域内找到的一棵树。 */
interface Tree {
  readonly x: number;
  /** 树干最底下一格的 Y。 */
  readonly baseY: number;
  readonly z: number;
  /** 树干高度（连续原木的格数）。 */
  readonly trunkHeight: number;
}

/** 扫描区域，找出所有树干（由下往上连续的原木柱）。 */
function findTrees(area: Region): Tree[] {
  const trees: Tree[] = [];
  for (const { x, z } of eachColumn(area)) {
    if (area.at(x, 0, z) === BlockId.Log) {
      continue;
    }
    for (let y = 1; y < CHUNK_SIZE_Y - 1; y += 1) {
      if (area.at(x, y, z) !== BlockId.Log || area.at(x, y - 1, z) === BlockId.Log) {
        continue;
      }
      let height = 1;
      while (area.at(x, y + height, z) === BlockId.Log) {
        height += 1;
      }
      if (height >= 3) {
        trees.push({ x, baseY: y, z, trunkHeight: height });
      }
      y += height;
    }
  }
  return trees;
}

describe('trees', () => {
  const trees = findTrees(region);

  it('grows trees on land', () => {
    expect(trees.length).toBeGreaterThan(10);
  });

  it('stands every trunk on solid ground, never in water', () => {
    for (const tree of trees) {
      const below = region.at(tree.x, tree.baseY - 1, tree.z);
      expect([
        BlockId.Grass,
        BlockId.Dirt,
        BlockId.Sand,
        BlockId.Snow,
        BlockId.Stone,
        BlockId.Gravel,
      ]).toContain(below);
    }
  });

  it('completes every canopy, including the ones crossing chunk borders', () => {
    // I. 为什么用"期望形状 + 允许被地表挡住"来判定完整性
    // 1. 树冠的期望形状只由树干高度决定，测试里直接按公式展开，等于把树冠规格钉住。
    // 2. 生成器只会在空气/树叶上放树叶，所以"期望位置上是固体地表"是允许的；
    //    真正表示被截断的是"期望位置上是空气"。
    let crossBorder = 0;
    for (const tree of trees) {
      // 留出 3 格边界，保证期望形状完全落在区域内。
      if (
        tree.x - 3 <= region.originX ||
        tree.x + 3 >= region.originX + region.sizeX ||
        tree.z - 3 <= region.originZ ||
        tree.z + 3 >= region.originZ + region.sizeZ
      ) {
        continue;
      }

      const height = tree.trunkHeight;
      const offsets: { dx: number; dy: number; dz: number }[] = [];
      for (let offsetY = height - 3; offsetY <= height; offsetY += 1) {
        const radius = offsetY >= height ? 1 : 2;
        for (let dx = -radius; dx <= radius; dx += 1) {
          for (let dz = -radius; dz <= radius; dz += 1) {
            if (Math.abs(dx) === radius && Math.abs(dz) === radius) {
              continue;
            }
            offsets.push({ dx, dy: offsetY, dz });
          }
        }
      }
      offsets.push({ dx: 0, dy: height + 1, dz: 0 });

      for (const { dx, dy, dz } of offsets) {
        const id = region.at(tree.x + dx, tree.baseY + dy, tree.z + dz);
        // 空气 = 树冠缺了一块；树叶或任何固体地表都算"这里本来就不该有树叶"。
        expect(id === BlockId.Leaves || id !== BlockId.Air).toBe(true);
      }

      // 树干附近必须有树叶，否则"完整"就成了空话。
      let leaves = 0;
      for (let dy = 0; dy <= height + 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          for (let dz = -2; dz <= 2; dz += 1) {
            if (region.at(tree.x + dx, tree.baseY + dy, tree.z + dz) === BlockId.Leaves) {
              leaves += 1;
            }
          }
        }
      }
      expect(leaves).toBeGreaterThanOrEqual(12);

      const nearBorder =
        tree.x - Math.floor(tree.x / CHUNK_SIZE_X) * CHUNK_SIZE_X <= 2 ||
        tree.x - Math.floor(tree.x / CHUNK_SIZE_X) * CHUNK_SIZE_X >= CHUNK_SIZE_X - 3 ||
        tree.z - Math.floor(tree.z / CHUNK_SIZE_Z) * CHUNK_SIZE_Z <= 2 ||
        tree.z - Math.floor(tree.z / CHUNK_SIZE_Z) * CHUNK_SIZE_Z >= CHUNK_SIZE_Z - 3;
      if (nearBorder) {
        crossBorder += 1;
      }
    }
    // 如果一棵跨界树都没有被检查到，"跨区块不截断"就没有被真正验证。
    expect(crossBorder).toBeGreaterThan(0);
  });

  it('places no decoration at all when disabled', () => {
    const bare = createTerrainGenerator(SEED, { decorations: false });
    for (const [cx, cz] of [
      [0, 0],
      [-3, -3],
    ] as const) {
      const target = generateChunk(bare, cx, cz);
      expect(target.count(BlockId.Log)).toBe(0);
      expect(target.count(BlockId.Leaves)).toBe(0);
    }
  });

  it('writes the same tree whether the chunk is generated alone or with neighbours', () => {
    const solo = generateChunk(createTerrainGenerator(SEED), -4, -4);
    const assembled = generateChunk(generator, -4, -4);
    expect(assembled.blocks).toEqual(solo.blocks);
  });
});

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

describe('options', () => {
  it('applies documented defaults', () => {
    const options = resolveTerrainOptions(undefined);
    expect(options).toEqual({
      seaLevel: 62,
      baseHeight: 68,
      mountainAmplitude: 26,
      caves: true,
      ores: true,
      decorations: true,
    });
    expect(generator.options).toEqual(options);
    expect(generator.seed).toBe(SEED);
  });

  it('raises terrain when baseHeight is raised', () => {
    const low = createTerrainGenerator(SEED, { baseHeight: 68 });
    const high = createTerrainGenerator(SEED, { baseHeight: 90 });

    let lowSum = 0;
    let highSum = 0;
    for (let index = 0; index < 400; index += 1) {
      const x = index * 11 - 2200;
      const z = index * -7 + 1500;
      lowSum += low.surfaceHeightAt(x, z);
      highSum += high.surfaceHeightAt(x, z);
    }
    expect(highSum).toBeGreaterThan(lowSum);
  });

  it('lowers the peaks when the mountain amplitude is removed', () => {
    const flat = createTerrainGenerator(SEED, { mountainAmplitude: 0 });
    let maxPlain = 0;
    let maxMountain = 0;
    for (let index = 0; index < 900; index += 1) {
      const x = (index % 30) * 60 - 900;
      const z = Math.floor(index / 30) * 60 - 900;
      maxPlain = Math.max(maxPlain, flat.surfaceHeightAt(x, z));
      maxMountain = Math.max(maxMountain, generator.surfaceHeightAt(x, z));
    }
    // 振幅为 0 时地表只剩下 baseHeight + 丘陵 + 细节。
    expect(maxPlain).toBeLessThanOrEqual(85);
    expect(maxMountain).toBeGreaterThan(maxPlain);
  });

  it('floods the world when the sea level is raised', () => {
    const flooded = createTerrainGenerator(SEED, { seaLevel: 80 });
    const target = generateChunk(flooded, 0, 0);
    expect(target.count(BlockId.Water)).toBeGreaterThan(0);
    expect(flooded.options.seaLevel).toBe(80);
  });

  it('rejects parameters that cannot produce a playable world', () => {
    expect(() => createTerrainGenerator(SEED, { seaLevel: 200 })).toThrow(RangeError);
    expect(() => createTerrainGenerator(SEED, { seaLevel: 0 })).toThrow(RangeError);
    expect(() => createTerrainGenerator(SEED, { baseHeight: 200 })).toThrow(RangeError);
    expect(() => createTerrainGenerator(SEED, { mountainAmplitude: 500 })).toThrow(RangeError);
  });

  it('exposes the effective options to callers', () => {
    const custom = createTerrainGenerator(SEED, { caves: false, seaLevel: 50 });
    expect(custom.options.caves).toBe(false);
    expect(custom.options.seaLevel).toBe(50);
    expect(custom.options.ores).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 并发使用
// ---------------------------------------------------------------------------

describe('shared instance', () => {
  it('does not accumulate state between interleaved chunks', () => {
    const shared = createTerrainGenerator(SEED);
    const interleaved: RecordingTarget[] = [];
    for (let index = 0; index < 6; index += 1) {
      interleaved.push(generateChunk(shared, index - 3, 2));
      generateChunk(shared, 10 + index, -6);
    }

    const fresh = createTerrainGenerator(SEED);
    for (let index = 0; index < 6; index += 1) {
      expect(interleaved[index]?.blocks).toEqual(generateChunk(fresh, index - 3, 2).blocks);
    }
  });

  it('generates the same chunk from a generator created by the flat factory shape', () => {
    const factory: (seed: number) => TerrainGenerator = createTerrainGenerator;
    expect(generateChunk(factory(SEED), 1, 1).blocks).toEqual(
      generateChunk(generator, 1, 1).blocks,
    );
  });
});
