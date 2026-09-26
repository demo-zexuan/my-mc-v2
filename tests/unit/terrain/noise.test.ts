import { describe, expect, it } from 'vitest';

import {
  domainWarp2,
  fbm2,
  fbm3,
  GradientNoise,
  hashCoordinates,
  hashToSigned,
  hashToUnit,
  ridged2,
  SeededRandom,
  deriveSeed,
} from '@/terrain/Noise';

/**
 * 噪声层的测试。
 *
 * I. 测试重点的取舍
 *
 * 1. 噪声不追求"数值精确"（那等于把实现抄一遍），而是钉住四条对世界有意义的性质：
 *    同种子可复现、值域被夹在 `[-1, 1]`、统计上像噪声（均值接近 0、方差不为 0）、
 *    以及连续（相邻采样不会跳变，否则地形会出现刀切一样的断崖）。
 * 2. 分布断言全部给足区间：它们是"这条性质还在"的守卫，不是精确回归测试。
 */

/** 采样统计量。 */
interface Stats {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly deviation: number;
}

function collect(samples: readonly number[]): Stats {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let sumSquares = 0;
  for (const value of samples) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    sumSquares += value * value;
  }
  const mean = sum / samples.length;
  return {
    min,
    max,
    mean,
    deviation: Math.sqrt(Math.max(0, sumSquares / samples.length - mean * mean)),
  };
}

describe('SeededRandom', () => {
  it('replays the exact same sequence for the same seed', () => {
    const first = new SeededRandom(20240607);
    const second = new SeededRandom(20240607);
    const firstRun = Array.from({ length: 16 }, () => first.nextUint32());
    const secondRun = Array.from({ length: 16 }, () => second.nextUint32());

    expect(firstRun).toEqual(secondRun);
  });

  it('produces different sequences for adjacent seeds', () => {
    const first = new SeededRandom(1);
    const second = new SeededRandom(2);
    const firstRun = Array.from({ length: 16 }, () => first.nextUint32());
    const secondRun = Array.from({ length: 16 }, () => second.nextUint32());

    expect(firstRun).not.toEqual(secondRun);
    // 只有一个数偶然相同是允许的，但整体不能相关。
    const matches = firstRun.filter((value, index) => value === secondRun[index]).length;
    expect(matches).toBeLessThan(3);
  });

  it('stays inside the documented ranges', () => {
    const random = new SeededRandom(7);
    for (let index = 0; index < 500; index += 1) {
      const uint32 = random.nextUint32();
      expect(Number.isInteger(uint32)).toBe(true);
      expect(uint32).toBeGreaterThanOrEqual(0);
      expect(uint32).toBeLessThan(2 ** 32);

      const float = random.nextFloat();
      expect(float).toBeGreaterThanOrEqual(0);
      expect(float).toBeLessThan(1);
    }
  });

  it('returns integers below the requested bound', () => {
    const random = new SeededRandom(99);
    const counts = new Map<number, number>();
    for (let index = 0; index < 3000; index += 1) {
      const value = random.nextInt(5);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    // 五个桶的期望值都是 600；只要没有桶被系统性跳过或暴涨即可。
    for (const bucket of [0, 1, 2, 3, 4]) {
      const count = counts.get(bucket) ?? 0;
      expect(count).toBeGreaterThan(400);
      expect(count).toBeLessThan(800);
    }
  });

  it('rejects a non-positive bound', () => {
    const random = new SeededRandom(1);
    expect(() => random.nextInt(0)).toThrow(RangeError);
    expect(() => random.nextInt(-3)).toThrow(RangeError);
  });
});

describe('hashCoordinates', () => {
  it('is a pure function of the coordinate', () => {
    expect(hashCoordinates(7, 3, 5, 9)).toBe(hashCoordinates(7, 3, 5, 9));
    expect(hashCoordinates(7, 3, 5, 9)).not.toBe(hashCoordinates(7, 3, 5, 10));
    expect(hashCoordinates(7, 3, 5, 9)).not.toBe(hashCoordinates(8, 3, 5, 9));
    // 负坐标也必须落在合法范围里，否则下游的 `%` 会得到负数。
    expect(hashCoordinates(7, -3, 5, -9)).toBeGreaterThanOrEqual(0);
  });

  it('spreads values evenly across buckets', () => {
    const buckets = new Array<number>(16).fill(0);
    for (let index = 0; index < 8192; index += 1) {
      const x = index % 128;
      const z = Math.floor(index / 128);
      const unit = hashToUnit(hashCoordinates(4242, x, 3, z));
      expect(unit).toBeGreaterThanOrEqual(0);
      expect(unit).toBeLessThan(1);
      const bucket = Math.min(15, Math.floor(unit * 16));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const count of buckets) {
      // 期望 512；留出约 5 倍标准差的余量，避免变成一个伪随机测试。
      expect(count).toBeGreaterThan(330);
      expect(count).toBeLessThan(700);
    }
  });

  it('maps to both signs', () => {
    const signed = hashToSigned(hashCoordinates(11, 1, 2, 3));
    expect(signed).toBeGreaterThanOrEqual(-1);
    expect(signed).toBeLessThan(1);
  });

  it('derives decorrelated sub-seeds', () => {
    const derived = Array.from({ length: 13 }, (_, slot) => deriveSeed(1234, slot));
    expect(new Set(derived).size).toBe(derived.length);
    expect(derived).not.toContain(1234);
  });
});

describe('GradientNoise', () => {
  const seed = 2024;
  const noise = new GradientNoise(seed);

  it('repeats the same values for the same seed and coordinate', () => {
    const repeat = new GradientNoise(seed);
    for (let index = 0; index < 64; index += 1) {
      const x = index * 0.37;
      const z = index * -0.71;
      expect(noise.noise2(x, z)).toBe(repeat.noise2(x, z));
      expect(noise.noise3(x, 0.5, z)).toBe(repeat.noise3(x, 0.5, z));
    }
  });

  it('changes the field when the seed changes', () => {
    const other = new GradientNoise(seed + 1);
    let differences = 0;
    for (let index = 0; index < 256; index += 1) {
      if (noise.noise2(index * 0.31, index * 0.17) !== other.noise2(index * 0.31, index * 0.17)) {
        differences += 1;
      }
    }
    expect(differences).toBeGreaterThan(250);
  });

  it('vanishes on every integer lattice point', () => {
    for (let x = -4; x <= 4; x += 1) {
      for (let z = -4; z <= 4; z += 1) {
        // 用 `toBeCloseTo` 而不是 `toBe(0)`：梯度点积可能算出 `-0`，
        // 而 `Object.is(-0, 0)` 为 false。
        expect(noise.noise2(x, z)).toBeCloseTo(0, 12);
      }
    }
  });

  it('stays within [-1, 1] and looks like noise in 2D', () => {
    const samples: number[] = [];
    for (let x = -90; x < 90; x += 1) {
      for (let z = -90; z < 90; z += 1) {
        samples.push(noise.noise2(x * 0.41, z * 0.41));
      }
    }
    const stats = collect(samples);
    expect(stats.min).toBeGreaterThanOrEqual(-1);
    expect(stats.max).toBeLessThanOrEqual(1);
    expect(Math.abs(stats.mean)).toBeLessThan(0.05);
    expect(stats.deviation).toBeGreaterThan(0.15);
    expect(stats.deviation).toBeLessThan(0.45);
  });

  it('stays within [-1, 1] and looks like noise in 3D', () => {
    const samples: number[] = [];
    for (let x = -40; x < 40; x += 1) {
      for (let y = 0; y < 60; y += 1) {
        for (let z = -40; z < 40; z += 1) {
          samples.push(noise.noise3(x * 0.23, y * 0.47, z * 0.23));
        }
      }
    }
    const stats = collect(samples);
    expect(stats.min).toBeGreaterThanOrEqual(-1);
    expect(stats.max).toBeLessThanOrEqual(1);
    expect(Math.abs(stats.mean)).toBeLessThan(0.05);
    expect(stats.deviation).toBeGreaterThan(0.15);
    expect(stats.deviation).toBeLessThan(0.45);
  });

  it('is continuous, including across cell boundaries', () => {
    const step = 0.02;
    let previous = noise.noise2(-2.0, 1.37);
    for (let x = -2.0; x <= 3.0; x += step) {
      const current = noise.noise2(x, 1.37);
      // 每个小步长内的变化必须是微小的；跨整数格点时同样成立，否则地形会断层。
      expect(Math.abs(current - previous)).toBeLessThan(0.1);
      previous = current;
    }
  });
});

describe('fbm2', () => {
  const noise = new GradientNoise(31337);

  it('returns the underlying noise when there is a single octave', () => {
    const x = 12.7;
    const z = -3.3;
    expect(fbm2(noise, x, z, { octaves: 1, frequency: 1, lacunarity: 2, gain: 0.5 })).toBeCloseTo(
      noise.noise2(x, z),
      12,
    );
  });

  it('stays inside [-1, 1] with a believable distribution', () => {
    const samples: number[] = [];
    for (let x = -60; x < 60; x += 1) {
      for (let z = -60; z < 60; z += 1) {
        samples.push(
          fbm2(noise, x, z, { octaves: 5, frequency: 1 / 48, lacunarity: 2, gain: 0.5 }),
        );
      }
    }
    const stats = collect(samples);
    expect(stats.min).toBeGreaterThanOrEqual(-1);
    expect(stats.max).toBeLessThanOrEqual(1);
    expect(Math.abs(stats.mean)).toBeLessThan(0.05);
    expect(stats.deviation).toBeGreaterThan(0.05);
    expect(stats.deviation).toBeLessThan(0.4);
  });

  it('adds detail as octaves grow', () => {
    let smoothVariation = 0;
    let detailedVariation = 0;
    let previousSmooth = fbm2(noise, -40, 9.5, {
      octaves: 1,
      frequency: 1 / 32,
      lacunarity: 2,
      gain: 0.5,
    });
    let previousDetailed = fbm2(noise, -40, 9.5, {
      octaves: 6,
      frequency: 1 / 32,
      lacunarity: 2,
      gain: 0.5,
    });
    for (let x = -40; x <= 40; x += 1) {
      const smooth = fbm2(noise, x, 9.5, {
        octaves: 1,
        frequency: 1 / 32,
        lacunarity: 2,
        gain: 0.5,
      });
      const detailed = fbm2(noise, x, 9.5, {
        octaves: 6,
        frequency: 1 / 32,
        lacunarity: 2,
        gain: 0.5,
      });
      smoothVariation += Math.abs(smooth - previousSmooth);
      detailedVariation += Math.abs(detailed - previousDetailed);
      previousSmooth = smooth;
      previousDetailed = detailed;
    }
    expect(detailedVariation).toBeGreaterThan(smoothVariation);
  });

  it('handles the degenerate octave count without dividing by zero', () => {
    expect(fbm2(noise, 1.5, 2.5, { octaves: 0, frequency: 1, lacunarity: 2, gain: 0.5 })).toBe(0);
    expect(fbm3(noise, 1.5, 2.5, 3.5, { octaves: 0, frequency: 1, lacunarity: 2, gain: 0.5 })).toBe(
      0,
    );
  });
});

describe('ridged2', () => {
  const noise = new GradientNoise(555);

  it('stays inside [0, 1] and puts most of the world off-ridge', () => {
    const samples: number[] = [];
    for (let x = -60; x < 60; x += 1) {
      for (let z = -60; z < 60; z += 1) {
        samples.push(
          ridged2(noise, x, z, { octaves: 4, frequency: 1 / 40, lacunarity: 2, gain: 0.45 }),
        );
      }
    }
    const stats = collect(samples);
    expect(stats.min).toBeGreaterThanOrEqual(0);
    expect(stats.max).toBeLessThanOrEqual(1);
    // 山脊应当是稀疏的：均值明显低于 0.5，否则整片内陆都会被抬成高原。
    expect(stats.mean).toBeGreaterThan(0.05);
    expect(stats.mean).toBeLessThan(0.55);
    expect(stats.max).toBeGreaterThan(0.7);
  });
});

describe('domainWarp2', () => {
  const noise = new GradientNoise(8080);

  it('displaces the sample point deterministically', () => {
    const first = domainWarp2(noise, 120.5, -64.25, 30, 1 / 400);
    const second = domainWarp2(noise, 120.5, -64.25, 30, 1 / 400);
    expect(first).toEqual(second);
    expect(first.x).not.toBe(120.5);
    expect(first.y).not.toBe(-64.25);
  });

  it('never displaces more than the requested strength', () => {
    const strength = 25;
    for (let index = 0; index < 200; index += 1) {
      const x = index * 13.5;
      const z = index * -7.25;
      const warped = domainWarp2(noise, x, z, strength, 1 / 300);
      expect(Math.abs(warped.x - x)).toBeLessThanOrEqual(strength);
      expect(Math.abs(warped.y - z)).toBeLessThanOrEqual(strength);
    }
  });

  it('decorrelates the two displacement axes', () => {
    // 交换参数得到的第二路位移必须与第一路不同，否则扭曲会退化成整体平移。
    let different = 0;
    for (let index = 0; index < 200; index += 1) {
      const x = index * 11.7;
      const z = index * 5.3;
      if (noise.noise2(x / 620, z / 620) !== noise.noise2(z / 620, x / 620)) {
        different += 1;
      }
    }
    expect(different).toBeGreaterThan(190);
  });
});
