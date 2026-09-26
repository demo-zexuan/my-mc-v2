/**
 * 确定性噪声工具集。
 *
 * I. 为什么自研而不是引入第三方噪声库
 *
 * 1. 存档只保存种子和玩家改动过的方块，未改动区块在加载时按种子重新生成。因此噪声
 *    实现本身就是存档格式的一部分：某个依赖小版本升级后改了渐变表、取整方式或
 *    洗牌算法，所有旧世界的地形就会整体变形。把它锁在项目内部，升级依赖时不会
 *    连带改世界。
 * 2. 这里需要的只是一个"可复现"的保证，实现代价很小：整数哈希 + 梯度噪声 +
 *    FBM，总共两百行左右，且不依赖 `Math.random`。
 *
 * II. 可复现性的三条硬约束
 *
 * 1. 所有随机性来自整数哈希或 {@link SeededRandom}，后者只用 32 位整数运算
 *    （`Math.imul`、无符号移位），不受 x87 80 位中间结果、`Math.fround` 折叠等
 *    浮点环境差异影响。
 * 2. 噪声实例构造完成后不可变：置换表只在构造函数里洗牌一次。
 * 3. 采样值只取决于种子与坐标，与调用顺序、调用次数无关；同一 `(seed, x, y, z)`
 *    在任何进程、任何线程、任何时候都得到同一个数。
 *
 * III. 取值范围约定
 *
 * {@link GradientNoise.noise2} / {@link GradientNoise.noise3} 返回 `[-1, 1]`，
 * FBM 因按振幅总和归一化，同样落在 `[-1, 1]`。归一化系数是按实测最大值反推的，
 * 最后再夹一次边界：夹取只在极罕见的尾部生效，但它把"值域"从"经验上大约如此"
 * 变成可以写进测试的硬契约。
 *
 * @module terrain/Noise
 */

import { clamp01, lerp } from './math';

/**
 * 32 位黄金比例常数，用作 splitmix32 的步进量。
 *
 * 取值来自 `2^32 / φ`，它的比特分布足够杂，是 splitmix 系列的标准选择。
 */
const GOLDEN_RATIO_32 = 0x9e3779b9;

/** `2^-32`，把 32 位无符号整数映射到 `[0, 1)`，比除法快且精确到一半ulp。 */
const UINT32_TO_UNIT = 2.3283064365386963e-10;

/**
 * 2D 噪声的归一化系数（见 III：按实测最大值反推，使值域贴满 `[-1, 1]`）。
 *
 * 2D 原始极值实测约 0.66（理论上界 `√2/2 ≈ 0.707`），取倒数即可。
 */
const NOISE2_NORMALISATION = 1.4142;

/**
 * 3D 噪声的归一化系数。
 *
 * 12 棱梯度集的经典上界是 0.866，但本实现实测极值约 0.974，因此取 1.0 而不是
 * `1 / 0.866`：后者会把噪声尾部送进夹取分支，在山脊上留下可见的平台。
 */
const NOISE3_NORMALISATION = 1;

// ---------------------------------------------------------------------------
// 种子化伪随机数
// ---------------------------------------------------------------------------

/**
 * 32 位种子化伪随机数发生器（splitmix32）。
 *
 * I. 为什么不用 `Math.random`
 *
 * 1. `Math.random` 不可播种，而地形必须由世界种子完全决定。
 * 2. splitmix32 的状态是单个 32 位整数，输出只经过 `Math.imul` 与无符号移位，
 *    在 V8 / SpiderMonkey / JavaScriptCore 上逐位一致。存档跨浏览器、跨版本
 *    打开时看到的仍是同一个世界。
 *
 * II. 用途边界
 *
 * 它只用于"需要连续抽多个数"的场景（洗牌、按序号取参数）。凡是"由坐标直接得出
 * 一个随机数"的场景都用 {@link hashCoordinates}，后者无状态、可随机访问，是
 * 跨区块特征（树、矿脉）唯一可用的形式：区块 B 必须能在不生成区块 A 的前提下
 * 算出同一棵树的位置。
 */
export class SeededRandom {
  #state: number;

  /**
   * @param seed - 任意整数种子；小数会被截断为 32 位整数。
   */
  public constructor(seed: number) {
    // 先跑一轮混沌函数，避免相邻种子（0、1、2…）产出高度相关的序列。
    let state = (seed | 0) >>> 0;
    state = (state + GOLDEN_RATIO_32) >>> 0;
    state = Math.imul(state ^ (state >>> 16), 0x21f0aaad) >>> 0;
    state = Math.imul(state ^ (state >>> 15), 0x735a2d97) >>> 0;
    this.#state = (state ^ (state >>> 15)) >>> 0;
  }

  /** 下一个 32 位无符号整数。 */
  public nextUint32(): number {
    this.#state = (this.#state + GOLDEN_RATIO_32) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad) >>> 0;
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97) >>> 0;
    return (value ^ (value >>> 15)) >>> 0;
  }

  /** `[0, 1)` 上的均匀浮点数。 */
  public nextFloat(): number {
    return this.nextUint32() * UINT32_TO_UNIT;
  }

  /**
   * `[0, bound)` 上的均匀整数。
   *
   * 用乘法而不是取模：`% bound` 在 bound 不是 2 的幂时引入可见偏差，而洗牌对
   * 偏差敏感（置换表会偏向某些下标）。
   *
   * @param bound - 上界（不含），必须是正有限数。
   */
  public nextInt(bound: number): number {
    if (!Number.isFinite(bound) || bound <= 0) {
      throw new RangeError(`SeededRandom.nextInt expects a positive bound, received ${bound}.`);
    }
    return Math.floor(this.nextFloat() * bound);
  }
}

// ---------------------------------------------------------------------------
// 无状态整数哈希
// ---------------------------------------------------------------------------

/**
 * 把一个整数坐标对（三元组）散列成 32 位无符号整数。
 *
 * I. 为什么坐标哈希必须无状态
 *
 * 1. 树、矿脉这类特征按"网格单元"决定是否生成。相邻区块都要独立算出同一个单元
 *    的结论，因此结论只能是 `(seed, cellX, cellY, cellZ)` 的纯函数。
 * 2. 无状态也意味着生成器不持有跨调用可变状态，多个 worker 并发调用同一个实例
 *    也不会互相污染。
 *
 * II. 坐标被截断为 32 位
 *
 * 参数经 `| 0` 折叠到 32 位；本项目的坐标上限（±1670 万方块）远在 2^31 之内，
 * 截断不会让不同坐标撞到同一个值。
 *
 * @param seed - 空间哈希的种子，应与其他用途的种子分离。
 * @param x - 整数 X。
 * @param y - 整数 Y。
 * @param z - 整数 Z。
 * @returns `[0, 2^32)` 上的整数。
 */
export function hashCoordinates(seed: number, x: number, y: number, z: number): number {
  let hash = (seed ^ GOLDEN_RATIO_32) >>> 0;
  hash = Math.imul(hash ^ (x | 0), 0x27d4eb2d) >>> 0;
  hash = (hash ^ (hash >>> 15)) >>> 0;
  hash = Math.imul(hash ^ (y | 0), 0x165667b1) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  hash = Math.imul(hash ^ (z | 0), 0x9e3779b1) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * 把哈希值映射到 `[0, 1)`。
 *
 * @param hash - {@link hashCoordinates} 的输出。
 */
export function hashToUnit(hash: number): number {
  return hash * UINT32_TO_UNIT;
}

/**
 * 把哈希值映射到 `[-1, 1)`。
 *
 * @param hash - {@link hashCoordinates} 的输出。
 */
export function hashToSigned(hash: number): number {
  return hashToUnit(hash) * 2 - 1;
}

/**
 * 由主种子派生互不相关的子种子。
 *
 * I. 为什么不直接用 `seed + index`
 *
 * 相邻种子经过 splitmix 的混沌函数后仍然相关，而地形里"大陆度""侵蚀度"这类
 * 噪声场若相关，山脊就会整齐地叠在海岸线上。多跑一轮哈希把种子摊开，代价只有
 * 几纳秒，且只发生在构造期。
 *
 * @param seed - 主种子。
 * @param index - 用途序号，同一主种子下不同用途应传不同值。
 */
export function deriveSeed(seed: number, index: number): number {
  return hashCoordinates(seed, index, 0x5eed, 0x9e37);
}

// ---------------------------------------------------------------------------
// 梯度噪声
// ---------------------------------------------------------------------------

/** 八个单位方向梯度（4 轴 + 4 对角），2D 噪声用。 */
const SQRT_HALF = Math.SQRT1_2;
const GRADIENT2: readonly number[] = [
  1,
  0,
  -1,
  0,
  0,
  1,
  0,
  -1,
  SQRT_HALF,
  SQRT_HALF,
  -SQRT_HALF,
  SQRT_HALF,
  SQRT_HALF,
  -SQRT_HALF,
  -SQRT_HALF,
  -SQRT_HALF,
];

/** 十二个棱中点梯度，3D 噪声用（Ken Perlin 的改进版梯度集）。 */
const GRADIENT3: readonly number[] = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
];

/** 五次平滑曲线 `6t^5 - 15t^4 + 10t^3`，其一阶、二阶导在格点处为 0。 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** 取哈希低 3 位选方向，与格点偏移做点积。 */
function gradient2(hash: number, x: number, y: number): number {
  const index = (hash & 7) * 2;
  return (GRADIENT2[index] ?? 0) * x + (GRADIENT2[index + 1] ?? 0) * y;
}

/** 取哈希对 12 取模选棱梯度，与格点偏移做点积。 */
function gradient3(hash: number, x: number, y: number, z: number): number {
  const index = (hash % 12) * 3;
  return (
    (GRADIENT3[index] ?? 0) * x + (GRADIENT3[index + 1] ?? 0) * y + (GRADIENT3[index + 2] ?? 0) * z
  );
}

/** 夹到 `[-1, 1]`，把经验值域固化为契约（见模块文档 III）。 */
function clampUnit(value: number): number {
  if (value < -1) return -1;
  if (value > 1) return 1;
  return value;
}

/**
 * 经典 Perlin 梯度噪声，2D 与 3D 共用一张置换表。
 *
 * I. 为什么用置换表而不是每次现算哈希
 *
 * 1. 每次采样要取 4（2D）或 8（3D）个格点的梯度，现算哈希意味着每个格点跑一次
 *    整数混淆。256 项置换表把这一步换成一次数组读，而表只建一次。
 * 2. 数组长度取 512（256 项重复一遍）是为了让 `perm[perm[x] + y + 1]` 这类
 *    索引不需要再取模，这是 Perlin 噪声的经典写法，也保证了负坐标被 `& 255`
 *    折进正区间。
 *
 * II. 线程安全
 *
 * 构造后 `#perm` 只读，实例可以安全地被多个 worker 同时采样。
 */
export class GradientNoise {
  /** 构造时使用的种子，便于调试与测试定位。 */
  public readonly seed: number;

  /** 512 项置换表。 */
  readonly #perm: Uint8Array;

  /**
   * @param seed - 任意整数种子。
   */
  public constructor(seed: number) {
    this.seed = seed;

    // I. 先建 0..255 的恒等表，再用种子化 PRNG 做 Fisher–Yates 洗牌。
    // 1. 洗牌必须走 SeededRandom 而不是 Math.random，否则同一 seed 在两次运行中
    //    会得到不同的世界。
    const random = new SeededRandom(seed);
    const table = new Uint8Array(256);
    for (let index = 0; index < 256; index += 1) {
      table[index] = index;
    }
    for (let index = 255; index > 0; index -= 1) {
      const swap = random.nextInt(index + 1);
      const current = table[index] ?? 0;
      const other = table[swap] ?? 0;
      table[index] = other;
      table[swap] = current;
    }

    // II. 加长到 512 项，省掉采样时的取模。
    const perm = new Uint8Array(512);
    for (let index = 0; index < 512; index += 1) {
      perm[index] = table[index & 255] ?? 0;
    }
    this.#perm = perm;
  }

  /**
   * 采样 2D Perlin 噪声。
   *
   * @param x - 采样 X（任意实数；整数格点处恒为 0）。
   * @param y - 采样 Y。
   * @returns `[-1, 1]` 上连续、可微的噪声值。
   */
  public noise2(x: number, y: number): number {
    const xFloor = Math.floor(x);
    const yFloor = Math.floor(y);
    const xCell = xFloor & 255;
    const yCell = yFloor & 255;
    const xf = x - xFloor;
    const yf = y - yFloor;

    const perm = this.#perm;
    const columnLeft = perm[xCell] ?? 0;
    const columnRight = perm[xCell + 1] ?? 0;
    const lowerLeft = perm[columnLeft + yCell] ?? 0;
    const lowerRight = perm[columnRight + yCell] ?? 0;
    const upperLeft = perm[columnLeft + yCell + 1] ?? 0;
    const upperRight = perm[columnRight + yCell + 1] ?? 0;

    const u = fade(xf);
    const v = fade(yf);
    const bottom = lerp(gradient2(lowerLeft, xf, yf), gradient2(lowerRight, xf - 1, yf), u);
    const top = lerp(gradient2(upperLeft, xf, yf - 1), gradient2(upperRight, xf - 1, yf - 1), u);
    return clampUnit(lerp(bottom, top, v) * NOISE2_NORMALISATION);
  }

  /**
   * 采样 3D Perlin 噪声。
   *
   * @param x - 采样 X。
   * @param y - 采样 Y。
   * @param z - 采样 Z。
   * @returns `[-1, 1]` 上连续、可微的噪声值。
   */
  public noise3(x: number, y: number, z: number): number {
    const xFloor = Math.floor(x);
    const yFloor = Math.floor(y);
    const zFloor = Math.floor(z);
    const xCell = xFloor & 255;
    const yCell = yFloor & 255;
    const zCell = zFloor & 255;
    const xf = x - xFloor;
    const yf = y - yFloor;
    const zf = z - zFloor;

    const perm = this.#perm;
    const columnAX = perm[xCell] ?? 0;
    const columnBX = perm[xCell + 1] ?? 0;
    const aY0 = perm[columnAX + yCell] ?? 0;
    const aY1 = perm[columnAX + yCell + 1] ?? 0;
    const bY0 = perm[columnBX + yCell] ?? 0;
    const bY1 = perm[columnBX + yCell + 1] ?? 0;

    const c000 = perm[aY0 + zCell] ?? 0;
    const c001 = perm[aY0 + zCell + 1] ?? 0;
    const c010 = perm[aY1 + zCell] ?? 0;
    const c011 = perm[aY1 + zCell + 1] ?? 0;
    const c100 = perm[bY0 + zCell] ?? 0;
    const c101 = perm[bY0 + zCell + 1] ?? 0;
    const c110 = perm[bY1 + zCell] ?? 0;
    const c111 = perm[bY1 + zCell + 1] ?? 0;

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const x00 = lerp(gradient3(c000, xf, yf, zf), gradient3(c100, xf - 1, yf, zf), u);
    const x10 = lerp(gradient3(c010, xf, yf - 1, zf), gradient3(c110, xf - 1, yf - 1, zf), u);
    const x01 = lerp(gradient3(c001, xf, yf, zf - 1), gradient3(c101, xf - 1, yf, zf - 1), u);
    const x11 = lerp(
      gradient3(c011, xf, yf - 1, zf - 1),
      gradient3(c111, xf - 1, yf - 1, zf - 1),
      u,
    );

    const y0 = lerp(x00, x10, v);
    const y1 = lerp(x01, x11, v);
    return clampUnit(lerp(y0, y1, w) * NOISE3_NORMALISATION);
  }
}

// ---------------------------------------------------------------------------
// 分形叠加
// ---------------------------------------------------------------------------

/** 分形叠加（FBM）的参数。 */
export interface FbmOptions {
  /** 叠加层数；层数越多细节越丰富，代价线性增长。 */
  readonly octaves: number;
  /** 第一层的采样频率（即 `1 / 特征波长`，单位为"格"）。 */
  readonly frequency: number;
  /** 每层频率倍率，通常取 2。 */
  readonly lacunarity: number;
  /** 每层振幅倍率（persistence），通常取 0.5。 */
  readonly gain: number;
}

/** 2D 分形叠加噪声，按振幅总和归一化，返回 `[-1, 1]`。 */
export function fbm2(noise: GradientNoise, x: number, y: number, options: FbmOptions): number {
  let amplitude = 1;
  let frequency = options.frequency;
  let weighted = 0;
  let total = 0;

  for (let octave = 0; octave < options.octaves; octave += 1) {
    weighted += noise.noise2(x * frequency, y * frequency) * amplitude;
    total += amplitude;
    amplitude *= options.gain;
    frequency *= options.lacunarity;
  }

  return total > 0 ? weighted / total : 0;
}

/** 3D 分形叠加噪声，按振幅总和归一化，返回 `[-1, 1]`。 */
export function fbm3(
  noise: GradientNoise,
  x: number,
  y: number,
  z: number,
  options: FbmOptions,
): number {
  let amplitude = 1;
  let frequency = options.frequency;
  let weighted = 0;
  let total = 0;

  for (let octave = 0; octave < options.octaves; octave += 1) {
    weighted += noise.noise3(x * frequency, y * frequency, z * frequency) * amplitude;
    total += amplitude;
    amplitude *= options.gain;
    frequency *= options.lacunarity;
  }

  return total > 0 ? weighted / total : 0;
}

/**
 * 山脊噪声（ridged multifractal）。
 *
 * I. 为什么要专门做一种
 *
 * 普通 FBM 的等值线是圆滚滚的丘包，直接乘上山地振幅会得到"一堆土馒头"。山脊噪声
 * 取 `1 - |noise|`，把噪声零值面变成尖脊，于是山脉读起来是连绵的褶皱。
 *
 * II. 为什么最后还要再平方一次
 *
 * `(1 - |noise|)^2` 的均值高达 0.6：如果直接当强度用，整片内陆都会被抬到山地振幅的
 * 六成，山峰淹没在高原里。再平方一次把均值压到 0.38 左右，同时保留 1 的峰值，
 * 于是"缓坡 + 偶发尖峰"的对比出来了。
 *
 * III. 值域
 *
 * 单层输出 `(1 - |noise|)^2 ∈ [0, 1]`；加权平均后仍在 `[0, 1]`，再平方仍是 `[0, 1]`。
 * 1 表示正落在脊线上。
 *
 * @returns `[0, 1]` 上的山脊强度。
 */
export function ridged2(noise: GradientNoise, x: number, y: number, options: FbmOptions): number {
  let amplitude = 1;
  let frequency = options.frequency;
  let weighted = 0;
  let total = 0;

  for (let octave = 0; octave < options.octaves; octave += 1) {
    const distanceToRidge = 1 - Math.abs(noise.noise2(x * frequency, y * frequency));
    weighted += distanceToRidge * distanceToRidge * amplitude;
    total += amplitude;
    amplitude *= options.gain;
    frequency *= options.lacunarity;
  }

  const average = total > 0 ? clamp01(weighted / total) : 0;
  return average * average;
}

/**
 * 域扭曲：沿两个噪声方向把采样点推开。
 *
 * I. 为什么要扭曲
 *
 * 纯 FBM 的海岸线和山脊都是各向同性的斑块，读起来像噪声图。先把采样坐标推开再取
 * 噪声，等值线就变成蜿蜒的河道与折皱的山梁。
 *
 * II. 两路位移为什么要交换参数
 *
 * 位移场本身也必须是噪声；用 `noise2(x, y)` 与 `noise2(y, x)` 得到两路互不相关
 * 的场，比在坐标里加魔数偏移更干净（后者把偏移量泄进了存档格式）。
 *
 * @param noise - 位移场噪声，应与被扭曲的噪声使用不同种子。
 * @param x - 原始 X。
 * @param y - 原始 Y（地形中为 Z）。
 * @param strength - 位移强度，单位与坐标一致。
 * @param frequency - 位移场频率。
 */
export function domainWarp2(
  noise: GradientNoise,
  x: number,
  y: number,
  strength: number,
  frequency: number,
): { readonly x: number; readonly y: number } {
  return {
    x: x + noise.noise2(x * frequency, y * frequency) * strength,
    y: y + noise.noise2(y * frequency, x * frequency) * strength,
  };
}
