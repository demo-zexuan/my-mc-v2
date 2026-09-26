/**
 * 地形测试的公共夹具。
 *
 * I. 为什么要有"记录型目标"
 *
 * 1. 生成器的契约是往 {@link ChunkDataTarget} 里写方块，测试既需要拿到最终结果做
 *    断言，也需要确认它没有越界写入 —— 后者决定了同一个区块能不能被安全地喂给
 *    一块复用的 `Uint8Array`。
 * 2. 把区块拼成区域（region）是"跨区块特征"测试的前提：只有把相邻区块拼起来，
 *    才能看出树冠是被截断了还是完整地跨过了边界。
 *
 * @module tests/unit/terrain/helpers
 */

import type { BiomeId, ChunkDataTarget, TerrainGenerator } from '@/terrain/types';
import type { BlockId } from '@/world/BlockRegistry';
import {
  CHUNK_SIZE_X,
  CHUNK_SIZE_Y,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  indexInChunk,
} from '@/world/coords';

/** 记录写入内容的区块目标。 */
export class RecordingTarget implements ChunkDataTarget {
  /** 区块方块数据，索引见 {@link indexInChunk}。 */
  public readonly blocks = new Uint8Array(CHUNK_VOLUME);

  /** 越界写入次数。生成器应当始终保持为 0。 */
  public outOfRangeWrites = 0;

  /** 写入过的方块数（含重复写入同一格）。 */
  public writeCount = 0;

  public setBlock(lx: number, y: number, lz: number, id: BlockId): void {
    if (
      lx < 0 ||
      lx >= CHUNK_SIZE_X ||
      lz < 0 ||
      lz >= CHUNK_SIZE_Z ||
      y < 0 ||
      y >= CHUNK_SIZE_Y
    ) {
      this.outOfRangeWrites += 1;
      return;
    }
    this.writeCount += 1;
    this.blocks[indexInChunk(lx, y, lz)] = id;
  }

  /** 读取区块内方块，越界返回空气。 */
  public at(lx: number, y: number, lz: number): BlockId {
    if (lx < 0 || lx >= CHUNK_SIZE_X || lz < 0 || lz >= CHUNK_SIZE_Z) {
      return 0;
    }
    if (y < 0 || y >= CHUNK_SIZE_Y) {
      return 0;
    }
    return (this.blocks[indexInChunk(lx, y, lz)] ?? 0) as BlockId;
  }

  /** 统计某种方块的数量。 */
  public count(id: BlockId): number {
    let total = 0;
    for (const value of this.blocks) {
      if (value === id) {
        total += 1;
      }
    }
    return total;
  }

  /** 收集所有某种方块的坐标（区块内坐标）。 */
  public positions(id: BlockId): { lx: number; y: number; lz: number }[] {
    const found: { lx: number; y: number; lz: number }[] = [];
    for (let y = 0; y < CHUNK_SIZE_Y; y += 1) {
      for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
        for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
          if ((this.blocks[indexInChunk(lx, y, lz)] ?? 0) === id) {
            found.push({ lx, y, lz });
          }
        }
      }
    }
    return found;
  }
}

/** 生成一个区块并返回记录目标。 */
export function generateChunk(
  generator: TerrainGenerator,
  cx: number,
  cz: number,
): RecordingTarget {
  const target = new RecordingTarget();
  generator.generate(cx, cz, target);
  return target;
}

/** 由若干区块拼成的世界切片，坐标是绝对世界坐标。 */
export interface Region {
  readonly originX: number;
  readonly originZ: number;
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly blocks: Uint8Array;
  /** 读取世界坐标处的方块，越界返回空气。 */
  at(x: number, y: number, z: number): BlockId;
}

/**
 * 生成 `sizeX * sizeZ` 个区块并拼接成一个区域。
 *
 * @param generator - 地形生成器。
 * @param cx0 - 起始区块 X。
 * @param cz0 - 起始区块 Z。
 * @param sizeX - X 方向区块数。
 * @param sizeZ - Z 方向区块数。
 */
export function buildRegion(
  generator: TerrainGenerator,
  cx0: number,
  cz0: number,
  sizeX: number,
  sizeZ: number,
): Region {
  const originX = cx0 * CHUNK_SIZE_X;
  const originZ = cz0 * CHUNK_SIZE_Z;
  const width = sizeX * CHUNK_SIZE_X;
  const depth = sizeZ * CHUNK_SIZE_Z;
  const blocks = new Uint8Array(width * depth * CHUNK_SIZE_Y);

  for (let cx = cx0; cx < cx0 + sizeX; cx += 1) {
    for (let cz = cz0; cz < cz0 + sizeZ; cz += 1) {
      const chunk = generateChunk(generator, cx, cz);
      for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
        for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
          const x = cx * CHUNK_SIZE_X + lx - originX;
          const z = cz * CHUNK_SIZE_Z + lz - originZ;
          for (let y = 0; y < CHUNK_SIZE_Y; y += 1) {
            blocks[(x * depth + z) * CHUNK_SIZE_Y + y] = chunk.at(lx, y, lz);
          }
        }
      }
    }
  }

  return {
    originX,
    originZ,
    sizeX: width,
    sizeZ: depth,
    blocks,
    at(x: number, y: number, z: number): BlockId {
      const localX = x - originX;
      const localZ = z - originZ;
      if (localX < 0 || localX >= width || localZ < 0 || localZ >= depth) {
        return 0;
      }
      if (y < 0 || y >= CHUNK_SIZE_Y) {
        return 0;
      }
      return (blocks[(localX * depth + localZ) * CHUNK_SIZE_Y + y] ?? 0) as BlockId;
    },
  };
}

/** 遍历区域里所有方块坐标。 */
export function* eachColumn(region: Region): Generator<{ x: number; z: number }> {
  for (let x = 0; x < region.sizeX; x += 1) {
    for (let z = 0; z < region.sizeZ; z += 1) {
      yield { x: region.originX + x, z: region.originZ + z };
    }
  }
}

/** 统计区域内每种生物群系出现的列数。 */
export function countBiomes(
  generator: TerrainGenerator,
  from: number,
  to: number,
  step: number,
): Map<BiomeId, number> {
  const counts = new Map<BiomeId, number>();
  for (let x = from; x < to; x += step) {
    for (let z = from; z < to; z += step) {
      const biome = generator.biomeAt(x, z);
      counts.set(biome, (counts.get(biome) ?? 0) + 1);
    }
  }
  return counts;
}
