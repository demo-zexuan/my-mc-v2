import { describe, expect, it } from 'vitest';

import { createFlatTerrainGenerator, createTerrainGenerator } from '@/terrain';
import { CHUNK_VOLUME } from '@/world/coords';

import { generateChunk } from './helpers';

/**
 * 地形生成的粗粒度性能守卫。
 *
 * I. 为什么断言写得这么松
 *
 * 1. 地形生成跑在 Web Worker 里，按区块切分任务，玩家的体感来自"每帧能补几个区块"。
 *    这里真正要防的是数量级的退化（比如有人把 3D 噪声从每格一次改成每格十次），
 *    而不是几毫秒的抖动。
 * 2. CI 机器与开发机的性能差着好几倍，精确阈值会变成随机红灯。25 个区块 2 秒的
 *    预算相当于单区块 80ms，比 8ms 的设计目标宽十倍，只在明显出问题时才会触发。
 *
 * II. 打印出来的数值是给人看的
 *
 * 断言只保证"没有数量级退化"，真正的单区块耗时通过 `console.warn` 输出，
 * 便于在 CI 日志里观察趋势。
 */

/** 性能守卫使用的区块数量。 */
const CHUNK_COUNT = 25;
/** 粗粒度预算：单区块 80ms，宽松到只对数量级退化报警。 */
const BUDGET_MS = 2000;

describe('terrain generation performance', () => {
  it('generates 25 chunks well inside the worker budget', () => {
    const generator = createTerrainGenerator(1337);

    // 预热：让 JIT 先编译热循环，避免把首次运行的编译时间算进去。
    generateChunk(generator, 0, 0);

    const started = performance.now();
    let written = 0;
    for (let index = 0; index < CHUNK_COUNT; index += 1) {
      const target = generateChunk(generator, index % 5, Math.floor(index / 5));
      written += target.writeCount;
    }
    const elapsed = performance.now() - started;

    // 每个区块都必须被真正填满，否则"很快"可能只是"什么都没做"。
    expect(written).toBeGreaterThan(CHUNK_COUNT * CHUNK_VOLUME * 0.1);
    console.warn(
      `terrain perf: ${CHUNK_COUNT} chunks in ${elapsed.toFixed(1)}ms ` +
        `(${(elapsed / CHUNK_COUNT).toFixed(2)}ms per chunk)`,
    );
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('keeps the flat generator as a cheaper baseline', () => {
    const flat = createFlatTerrainGenerator(1337);
    generateChunk(flat, 0, 0);

    const started = performance.now();
    for (let index = 0; index < CHUNK_COUNT; index += 1) {
      generateChunk(flat, index, -index);
    }
    const elapsed = performance.now() - started;

    console.warn(`flat perf: ${CHUNK_COUNT} chunks in ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('keeps surfaceHeightAt cheap enough for spawn search', () => {
    const generator = createTerrainGenerator(1337);
    generator.surfaceHeightAt(0, 0);

    const started = performance.now();
    for (let index = 0; index < 5000; index += 1) {
      generator.surfaceHeightAt(index * 3 - 7500, index * -2 + 5000);
    }
    const elapsed = performance.now() - started;

    console.warn(
      `surfaceHeightAt: 5000 lookups in ${elapsed.toFixed(1)}ms ` +
        `(${((elapsed * 1000) / 5000).toFixed(1)}us per lookup)`,
    );
    expect(elapsed).toBeLessThan(2000);
  });
});
