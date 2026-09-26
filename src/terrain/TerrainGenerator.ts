/**
 * 体素地形生成器。
 *
 * I. 生成流水线
 *
 * 1. 基础地形（每个区块 16x16 根柱子）
 *    (1) 用大陆度、侵蚀度、山脊三层低频 FBM 计算柱子的地表高度 `groundTop`。
 *    (2) 从 Y=0 往上逐格填充：基岩 -> 石头 -> 泥土/沙/雪表层 -> 水（海平面以下）。
 *    (3) 地表以下按 3D 噪声挖洞穴。
 * 2. 矿脉：以 5x5x5 的整数格为单元，单元哈希决定是否成脉、成什么脉、脉心在哪，
 *    再按"只替换石头"的规则写入。
 * 3. 地表装饰：6x6 的特征网格决定树的候选位置与树种，树干与树冠按世界坐标写入。
 *
 * II. 确定性（本模块最重要的性质）
 *
 * 1. `generate(cx, cz, target)` 是 `(seed, cx, cz)` 的纯函数：
 *    (1) 所有随机性来自 {@link hashCoordinates} 或构造期洗好的噪声置换表，
 *        没有 `Math.random`、没有 `Date.now`、没有迭代顺序依赖。
 *    (2) 生成器实例在构造后不再被写入，`generate` 只用调用内的局部状态，
 *        因此同一个实例可以在多个 worker 里并发使用。
 *    (3) 区块 A、B 无论按什么顺序生成，结果都逐字节相同。
 * 2. 地表高度只有一份实现（`#sampleColumn`），`generate`、`surfaceHeightAt`
 *    与 `biomeAt` 都走它，所以"出生点高度"与"实际地形"不可能对不上；顺带每根
 *    柱子的噪声也只算一遍。
 *
 * III. 跨区块特征（树为什么不会被截断或重复）
 *
 * 1. 树的候选位置来自世界坐标对齐的特征网格：每个 6x6 单元独立掷骰，
 *    结论只取决于 `(treeSeed, cellX, cellZ)`，与"谁在生成哪个区块"无关。
 * 2. 生成区块 B 时会扫描覆盖 `B + 树冠半径` 的所有单元，因此树干在 A、树冠伸进
 *    B 的那棵树，会被 A、B 各自的镜像分别写入各自那一半。
 * 3. 每次写入都先换算成"未折叠的区块内坐标"（可能是 -2 或 18），超出当前区块的
 *    写入被 {@link ChunkWriter} 直接丢弃 —— 那部分由邻居区块自己写。这样既不依赖
 *    目标实现是否做边界检查，也保证每个方块恰好被一个区块写一次。
 *
 * IV. 性能
 *
 * 1. 单区块 32768 格，预算 8ms 以内（Web Worker 按区块切分任务）。
 * 2. 热路径上的三个取舍：
 *    (1) 每根柱子只算一次噪声，高度、群系、材质、结冰复用同一组中间量；
 *    (2) 洞穴噪声只在地表以下到基岩之间的 Y 区间采样，且跳过水下柱子；
 *    (3) 矿脉按 5 格单元触发（每区块约 700 次整数哈希），不是每个石头都算 3D 噪声。
 *
 * @module terrain/TerrainGenerator
 */

import { BlockId } from '@/world/BlockRegistry';
import {
  CHUNK_SIZE_X,
  CHUNK_SIZE_Y,
  CHUNK_SIZE_Z,
  CHUNK_VOLUME,
  indexInChunk,
} from '@/world/coords';

import { clamp, clamp01, smoothCurve, smoothstep } from './math';
import {
  deriveSeed,
  domainWarp2,
  fbm2,
  GradientNoise,
  hashCoordinates,
  hashToUnit,
  ridged2,
  type FbmOptions,
} from './Noise';
import type {
  BiomeId,
  ChunkDataTarget,
  TerrainGenerator,
  TerrainGeneratorFactory,
  TerrainOptions,
} from './types';

// ---------------------------------------------------------------------------
// 默认参数与调参常量
// ---------------------------------------------------------------------------

/** 海平面默认值。与 `TerrainOptions.seaLevel` 的文档保持一致。 */
const DEFAULT_SEA_LEVEL = 62;
/** 平坦地形平均高度默认值。 */
const DEFAULT_BASE_HEIGHT = 68;
/** 山脉最大抬升默认值。 */
const DEFAULT_MOUNTAIN_AMPLITUDE = 26;

/**
 * 各噪声场的 FBM 参数。
 *
 * I. 为什么频率写成 `1 / 波长`
 *
 * 地形调参时的直觉单位是"这块地貌有多大"，而不是"每格变化多少"。写成 `1 / 384`
 * 之后可以直接读作"波长 384 格的大陆"，改参数时不必在脑子里取倒数。
 *
 * II. 各层的分工
 *
 * 1. `continent` —— 波长最长，决定海洋与陆地，是唯一被域扭曲的层。
 * 2. `erosion` —— 决定"平坦还是崎岖"，同时控制丘陵振幅与山脉遮罩。
 * 3. `ridge` —— 山脊噪声，只在遮罩打开的地方生效。
 * 4. `hills` / `detail` —— 中高频细节，让平地不至于像一块板。
 * 5. `temperature` / `moisture` —— 只参与生物群系分类，不影响高度。
 */
const FBM = {
  continent: { octaves: 5, frequency: 1 / 384, lacunarity: 2, gain: 0.5 },
  erosion: { octaves: 4, frequency: 1 / 208, lacunarity: 2, gain: 0.5 },
  ridge: { octaves: 4, frequency: 1 / 168, lacunarity: 2, gain: 0.45 },
  hills: { octaves: 3, frequency: 1 / 72, lacunarity: 2, gain: 0.5 },
  detail: { octaves: 2, frequency: 1 / 26, lacunarity: 2, gain: 0.5 },
  temperature: { octaves: 3, frequency: 1 / 512, lacunarity: 2, gain: 0.5 },
  moisture: { octaves: 3, frequency: 1 / 288, lacunarity: 2, gain: 0.5 },
} as const satisfies Record<string, FbmOptions>;

/** 大陆度增益。FBM 实测极值约 ±0.44，乘它之后深海与内陆都有足够样本。 */
const CONTINENT_GAIN = 2.2;
/** 域扭曲的位移强度（格）与频率。 */
const CONTINENT_WARP_STRENGTH = 42;
const CONTINENT_WARP_FREQUENCY = 1 / 620;
/** 大陆度低于该值算海洋；高于 {@link INLAND_EDGE} 算内陆。 */
const OCEAN_EDGE = -0.15;
const INLAND_EDGE = 0.15;
/** 深海对应的另一侧端点，用于把大陆度归一化成海底深度。 */
const DEEP_OCEAN_EDGE = -0.85;
/** 深海平原相对海平面的最大深度（格）。 */
const OCEAN_DEPTH = 20;
/** 深海海底使用砾石而非沙子的深度界线。 */
const GRAVEL_FLOOR_DEPTH = 9;
/** 丘陵最大振幅。 */
const HILL_AMPLITUDE = 14;
/** 山脉遮罩：大陆度与平坦度的两端（都不依赖海岸线抬升的那条窄带）。 */
const MOUNTAIN_CONTINENT_START = 0.12;
const MOUNTAIN_CONTINENT_FULL = 0.5;
const MOUNTAIN_FLATNESS_START = 0.62;
const MOUNTAIN_FLATNESS_FULL = 0.2;
/** 高频细节振幅（格）。 */
const DETAIL_AMPLITUDE = 1.6;
/** 海平面之上多少格以内算沙滩。 */
const BEACH_BAND = 1;
/** 地表高出 baseHeight 多少格算山地。 */
const MOUNTAIN_LINE_OFFSET = 8;
/** 绝对雪线，以及"太冷"的温度阈值。 */
const SNOW_LINE = 88;
const SNOW_TEMPERATURE = -0.28;
/** 湿润度高于该值算森林，否则算平原。 */
const FOREST_MOISTURE = 0.02;
/** 平坦度低于该值算丘陵。 */
const HILL_FLATNESS = 0.45;

/** 基岩层最大厚度（含 Y=0）。 */
const BEDROCK_MAX_DEPTH = 3;
/** 洞穴噪声频率（波长约 26 格）与垂直压缩系数。 */
const CAVE_FREQUENCY = 1 / 26;
const CAVE_VERTICAL_SQUASH = 2;
/** 洞穴判定阈值：两路噪声的平方和小于它就掏空，值越大洞越粗。 */
const CAVE_RADIUS_SQUARED = 0.0045;
/** 地表以下几格之内不挖洞，避免地表出现朝天的大洞。 */
const CAVE_SURFACE_GUARD = 4;

/** 矿脉单元边长（格）。 */
const ORE_CELL_SIZE = 5;
/** 矿脉最大半径，决定扫描范围要向外扩多少格。 */
const ORE_MAX_RADIUS = 2;
/** 单个矿脉单元的成脉概率。 */
const ORE_CELL_CHANCE = 0.2;
/** 从 32 位哈希的最高字节取出 `[0, 1)` 上的均匀数，用于加权抽取。 */
const TOP_BYTE_TO_UNIT = 1 / 256;

/** 树的特征网格边长（格）。 */
const TREE_CELL_SIZE = 6;
/** 树冠最大水平半径，决定扫描范围要向外扩多少格。 */
const TREE_CANOPY_RADIUS = 2;

/** 一格方块柱的材质方案。 */
interface SurfaceMaterial {
  /** 地表那一格的方块。 */
  readonly surface: BlockId;
  /** 地表以下若干格的方块。 */
  readonly subSurface: BlockId;
  /** 表层总厚度（含地表格）；0 表示直接裸露石头。 */
  readonly soilDepth: number;
}

/** 生物群系到材质的映射。 */
const SURFACE_MATERIALS = {
  ocean: { surface: BlockId.Sand, subSurface: BlockId.Sandstone, soilDepth: 2 },
  beach: { surface: BlockId.Sand, subSurface: BlockId.Sandstone, soilDepth: 3 },
  plains: { surface: BlockId.Grass, subSurface: BlockId.Dirt, soilDepth: 3 },
  forest: { surface: BlockId.Grass, subSurface: BlockId.Dirt, soilDepth: 3 },
  hills: { surface: BlockId.Grass, subSurface: BlockId.Dirt, soilDepth: 3 },
  mountains: { surface: BlockId.Stone, subSurface: BlockId.Stone, soilDepth: 0 },
  snow: { surface: BlockId.Snow, subSurface: BlockId.Dirt, soilDepth: 3 },
} as const satisfies Record<BiomeId, SurfaceMaterial>;

/** 深海海底材质（砾石），替代 {@link SURFACE_MATERIALS} 里的海洋方案。 */
const DEEP_OCEAN_MATERIAL: SurfaceMaterial = {
  surface: BlockId.Gravel,
  subSurface: BlockId.Gravel,
  soilDepth: 1,
};

/** 每个生物群系的成树概率。 */
const TREE_DENSITY = {
  ocean: 0,
  beach: 0.03,
  plains: 0.09,
  forest: 0.62,
  hills: 0.22,
  mountains: 0,
  snow: 0.11,
} as const satisfies Record<BiomeId, number>;

/** 每个生物群系的树干基础高度（格）。 */
const TREE_TRUNK_HEIGHT = {
  ocean: 4,
  beach: 4,
  plains: 4,
  forest: 6,
  hills: 5,
  mountains: 4,
  snow: 7,
} as const satisfies Record<BiomeId, number>;

/** 一种矿脉的深度与权重定义。 */
interface OreBand {
  readonly id: BlockId;
  /** 脉心允许出现的最高 Y（含）。 */
  readonly maxY: number;
  /** 参与加权抽取的权重。 */
  readonly weight: number;
  /** 脉半径。 */
  readonly radius: number;
}

/**
 * 矿脉分层表，按 `maxY` 从小到大排列。
 *
 * I. 为什么用"按深度加权抽一种"而不是"每种矿物各掷一次骰子"
 *
 * 1. 各掷一次会让同一位置可能同时满足多种矿物，必须再定优先级，规则会变得隐晦。
 * 2. 加权抽取把"浅层只有煤、深处四种都有"变成一张表，调稀有度只要改权重。
 */
const ORE_BANDS: readonly OreBand[] = [
  { id: BlockId.DiamondOre, maxY: 16, weight: 0.14, radius: 1 },
  { id: BlockId.GoldOre, maxY: 32, weight: 0.26, radius: 1 },
  { id: BlockId.IronOre, maxY: 64, weight: 0.4, radius: 1 },
  { id: BlockId.CoalOre, maxY: 112, weight: 1, radius: 1 },
];

/** 各用途派生子种子的序号。新增用途时只能追加，否则旧世界会变形。 */
const SEED_SLOT = {
  continent: 1,
  continentWarp: 2,
  erosion: 3,
  ridge: 4,
  hills: 5,
  detail: 6,
  temperature: 7,
  moisture: 8,
  caveA: 9,
  caveB: 10,
  tree: 11,
  ore: 12,
  bedrock: 13,
} as const;

// ---------------------------------------------------------------------------
// 单次生成的写缓冲
// ---------------------------------------------------------------------------

/** 判断区块内坐标是否落在区块内。 */
function isInsideChunk(lx: number, y: number, lz: number): boolean {
  return lx >= 0 && lx < CHUNK_SIZE_X && lz >= 0 && lz < CHUNK_SIZE_Z && y >= 0 && y < CHUNK_SIZE_Y;
}

/**
 * 一次 `generate` 调用专用的写入器。
 *
 * I. 为什么要有本地镜像
 *
 * 1. 矿脉只能长在石头里、树冠不能盖住树干、树冠不能啃掉地表 —— 这些判断都需要
 *    "回读已经写下的方块"。`ChunkDataTarget` 是只写接口（worker 里它可能直接包着
 *    一块待传输的 `Uint8Array`），没有读的能力，所以在调用内维护一份 32KB 镜像。
 * 2. 镜像的生命周期严格等于一次调用：生成器本身仍然没有跨区块可变状态，
 *    多 worker 并发调用不会互相污染。
 *
 * II. 越界坐标在这里被吃掉
 *
 * 世界坐标换算成区块内坐标时不做折叠（`worldX - originX` 可能等于 -2 或 18），
 * 越界的写入直接丢弃，由拥有那一格的邻居区块自己写。这样生成器不依赖目标实现
 * 是否做边界检查，同时保证同一格恰好被一个区块写一次。
 */
class ChunkWriter {
  readonly #target: ChunkDataTarget;
  readonly #blocks: Uint8Array;
  readonly #originX: number;
  readonly #originZ: number;

  public constructor(target: ChunkDataTarget, cx: number, cz: number) {
    this.#target = target;
    this.#blocks = new Uint8Array(CHUNK_VOLUME);
    this.#originX = cx * CHUNK_SIZE_X;
    this.#originZ = cz * CHUNK_SIZE_Z;
  }

  /**
   * 写入一个坐标已知合法的方块。
   *
   * @param lx - 区块内 X，调用方保证在 `0 .. 15`。
   * @param y - 世界 Y，调用方保证在 `0 .. 127`。
   * @param lz - 区块内 Z，调用方保证在 `0 .. 15`。
   * @param id - 方块 id。
   */
  public setLocal(lx: number, y: number, lz: number, id: BlockId): void {
    this.#blocks[indexInChunk(lx, y, lz)] = id;
    this.#target.setBlock(lx, y, lz, id);
  }

  /**
   * 用世界坐标写入一个方块，越界时静默丢弃。
   *
   * @param worldX - 世界 X。
   * @param y - 世界 Y。
   * @param worldZ - 世界 Z。
   * @param id - 方块 id。
   */
  public setWorld(worldX: number, y: number, worldZ: number, id: BlockId): void {
    const lx = worldX - this.#originX;
    const lz = worldZ - this.#originZ;
    if (!isInsideChunk(lx, y, lz)) {
      return;
    }
    this.#blocks[indexInChunk(lx, y, lz)] = id;
    this.#target.setBlock(lx, y, lz, id);
  }

  /**
   * 读取镜像里的方块。
   *
   * 越界（含 `y < 0`）一律返回空气：对调用方来说"空气"就等于"这里可以放东西"，
   * 于是越界写入自然退化成"不覆盖"，不必让每个调用点自己判断边界。
   *
   * @param worldX - 世界 X。
   * @param y - 世界 Y。
   * @param worldZ - 世界 Z。
   */
  public blockAtWorld(worldX: number, y: number, worldZ: number): BlockId {
    const lx = worldX - this.#originX;
    const lz = worldZ - this.#originZ;
    if (!isInsideChunk(lx, y, lz)) {
      return BlockId.Air;
    }
    return (this.#blocks[indexInChunk(lx, y, lz)] ?? BlockId.Air) as BlockId;
  }

  /**
   * 只在原本是石头的位置替换成矿物。
   *
   * 这一个判断同时排除了四种情况：洞穴（空气）、基岩、水、以及地表的泥土/沙/雪/草。
   * 用镜像判断而不是重新推算，是因为镜像里已经有洞穴与地质分层的结果，重算一遍
   * 既慢又容易与基础地形产生分歧。
   *
   * @param worldX - 世界 X。
   * @param y - 世界 Y。
   * @param worldZ - 世界 Z。
   * @param id - 矿物方块 id。
   */
  public replaceStone(worldX: number, y: number, worldZ: number, id: BlockId): void {
    if (this.blockAtWorld(worldX, y, worldZ) !== BlockId.Stone) {
      return;
    }
    this.setWorld(worldX, y, worldZ, id);
  }

  /**
   * 放置树叶，只覆盖空气或已有树叶。
   *
   * 不覆盖泥土、石头、水，是为了让树冠不会在陡坡上"啃掉"一格地表；这条规则对
   * 区块边界的另一半同样成立（那半由邻居区块在自己的镜像里判断），因此无论先
   * 生成哪个区块，世界都是同一份。
   *
   * @param worldX - 世界 X。
   * @param y - 世界 Y。
   * @param worldZ - 世界 Z。
   */
  public setLeaves(worldX: number, y: number, worldZ: number): void {
    const existing = this.blockAtWorld(worldX, y, worldZ);
    if (existing !== BlockId.Air && existing !== BlockId.Leaves) {
      return;
    }
    this.setWorld(worldX, y, worldZ, BlockId.Leaves);
  }

  /**
   * 放置原木，只覆盖空气或已有树叶。
   *
   * @param worldX - 世界 X。
   * @param y - 世界 Y。
   * @param worldZ - 世界 Z。
   */
  public setLog(worldX: number, y: number, worldZ: number): void {
    const existing = this.blockAtWorld(worldX, y, worldZ);
    if (existing !== BlockId.Air && existing !== BlockId.Leaves) {
      return;
    }
    this.setWorld(worldX, y, worldZ, BlockId.Log);
  }
}

// ---------------------------------------------------------------------------
// 参数与纯函数工具
// ---------------------------------------------------------------------------

/**
 * 把可选参数补全为有效参数，并挡住会让世界无法游玩的取值。
 *
 * 导出给 {@link createFlatTerrainGenerator} 复用：两种世界类型对参数的校验与
 * 默认值必须完全一致，否则测试里改一个参数会让另一个世界的行为悄悄漂移。
 *
 * @param options - 调用方传入的可选参数。
 * @returns 补全后的参数。
 * @throws {RangeError} 当海平面、基准高度或山脉振幅超出世界高度允许的范围。
 */
export function resolveTerrainOptions(
  options: TerrainOptions | undefined,
): Required<TerrainOptions> {
  const seaLevel = options?.seaLevel ?? DEFAULT_SEA_LEVEL;
  const baseHeight = options?.baseHeight ?? DEFAULT_BASE_HEIGHT;
  const mountainAmplitude = options?.mountainAmplitude ?? DEFAULT_MOUNTAIN_AMPLITUDE;

  // 海平面贴着世界顶部时水会填满整个世界，贴着底部时海底没有空间；两者都属于
  // 调用方写错了参数，早失败比生成一个畸形世界好。
  if (!(seaLevel >= 4 && seaLevel <= CHUNK_SIZE_Y - 8)) {
    throw new RangeError(`seaLevel must be within 4..${CHUNK_SIZE_Y - 8}, received ${seaLevel}.`);
  }
  if (!(baseHeight >= 4 && baseHeight <= CHUNK_SIZE_Y - 12)) {
    throw new RangeError(
      `baseHeight must be within 4..${CHUNK_SIZE_Y - 12}, received ${baseHeight}.`,
    );
  }
  if (!(mountainAmplitude >= 0 && mountainAmplitude <= CHUNK_SIZE_Y - baseHeight - 12)) {
    throw new RangeError(
      `mountainAmplitude must leave 12 blocks of sky above baseHeight, received ${mountainAmplitude}.`,
    );
  }

  return {
    seaLevel,
    baseHeight,
    mountainAmplitude,
    caves: options?.caves ?? true,
    ores: options?.ores ?? true,
    decorations: options?.decorations ?? true,
  };
}

/** 夹到 `[-1, 1]`，用于把增益后的 FBM 值收回噪声值域。 */
function clampUnit(value: number): number {
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

/**
 * 按深度加权挑一种矿脉。
 *
 * @param roll - `[0, 1)` 上的哈希值。
 * @param y - 脉心 Y。
 * @returns 选中的矿脉；深度超出所有分层时返回 `null`。
 */
function pickOreBand(roll: number, y: number): OreBand | null {
  let total = 0;
  for (const band of ORE_BANDS) {
    if (y <= band.maxY) {
      total += band.weight;
    }
  }
  if (total <= 0) {
    return null;
  }

  let threshold = roll * total;
  for (const band of ORE_BANDS) {
    if (y > band.maxY) {
      continue;
    }
    threshold -= band.weight;
    if (threshold <= 0) {
      return band;
    }
  }
  return null;
}

/** 一根柱子的完整采样结果，避免同一次循环里重复计算噪声。 */
interface ColumnSample {
  /** 地表最高实心方块的 Y。 */
  readonly groundTop: number;
  /** 平坦度，1 表示完全平坦。 */
  readonly flatness: number;
  /** 温度，越负越冷。 */
  readonly temperature: number;
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/**
 * 基于噪声的体素地形生成器。
 *
 * 实例字段全是构造期算好的噪声表与种子，`generate` 不写任何实例状态，
 * 因此同一个实例可以被多个 worker 同时调用。
 */
class VoxelTerrainGenerator implements TerrainGenerator {
  public readonly seed: number;
  public readonly options: Required<TerrainOptions>;

  readonly #continent: GradientNoise;
  readonly #continentWarp: GradientNoise;
  readonly #erosion: GradientNoise;
  readonly #ridge: GradientNoise;
  readonly #hills: GradientNoise;
  readonly #detail: GradientNoise;
  readonly #temperature: GradientNoise;
  readonly #moisture: GradientNoise;
  readonly #caveA: GradientNoise;
  readonly #caveB: GradientNoise;
  readonly #treeSeed: number;
  readonly #oreSeed: number;
  readonly #bedrockSeed: number;

  /**
   * @param seed - 世界种子。
   * @param options - 已补全的参数。
   */
  public constructor(seed: number, options: Required<TerrainOptions>) {
    this.seed = seed;
    this.options = options;

    // 每个用途一个独立噪声实例：同一主种子派生出互不相关的置换表，避免"山脊恰好
    // 长在海岸线上"这类相关性。派生只发生在构造期，运行时零成本。
    const sub = (slot: number): GradientNoise => new GradientNoise(deriveSeed(seed, slot));

    this.#continent = sub(SEED_SLOT.continent);
    this.#continentWarp = sub(SEED_SLOT.continentWarp);
    this.#erosion = sub(SEED_SLOT.erosion);
    this.#ridge = sub(SEED_SLOT.ridge);
    this.#hills = sub(SEED_SLOT.hills);
    this.#detail = sub(SEED_SLOT.detail);
    this.#temperature = sub(SEED_SLOT.temperature);
    this.#moisture = sub(SEED_SLOT.moisture);
    this.#caveA = sub(SEED_SLOT.caveA);
    this.#caveB = sub(SEED_SLOT.caveB);

    // 特征网格用无状态整数哈希，需要的是种子本身而不是置换表。
    this.#treeSeed = deriveSeed(seed, SEED_SLOT.tree);
    this.#oreSeed = deriveSeed(seed, SEED_SLOT.ore);
    this.#bedrockSeed = deriveSeed(seed, SEED_SLOT.bedrock);
  }

  // -------------------------------------------------------------------------
  // 公开接口
  // -------------------------------------------------------------------------

  /** {@inheritDoc TerrainGenerator.generate} */
  public generate(cx: number, cz: number, target: ChunkDataTarget): void {
    const writer = new ChunkWriter(target, cx, cz);

    this.#fillBaseTerrain(cx, cz, writer);
    if (this.options.ores) {
      this.#placeOres(cx, cz, writer);
    }
    if (this.options.decorations) {
      this.#placeTrees(cx, cz, writer);
    }
  }

  /**
   * {@inheritDoc TerrainGenerator.surfaceHeightAt}
   *
   * I. "地表之上第一格空气"的口径
   *
   * 1. 不含树木等装饰：装饰是可选的（`decorations: false` 时完全不存在），把它算
   *    进来会让同一个种子的出生点随选项变化。
   * 2. 水下柱子返回 `seaLevel + 1`（水面之上），否则玩家第一次出生会被放进水里。
   */
  public surfaceHeightAt(x: number, z: number): number {
    const groundTop = this.#sampleColumn(x, z).groundTop;
    if (groundTop < this.options.seaLevel) {
      return this.options.seaLevel + 1;
    }
    return Math.min(groundTop + 1, CHUNK_SIZE_Y - 1);
  }

  /** {@inheritDoc TerrainGenerator.biomeAt} */
  public biomeAt(x: number, z: number): BiomeId {
    const sample = this.#sampleColumn(x, z);
    return this.#classifyBiome(x, z, sample);
  }

  // -------------------------------------------------------------------------
  // 柱子采样与生物群系
  // -------------------------------------------------------------------------

  /**
   * 采样一根柱子的地形参数。
   *
   * I. 以海岸线为锚点的高度剖面
   *
   * 1. 大陆度恰好等于 `OCEAN_EDGE` 时，两项修正都是 0，地表正好与海平面齐平；
   *    高于它时只有"抬升"项生效，低于它时只有"下沉"项生效。
   * 2. 这样写而不是"海底高度与陆地高度按权重插值"，是因为插值会把内陆也按海洋的
   *    低位往下拉：权重 0.35 的位置本该是陆地，插值后却沉到水下，于是出现大片
   *    一两格深的浅海（实测海洋占比会从 25% 虚高到 59%）。
   *
   * II. 三项叠加
   *
   * 1. 抬升项用 `baseHeight` 收口，使"平坦地形平均高度"这个参数名与行为一致。
   * 2. 丘陵项乘 `landness`，海里不会长出丘陵。
   * 3. 山脊项只在"内陆 + 平坦"处打开，避免海岸线上冒出尖锐山峰。
   *
   * III. 为什么要四舍五入并夹取
   *
   * 体素世界的 Y 只能是整数。夹到 `1 .. 126` 保证基岩之上还有空间，也给树冠留出
   * 生成余量（世界高度 128）。
   *
   * @param x - 世界 X。
   * @param z - 世界 Z。
   */
  #sampleColumn(x: number, z: number): ColumnSample {
    const { seaLevel, baseHeight, mountainAmplitude } = this.options;

    // I. 大陆度：低频，且被域扭曲，决定海陆与海岸线走向。
    const warped = domainWarp2(
      this.#continentWarp,
      x,
      z,
      CONTINENT_WARP_STRENGTH,
      CONTINENT_WARP_FREQUENCY,
    );
    const continent = clampUnit(
      fbm2(this.#continent, warped.x, warped.y, FBM.continent) * CONTINENT_GAIN,
    );

    // II. 把大陆度折成两段单调映射：向陆抬升、向海下沉，海岸线处两者都为 0。
    const landness = smoothCurve(clamp01((continent - OCEAN_EDGE) / (INLAND_EDGE - OCEAN_EDGE)));
    const deepness = smoothCurve(
      clamp01((OCEAN_EDGE - continent) / (OCEAN_EDGE - DEEP_OCEAN_EDGE)),
    );
    const shoreHeight = seaLevel + landness * (baseHeight - seaLevel) - deepness * OCEAN_DEPTH;

    // III. 陆地细节：侵蚀度决定丘陵振幅，山脊项只在"内陆 + 平坦"处打开。
    const flatness = clamp01(0.5 + 0.5 * fbm2(this.#erosion, x, z, FBM.erosion));
    const hills = landness * (1 - flatness) * HILL_AMPLITUDE * fbm2(this.#hills, x, z, FBM.hills);
    const mountainMask =
      smoothstep(MOUNTAIN_CONTINENT_START, MOUNTAIN_CONTINENT_FULL, continent) *
      smoothstep(MOUNTAIN_FLATNESS_START, MOUNTAIN_FLATNESS_FULL, flatness);
    const mountains = mountainMask * ridged2(this.#ridge, x, z, FBM.ridge) * mountainAmplitude;
    const height =
      shoreHeight + hills + mountains + fbm2(this.#detail, x, z, FBM.detail) * DETAIL_AMPLITUDE;

    return {
      groundTop: Math.round(clamp(height, 1, CHUNK_SIZE_Y - 2)),
      flatness,
      temperature: fbm2(this.#temperature, x, z, FBM.temperature),
    };
  }

  /**
   * 分类一根柱子的生物群系。
   *
   * I. 判定顺序即优先级
   *
   * 1. 地表在水下 -> 海洋（海底材质再按深度细分沙/砾石）。
   * 2. 紧贴水面的窄带 -> 沙滩。
   * 3. 绝对雪线之上，或温度低于阈值 -> 雪原（包含雪顶山峰）。
   * 4. 高出 baseHeight 一截 -> 山地。
   * 5. 侵蚀度低（崎岖）-> 丘陵。
   * 6. 其余按湿润度分森林与平原。
   *
   * @param x - 世界 X。
   * @param z - 世界 Z。
   * @param sample - 该柱子的采样结果，避免重复计算噪声。
   */
  #classifyBiome(x: number, z: number, sample: ColumnSample): BiomeId {
    const { seaLevel, baseHeight } = this.options;
    const groundTop = sample.groundTop;
    if (groundTop < seaLevel) {
      return 'ocean';
    }
    if (groundTop <= seaLevel + BEACH_BAND) {
      return 'beach';
    }
    if (groundTop >= SNOW_LINE || sample.temperature < SNOW_TEMPERATURE) {
      return 'snow';
    }
    if (groundTop >= baseHeight + MOUNTAIN_LINE_OFFSET) {
      return 'mountains';
    }
    if (sample.flatness < HILL_FLATNESS) {
      return 'hills';
    }
    return fbm2(this.#moisture, x, z, FBM.moisture) > FOREST_MOISTURE ? 'forest' : 'plains';
  }

  /**
   * 判断某格是否被洞穴掏空。
   *
   * I. 为什么用两路噪声的"等值面相交"
   *
   * 单路噪声取阈值得到的是球状空腔，挖出来像蜂窝。`|a| < r 且 |b| < r` 是两张曲面
   * 的相交体，形状是蜿蜒的管道 —— 这正是洞穴该有的样子，而每格只多一次噪声采样。
   *
   * II. 垂直压缩
   *
   * Y 方向采样频率乘 2，等值面更接近水平，管道因此横向延伸而不是竖直打井。
   *
   * @param x - 世界 X。
   * @param y - 世界 Y。
   * @param z - 世界 Z。
   */
  #isCarved(x: number, y: number, z: number): boolean {
    const sampleX = x * CAVE_FREQUENCY;
    const sampleY = y * CAVE_FREQUENCY * CAVE_VERTICAL_SQUASH;
    const sampleZ = z * CAVE_FREQUENCY;
    const first = this.#caveA.noise3(sampleX, sampleY, sampleZ);
    const second = this.#caveB.noise3(sampleX, sampleY, sampleZ);
    return first * first + second * second < CAVE_RADIUS_SQUARED;
  }

  // -------------------------------------------------------------------------
  // 基础地形
  // -------------------------------------------------------------------------

  /** 逐柱子填充基岩、石头、地表材质、水与洞穴。 */
  #fillBaseTerrain(cx: number, cz: number, writer: ChunkWriter): void {
    const { seaLevel } = this.options;

    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      const worldZ = cz * CHUNK_SIZE_Z + lz;
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        const worldX = cx * CHUNK_SIZE_X + lx;
        const sample = this.#sampleColumn(worldX, worldZ);
        const groundTop = sample.groundTop;
        const biome = this.#classifyBiome(worldX, worldZ, sample);
        const material = this.#materialFor(biome, groundTop);
        const bedrockDepth =
          1 + (hashCoordinates(this.#bedrockSeed, worldX, 0, worldZ) % BEDROCK_MAX_DEPTH);
        const frozen = sample.temperature < SNOW_TEMPERATURE;
        // 需要写到的最高一格：地表与海平面取大者。再往上必然是空气，不必触碰。
        const ceiling = Math.max(groundTop, seaLevel);
        // 水下柱子不挖洞：掏空海底会让海水悬空，而本项目没有流体模拟来补这个洞。
        const carveLimit =
          this.options.caves && groundTop > seaLevel ? groundTop - CAVE_SURFACE_GUARD : -1;

        for (let y = 0; y <= ceiling; y += 1) {
          let id: BlockId;
          if (y <= bedrockDepth) {
            id = BlockId.Bedrock;
          } else if (y > groundTop) {
            // 海平面以下填水；寒冷海域的最上一层结冰，让"冷"在地表看得见。
            if (y > seaLevel) {
              id = BlockId.Air;
            } else if (y === seaLevel && frozen) {
              id = BlockId.Ice;
            } else {
              id = BlockId.Water;
            }
          } else if (y <= carveLimit && this.#isCarved(worldX, y, worldZ)) {
            id = BlockId.Air;
          } else {
            const depth = groundTop - y;
            if (depth === 0) {
              id = material.surface;
            } else if (depth <= material.soilDepth) {
              id = material.subSurface;
            } else {
              id = BlockId.Stone;
            }
          }
          writer.setLocal(lx, y, lz, id);
        }
      }
    }
  }

  /** 按生物群系与深度选材质；深海海底单独换成砾石。 */
  #materialFor(biome: BiomeId, groundTop: number): SurfaceMaterial {
    if (biome === 'ocean' && groundTop <= this.options.seaLevel - GRAVEL_FLOOR_DEPTH) {
      return DEEP_OCEAN_MATERIAL;
    }
    return SURFACE_MATERIALS[biome];
  }

  // -------------------------------------------------------------------------
  // 矿脉
  // -------------------------------------------------------------------------

  /**
   * 按 5x5x5 单元铺矿脉。
   *
   * I. 为什么以单元为单位而不是逐格掷骰
   *
   * 1. 逐格掷骰挖出来的是均匀噪点，玩家永远找不到"一处矿脉"。
   * 2. 单元制天然跨区块一致：脉的存在与形状只取决于单元坐标，因此区块 A 与区块 B
   *    对同一条跨界矿脉的判断完全一致（每个区块只写自己那部分）。
   *
   * II. 扫描范围
   *
   * 脉心在单元里偏 1..3 格，加上半径会越出单元边界，因此向外多扫
   * {@link ORE_MAX_RADIUS} 格所在的单元。
   */
  #placeOres(cx: number, cz: number, writer: ChunkWriter): void {
    const minWorldX = cx * CHUNK_SIZE_X;
    const minWorldZ = cz * CHUNK_SIZE_Z;
    const firstCellX = Math.floor((minWorldX - ORE_MAX_RADIUS) / ORE_CELL_SIZE);
    const lastCellX = Math.floor((minWorldX + CHUNK_SIZE_X - 1 + ORE_MAX_RADIUS) / ORE_CELL_SIZE);
    const firstCellZ = Math.floor((minWorldZ - ORE_MAX_RADIUS) / ORE_CELL_SIZE);
    const lastCellZ = Math.floor((minWorldZ + CHUNK_SIZE_Z - 1 + ORE_MAX_RADIUS) / ORE_CELL_SIZE);
    const lastCellY = Math.floor((CHUNK_SIZE_Y - 1) / ORE_CELL_SIZE);

    for (let cellX = firstCellX; cellX <= lastCellX; cellX += 1) {
      for (let cellZ = firstCellZ; cellZ <= lastCellZ; cellZ += 1) {
        for (let cellY = 0; cellY <= lastCellY; cellY += 1) {
          const presence = hashToUnit(hashCoordinates(this.#oreSeed, cellX, cellY, cellZ));
          if (presence >= ORE_CELL_CHANCE) {
            continue;
          }

          // 同一个单元哈希派生脉心位置与矿物种类：成脉的单元每次都被完全一样地填充，
          // 与"先算哪个单元"无关。
          const shape = hashCoordinates(this.#oreSeed ^ 0x5bf03635, cellX, cellY, cellZ);
          const centerX = cellX * ORE_CELL_SIZE + 1 + (shape % 3);
          const centerY = cellY * ORE_CELL_SIZE + 1 + ((shape >>> 8) % 3);
          const centerZ = cellZ * ORE_CELL_SIZE + 1 + ((shape >>> 16) % 3);
          if (centerY < 2) {
            continue;
          }

          const band = pickOreBand((shape >>> 24) * TOP_BYTE_TO_UNIT, centerY);
          if (band === null) {
            continue;
          }
          this.#placeVein(writer, band, centerX, centerY, centerZ, shape);
        }
      }
    }
  }

  /**
   * 在脉心周围铺一小团矿物，边缘用哈希抖动，避免出现完美的椭球。
   *
   * I. 为什么三个半轴各自随机
   *
   * 只用单一半径会让所有矿脉长得一模一样（同一种形状反复出现最容易被玩家看穿）。
   * 三个半轴各自在 `{radius, radius + 1}` 里取，脉的体积就从 7 格到 33 格都有，
   * 同一深度层里既有小簇也有大脉。
   *
   * @param writer - 写入器。
   * @param band - 矿物种类与基础半径。
   * @param centerX - 脉心世界 X。
   * @param centerY - 脉心世界 Y。
   * @param centerZ - 脉心世界 Z。
   * @param shape - 决定三个半轴的单元哈希。
   */
  #placeVein(
    writer: ChunkWriter,
    band: OreBand,
    centerX: number,
    centerY: number,
    centerZ: number,
    shape: number,
  ): void {
    const radiusX = band.radius + (shape % 2);
    const radiusY = band.radius + ((shape >>> 7) % 2);
    const radiusZ = band.radius + ((shape >>> 15) % 2);
    const normX = radiusX * radiusX;
    const normY = radiusY * radiusY;
    const normZ = radiusZ * radiusZ;

    for (let dy = -radiusY; dy <= radiusY; dy += 1) {
      for (let dz = -radiusZ; dz <= radiusZ; dz += 1) {
        for (let dx = -radiusX; dx <= radiusX; dx += 1) {
          const x = centerX + dx;
          const y = centerY + dy;
          const z = centerZ + dz;
          // 椭球判定 + 哈希抖动：抖动只作用在最外一层，脉的外缘因此是毛的而不是
          // 光滑曲面，同时内层必定成矿。
          const jitter =
            hashToUnit(hashCoordinates(this.#oreSeed ^ 0x1b56c4e9, x, y, z)) * 0.5 - 0.25;
          const normalised = (dx * dx) / normX + (dy * dy) / normY + (dz * dz) / normZ;
          if (normalised > 1 + jitter) {
            continue;
          }
          writer.replaceStone(x, y, z, band.id);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 树木
  // -------------------------------------------------------------------------

  /**
   * 按 6x6 特征网格种树。
   *
   * I. 为什么用特征网格
   *
   * 1. 网格单元是"候选位"，格内偏移与是否成树都由单元哈希决定，因此每棵树的位置
   *    是世界坐标的函数，不依赖区块划分。
   * 2. 扫描范围向外扩一个树冠半径，让树冠跨界的那棵树在两侧区块里都会被算到；
   *    配合写入侧的"越界丢弃"，跨界树既不会被截断也不会被写两次。
   */
  #placeTrees(cx: number, cz: number, writer: ChunkWriter): void {
    const { seaLevel } = this.options;
    const minWorldX = cx * CHUNK_SIZE_X;
    const minWorldZ = cz * CHUNK_SIZE_Z;
    const firstCellX = Math.floor((minWorldX - TREE_CANOPY_RADIUS) / TREE_CELL_SIZE);
    const lastCellX = Math.floor(
      (minWorldX + CHUNK_SIZE_X - 1 + TREE_CANOPY_RADIUS) / TREE_CELL_SIZE,
    );
    const firstCellZ = Math.floor((minWorldZ - TREE_CANOPY_RADIUS) / TREE_CELL_SIZE);
    const lastCellZ = Math.floor(
      (minWorldZ + CHUNK_SIZE_Z - 1 + TREE_CANOPY_RADIUS) / TREE_CELL_SIZE,
    );

    for (let cellX = firstCellX; cellX <= lastCellX; cellX += 1) {
      for (let cellZ = firstCellZ; cellZ <= lastCellZ; cellZ += 1) {
        // 格内偏移刻意避开单元边缘，落在 1..4（单元边长 6）：相邻单元的树干因此至少
        // 相距 3 格，超过树冠半径 2，树冠最多在边缘互相搭接，压不到对方的树干。
        const spawn = hashCoordinates(this.#treeSeed, cellX, 0x7a11, cellZ);
        const treeX = cellX * TREE_CELL_SIZE + 1 + (spawn % (TREE_CELL_SIZE - 2));
        const treeZ = cellZ * TREE_CELL_SIZE + 1 + ((spawn >>> 8) % (TREE_CELL_SIZE - 2));

        const sample = this.#sampleColumn(treeX, treeZ);
        if (sample.groundTop <= seaLevel) {
          continue;
        }
        const biome = this.#classifyBiome(treeX, treeZ, sample);
        const density = TREE_DENSITY[biome];
        if (density <= 0) {
          continue;
        }
        const roll = hashToUnit(hashCoordinates(this.#treeSeed ^ 0x2f9a1b3d, cellX, 0x7a11, cellZ));
        if (roll >= density) {
          continue;
        }

        const shape = hashCoordinates(this.#treeSeed ^ 0x11c2e3f7, cellX, 0x7a11, cellZ);
        this.#plantTree(writer, treeX, sample.groundTop, treeZ, biome, shape);
      }
    }
  }

  /**
   * 种一棵树：先放树干，再放树冠。
   *
   * I. 形状
   *
   * 树干高由群系决定（平原 4 格、森林 6 格、雪原 7 格），哈希再加 0..1 格。树冠以
   * 树干顶端为基准向下铺三层：下面两层半径 2，最上一层半径 1，四角按经典做法削掉，
   * 再在正上方补一格。树叶不会盖住原木（见 {@link ChunkWriter.setLeaves}），因此
   * 树干不会被自家树冠吞掉。
   *
   * @param writer - 写入器。
   * @param x - 树干世界 X。
   * @param groundTop - 树干所立的地表 Y。
   * @param z - 树干世界 Z。
   * @param biome - 该处的生物群系。
   * @param shape - 决定高度与树冠摆动的哈希。
   */
  #plantTree(
    writer: ChunkWriter,
    x: number,
    groundTop: number,
    z: number,
    biome: BiomeId,
    shape: number,
  ): void {
    const trunkHeight = TREE_TRUNK_HEIGHT[biome] + (shape % 2);
    const trunkBase = groundTop + 1;
    const trunkTop = trunkBase + trunkHeight - 1;

    for (let y = trunkBase; y <= trunkTop; y += 1) {
      writer.setLog(x, y, z);
    }

    for (let offsetY = trunkHeight - 3; offsetY <= trunkHeight; offsetY += 1) {
      const radius = offsetY >= trunkHeight ? 1 : TREE_CANOPY_RADIUS;
      const y = trunkBase + offsetY;
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          // 削掉四角：整层实心会让树冠看起来像一个方块。
          if (Math.abs(dx) === radius && Math.abs(dz) === radius) {
            continue;
          }
          writer.setLeaves(x + dx, y, z + dz);
        }
      }
    }

    writer.setLeaves(x, trunkBase + trunkHeight + 1, z);
  }
}

/**
 * 创建基于噪声的地形生成器。
 *
 * @param seed - 世界种子；存档只需要它加上玩家改动过的方块。
 * @param options - 可调参数，缺省时使用 `TerrainOptions` 文档中的默认值。
 * @returns 可安全并发生成的 {@link TerrainGenerator}。
 */
export const createTerrainGenerator: TerrainGeneratorFactory = (seed, options) =>
  new VoxelTerrainGenerator(seed, resolveTerrainOptions(options));
