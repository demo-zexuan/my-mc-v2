/**
 * 超平坦地形生成器。
 *
 * I. 为什么需要它
 *
 * 1. 世界、网格化、物理、存档这些模块的单元测试关心的是"给定方块数据，系统怎么
 *    反应"，而不是地形好不好看。超平坦世界让测试可以直接写死坐标（"草方块上面
 *    那一格一定是空气"），不必先跑一遍噪声再从结果反推。
 * 2. 性能基准也需要一条"零噪声"基线：在它上面测出来的耗时就是纯写入与存储的代价，
 *    把地形生成的开销从网格化、序列化的开销里分离开。
 *
 * II. 与噪声生成器的关系
 *
 * 它实现同一个 {@link TerrainGenerator} 接口，所以引擎代码不必区分两者（截图测试、
 * 创造模式世界都可以直接换工厂）。世界种子不影响平坦世界的内容，`seed` 只是原样
 * 保存，好让调用方用同一个世界对象处理两种情况。
 *
 * III. 参数口径
 *
 * 只认 `seaLevel` 与 `baseHeight`：`baseHeight` 是草方块所在的 Y，`seaLevel` 高于它
 * 时上方填水。`caves` / `ores` / `decorations` 在这个生成器里没有意义（没有噪声、
 * 没有网格特征可以挂），传进来会被忽略而不是报错 —— 这样切世界类型时不必改写参数。
 *
 * @module terrain/FlatTerrainGenerator
 */

import { BlockId } from '@/world/BlockRegistry';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '@/world/coords';

import { resolveTerrainOptions } from './TerrainGenerator';
import type {
  BiomeId,
  ChunkDataTarget,
  TerrainGenerator,
  TerrainGeneratorFactory,
  TerrainOptions,
} from './types';

/** 地表以下多少格之内是泥土层（不含草方块本身）。 */
const DIRT_DEPTH = 2;

/**
 * 超平坦生成器。
 *
 * 分层固定为：基岩（Y=0）-> 石头 -> 泥土 -> 草方块；海平面更高时草方块之上填水。
 */
class FlatTerrainGenerator implements TerrainGenerator {
  public readonly seed: number;
  public readonly options: Required<TerrainOptions>;

  /**
   * @param seed - 世界种子，超平坦世界不使用它。
   * @param options - 已补全的参数。
   */
  public constructor(seed: number, options: Required<TerrainOptions>) {
    this.seed = seed;
    this.options = options;
  }

  /** {@inheritDoc TerrainGenerator.generate} */
  public generate(_cx: number, _cz: number, target: ChunkDataTarget): void {
    // 需要写到的最高一格：草方块与海平面取大者；再往上一律是空气。
    const ceiling = Math.max(this.options.baseHeight, this.options.seaLevel);

    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        for (let y = 0; y <= ceiling; y += 1) {
          target.setBlock(lx, y, lz, this.#blockAt(y));
        }
      }
    }
    // 区块坐标不参与内容：所有区块完全一样，这正是"超平坦"的定义。
  }

  /** {@inheritDoc TerrainGenerator.surfaceHeightAt} */
  public surfaceHeightAt(): number {
    const { baseHeight, seaLevel } = this.options;
    return baseHeight < seaLevel ? seaLevel + 1 : Math.min(baseHeight + 1, CHUNK_SIZE_Y - 1);
  }

  /** {@inheritDoc TerrainGenerator.biomeAt} */
  public biomeAt(): BiomeId {
    return 'plains';
  }

  /**
   * 按 Y 决定方块。
   *
   * @param y - 世界 Y。
   */
  #blockAt(y: number): BlockId {
    const { baseHeight, seaLevel } = this.options;
    if (y === 0) {
      return BlockId.Bedrock;
    }
    if (y > baseHeight) {
      return y > seaLevel ? BlockId.Air : BlockId.Water;
    }
    if (y === baseHeight) {
      return BlockId.Grass;
    }
    if (y > baseHeight - 1 - DIRT_DEPTH) {
      return BlockId.Dirt;
    }
    return BlockId.Stone;
  }
}

/**
 * 创建超平坦地形生成器。
 *
 * @param seed - 世界种子，仅原样保存。
 * @param options - 可调参数，只使用 `seaLevel` 与 `baseHeight`。
 * @returns 固定分层的 {@link TerrainGenerator}。
 */
export const createFlatTerrainGenerator: TerrainGeneratorFactory = (seed, options) =>
  new FlatTerrainGenerator(seed, resolveTerrainOptions(options));
