/**
 * 地形层公开入口。
 *
 * I. 为什么只在这里汇总导出
 *
 * 1. 引擎其余部分（`world`、`workers`、`app`）只关心"工厂 + 接口"，不需要知道
 *    噪声被拆成了几个文件。把导入路径固定成 `@/terrain` 之后，内部文件怎么重组
 *    都不会波及调用方。
 * 2. 需要直接使用噪声的只有测试与调试工具，它们也从这里取，避免出现两套导入路径。
 *
 * II. 不导出内部实现细节
 *
 * `ChunkWriter`、各噪声场的调参常量、`VoxelTerrainGenerator` 类都不导出：它们是
 * "改了不影响接口、但会影响世界外观"的实现细节，暴露出去只会诱导调用方依赖。
 *
 * @module terrain
 */

export { createFlatTerrainGenerator } from './FlatTerrainGenerator';
export { clamp, clamp01, lerp, smoothCurve, smoothstep } from './math';
export {
  deriveSeed,
  domainWarp2,
  fbm2,
  fbm3,
  GradientNoise,
  hashCoordinates,
  hashToSigned,
  hashToUnit,
  ridged2,
  SeededRandom,
} from './Noise';
export type { FbmOptions } from './Noise';
export { createTerrainGenerator, resolveTerrainOptions } from './TerrainGenerator';
export type {
  BiomeId,
  ChunkDataTarget,
  TerrainGenerator,
  TerrainGeneratorFactory,
  TerrainOptions,
} from './types';
