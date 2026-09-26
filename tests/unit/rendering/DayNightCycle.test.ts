import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  DayNightCycle,
  SUNRISE,
  SUNSET,
  createSkyState,
  phaseAt,
  sampleSkyState,
} from '@/rendering/Sky';

/**
 * 昼夜循环的确定性单测。
 *
 * I. 为什么相位与光照要能被断言
 *
 * 昼夜是全局状态：环境光、雾、天空、方块自发光都读同一份采样结果。如果采样只是
 * "看起来差不多"，那么调参时无法判断某次改动到底改变了什么。这里把相位边界、太阳
 * 方向的极值点和插值连续性都固定下来。
 */

describe('DayNightCycle 相位', () => {
  it('按太阳高度角划分 dawn / day / dusk / night', () => {
    // 午夜到日出之前是夜晚。
    expect(phaseAt(0)).toBe('night');
    expect(phaseAt(0.2)).toBe('night');
    // 正好日出时高度角为 0，仍然算夜晚；越过之后进入黎明。
    expect(phaseAt(SUNRISE)).toBe('night');
    expect(phaseAt(0.26)).toBe('dawn');
    expect(phaseAt(0.29)).toBe('day');
    // 正午是白天。
    expect(phaseAt(0.5)).toBe('day');
    expect(phaseAt(0.71)).toBe('day');
    // 日落前高度角降到阈值以下，进入黄昏。
    expect(phaseAt(0.73)).toBe('dusk');
    expect(phaseAt(SUNSET)).toBe('night');
    expect(phaseAt(0.8)).toBe('night');
  });

  it('相位与太阳方向一致', () => {
    for (const time of [0, 0.1, 0.25, 0.3, 0.5, 0.7, 0.75, 0.9]) {
      const state = sampleSkyState(time);
      const elevation = state.sunDirection.y;
      if (state.phase === 'day') {
        expect(elevation).toBeGreaterThan(0.15);
      }
      if (state.phase === 'night') {
        // 地平线容差 1e-6：Math.sin(Math.PI) 并不精确等于 0。
        expect(elevation).toBeLessThanOrEqual(1e-6);
      }
      if (state.phase === 'dawn' || state.phase === 'dusk') {
        expect(elevation).toBeGreaterThan(0);
        expect(elevation).toBeLessThanOrEqual(0.15);
      }
    }
  });
});

describe('DayNightCycle 太阳与光照', () => {
  it('正午太阳在正上方，午夜在正下方', () => {
    const noon = sampleSkyState(0.5).sunDirection;
    expect(noon.x).toBeCloseTo(0, 6);
    expect(noon.y).toBeCloseTo(1, 6);
    expect(noon.z).toBeCloseTo(0, 6);

    const midnight = sampleSkyState(0).sunDirection;
    expect(midnight.y).toBeCloseTo(-1, 6);
  });

  it('日出与日落时太阳在地平线上，方向始终是单位向量', () => {
    for (const time of [0, 0.1, SUNRISE, 0.4, 0.5, 0.6, SUNSET, 0.9]) {
      const state = sampleSkyState(time);
      expect(state.sunDirection.length()).toBeCloseTo(1, 6);
      expect(state.moonDirection.length()).toBeCloseTo(1, 6);
      expect(state.moonDirection.x).toBeCloseTo(-state.sunDirection.x, 6);
      expect(state.moonDirection.y).toBeCloseTo(-state.sunDirection.y, 6);
    }

    expect(sampleSkyState(SUNRISE).sunDirection.y).toBeCloseTo(0, 6);
    expect(sampleSkyState(SUNSET).sunDirection.y).toBeCloseTo(0, 6);
  });

  it('正午光照最强，午夜最弱', () => {
    expect(sampleSkyState(0.5).sunIntensity).toBeCloseTo(2.2, 6);
    expect(sampleSkyState(0).sunIntensity).toBeCloseTo(0.04, 6);
    expect(sampleSkyState(0.5).sunIntensity).toBeGreaterThan(sampleSkyState(0.3).sunIntensity);
    expect(sampleSkyState(0.3).sunIntensity).toBeGreaterThan(sampleSkyState(0.1).sunIntensity);

    // 月光只在太阳落下后起作用。
    expect(sampleSkyState(0).moonIntensity).toBeGreaterThan(0);
    expect(sampleSkyState(0.5).moonIntensity).toBe(0);
  });

  it('天空色与雾色在关键帧之间连续插值', () => {
    const noon = sampleSkyState(0.5);
    const dusk = sampleSkyState(SUNSET);

    // 日落时地平线比正午更暖：红色分量占比更高。
    const noonRatio = noon.horizonColor.r / Math.max(noon.horizonColor.b, 1e-6);
    const duskRatio = dusk.horizonColor.r / Math.max(dusk.horizonColor.b, 1e-6);
    expect(duskRatio).toBeGreaterThan(noonRatio);

    // 一天的首尾必须无缝衔接，否则天空会在绕回时跳变。
    const end = sampleSkyState(0.9999);
    const start = sampleSkyState(0);
    expect(end.zenithColor.r).toBeCloseTo(start.zenithColor.r, 2);
    expect(end.horizonColor.g).toBeCloseTo(start.horizonColor.g, 2);
    expect(end.fogColor.b).toBeCloseTo(start.fogColor.b, 2);
    expect(end.sunIntensity).toBeCloseTo(start.sunIntensity, 2);
  });

  it('采样是纯函数，可复用输出缓冲且不分配新对象', () => {
    const buffer = createSkyState();
    const first = sampleSkyState(0.42, buffer);
    const second = sampleSkyState(0.42, createSkyState());

    expect(first).toBe(buffer);
    expect(first.phase).toBe(second.phase);
    expect(first.zenithColor.getHex()).toBe(second.zenithColor.getHex());
    expect(first.horizonColor.getHex()).toBe(second.horizonColor.getHex());
    expect(first.fogColor.getHex()).toBe(second.fogColor.getHex());
    expect(first.sunIntensity).toBeCloseTo(second.sunIntensity, 12);
  });

  it('方位角只影响水平朝向，不影响正午高度', () => {
    const state = sampleSkyState(0.5, createSkyState(), 0.9);
    expect(state.sunDirection.y).toBeCloseTo(1, 6);

    const sunrise = sampleSkyState(SUNRISE, createSkyState(), Math.PI / 2);
    expect(sunrise.sunDirection.z).toBeCloseTo(1, 6);
  });
});

describe('DayNightCycle 时间推进', () => {
  it('按 dayLengthSeconds 推进并循环', () => {
    const cycle = new DayNightCycle({ dayLengthSeconds: 1200, startTime: 0 });
    expect(cycle.timeOfDay).toBe(0);

    cycle.advance(600);
    expect(cycle.timeOfDay).toBeCloseTo(0.5, 9);

    cycle.advance(900);
    expect(cycle.timeOfDay).toBeCloseTo(0.25, 9);

    // 再走一整天回到原点：0.25 + 1 折算后仍是 0.25。
    cycle.advance(1200);
    expect(cycle.timeOfDay).toBeCloseTo(0.25, 9);
  });

  it('暂停时不推进', () => {
    const cycle = new DayNightCycle({ startTime: 0.5 });
    cycle.paused = true;
    cycle.advance(600);
    expect(cycle.timeOfDay).toBeCloseTo(0.5, 9);

    // 恢复后推进半天：0.5 + 0.5 = 1，折算回 0。
    cycle.paused = false;
    cycle.advance(600);
    expect(cycle.timeOfDay).toBeCloseTo(0, 9);
  });

  it('忽略非法时间增量', () => {
    const cycle = new DayNightCycle({ startTime: 0.5 });
    cycle.advance(Number.NaN);
    cycle.advance(Number.POSITIVE_INFINITY);
    expect(cycle.timeOfDay).toBeCloseTo(0.5, 9);
  });

  it('setTime 会把任意实数折算进 [0, 1)', () => {
    const cycle = new DayNightCycle();
    cycle.setTime(1.25);
    expect(cycle.timeOfDay).toBeCloseTo(0.25, 9);
    cycle.setTime(-0.25);
    expect(cycle.timeOfDay).toBeCloseTo(0.75, 9);
  });

  it('相同配置产生相同状态', () => {
    const build = (): THREE.Vector3 => {
      const cycle = new DayNightCycle({ startTime: 0.42, dayLengthSeconds: 600 });
      cycle.advance(123);
      return cycle.state.sunDirection.clone();
    };

    expect(build().toArray()).toEqual(build().toArray());
  });
});
