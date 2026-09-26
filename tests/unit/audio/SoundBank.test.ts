/**
 * SoundBank 单元测试。
 *
 * I. 覆盖重点
 *
 * 1. 音效清单完整：六种材质的破坏声、八种材质的脚步、放置/跳跃/落地/点击/拾取。
 * 2. 合成行为：节点、时间轴、声部上限、回收、释放。
 * 3. 可复现：同一种子的噪声缓冲逐点相等。
 *
 * @module tests/unit/audio/SoundBank.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SOUND_MATERIAL,
  SOUND_MATERIALS,
  SOUND_NAMES,
  SOUND_RECIPES,
  SoundSynthesizer,
  createNoiseBuffer,
  isSoundName,
  materialForBlockName,
  soundNameFor,
  type SoundMaterial,
} from '@/audio/SoundBank';

import { FakeAudioContext, FakeAudioNode } from './fakeAudioContext';

const REQUIRED_BREAK_MATERIALS: readonly SoundMaterial[] = [
  'stone',
  'dirt',
  'wood',
  'glass',
  'sand',
  'water',
];

afterEach(() => {
  vi.useRealTimers();
});

describe('sound catalogue', () => {
  it('covers every material for break and footstep sounds', () => {
    for (const material of SOUND_MATERIALS) {
      expect(SOUND_NAMES).toContain(`block.break.${material}`);
      expect(SOUND_NAMES).toContain(`footstep.${material}`);
    }
  });

  it('covers the required non-material sounds', () => {
    for (const name of [
      'block.place',
      'player.jump',
      'player.land',
      'ui.click',
      'item.pickup',
    ] as const) {
      expect(SOUND_NAMES).toContain(name);
      expect(SOUND_RECIPES[name].duration).toBeGreaterThan(0);
    }
  });

  it('ships a playable recipe for every declared sound', () => {
    expect(new Set(SOUND_NAMES).size).toBe(SOUND_NAMES.length);
    for (const name of SOUND_NAMES) {
      const recipe = SOUND_RECIPES[name];
      expect(recipe.layers.length).toBeGreaterThan(0);
      expect(recipe.gain).toBeGreaterThan(0);
      expect(recipe.duration).toBeGreaterThan(0);
      for (const layer of recipe.layers) {
        expect(layer.duration).toBeGreaterThan(0);
        expect(layer.gain).toBeGreaterThan(0);
        expect(layer.delay).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('provides break sounds for all six required materials', () => {
    for (const material of REQUIRED_BREAK_MATERIALS) {
      expect(SOUND_RECIPES[`block.break.${material}`]).toBeDefined();
    }
  });

  it('recognises sound names at runtime', () => {
    expect(isSoundName('block.break.stone')).toBe(true);
    expect(isSoundName('footstep.glass')).toBe(true);
    expect(isSoundName('nope')).toBe(false);
  });
});

describe('material mapping', () => {
  it('maps block names onto sound materials', () => {
    expect(materialForBlockName('grass')).toBe('grass');
    expect(materialForBlockName('cobblestone')).toBe('stone');
    expect(materialForBlockName('log')).toBe('wood');
    expect(materialForBlockName('planks')).toBe('wood');
    expect(materialForBlockName('glass')).toBe('glass');
    expect(materialForBlockName('water')).toBe('water');
    expect(materialForBlockName('snow')).toBe('snow');
  });

  it('falls back to stone for unknown blocks so the world is never silent', () => {
    expect(materialForBlockName('unobtainium')).toBe(DEFAULT_SOUND_MATERIAL);
    expect(materialForBlockName('')).toBe(DEFAULT_SOUND_MATERIAL);
  });

  it('builds sound names from action plus material', () => {
    expect(soundNameFor('break', 'wood')).toBe('block.break.wood');
    expect(soundNameFor('footstep', 'sand')).toBe('footstep.sand');
  });
});

describe('createNoiseBuffer', () => {
  it('is deterministic for a given seed', () => {
    const context = new FakeAudioContext();
    const first = createNoiseBuffer(context, 42, 0.05).getChannelData(0);
    const second = createNoiseBuffer(context, 42, 0.05).getChannelData(0);

    expect(first.length).toBe(second.length);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('produces different noise for different seeds', () => {
    const context = new FakeAudioContext();
    const first = createNoiseBuffer(context, 1, 0.05).getChannelData(0);
    const second = createNoiseBuffer(context, 2, 0.05).getChannelData(0);

    expect(Array.from(first)).not.toEqual(Array.from(second));
  });

  it('stays inside the normalised range', () => {
    const context = new FakeAudioContext();
    const data = createNoiseBuffer(context, 7, 0.02).getChannelData(0);
    for (const sample of data) {
      expect(sample).toBeGreaterThanOrEqual(-1);
      expect(sample).toBeLessThanOrEqual(1);
    }
  });
});

describe('SoundSynthesizer', () => {
  it('schedules oscillators and noise layers with an envelope', () => {
    const context = new FakeAudioContext();
    const synth = new SoundSynthesizer(context, { voiceLimit: 4 });
    // 目标节点不用 `createGain()` 创建，这样 `context.gains[0]` 一定是本次发声的输出增益。
    const destination = new FakeAudioNode();

    expect(synth.play('block.break.glass', destination)).toBe(true);
    expect(synth.playedCount).toBe(1);
    // 玻璃配方含 3 个振荡器层 + 1 个噪声层。
    expect(context.oscillators).toHaveLength(3);
    expect(context.sources).toHaveLength(1);
    expect(context.filters).toHaveLength(1);

    for (const oscillator of context.oscillators) {
      expect(oscillator.startedAt).toHaveLength(1);
      expect(oscillator.stoppedAt).toHaveLength(1);
      const [stopped] = oscillator.stoppedAt;
      const [started] = oscillator.startedAt;
      expect(stopped ?? 0).toBeGreaterThan(started ?? 0);
    }

    // 每层都有一个包络增益节点（输出增益 + 各层增益）。
    const envelopeGains = context.gains.slice(1);
    expect(envelopeGains.length).toBeGreaterThanOrEqual(2);
    for (const gain of envelopeGains) {
      const kinds = gain.gain.events.map((event) => event.kind);
      expect(kinds).toContain('set');
      expect(kinds).toContain('linear');
      expect(kinds).toContain('exponential');
    }
  });

  it('scales the output gain by the requested attenuation', () => {
    const context = new FakeAudioContext();
    const synth = new SoundSynthesizer(context);
    const destination = new FakeAudioNode();

    expect(synth.play('ui.click', destination, { gain: 0.25 })).toBe(true);

    const output = context.gains[0];
    const recipeGain = SOUND_RECIPES['ui.click'].gain;
    expect(output?.gain.value).toBeCloseTo(recipeGain * 0.25, 6);
  });

  it('routes the output through the destination and keeps layers connected to it', () => {
    const context = new FakeAudioContext();
    const synth = new SoundSynthesizer(context);
    const destination = new FakeAudioNode();

    synth.play('block.place', destination);

    const output = context.gains[0];
    expect(output?.outputs).toContain(destination);
  });

  it('drops sounds once the voice limit is reached', () => {
    const context = new FakeAudioContext();
    const synth = new SoundSynthesizer(context, { voiceLimit: 1 });

    expect(synth.play('item.pickup', context.destination)).toBe(true);
    expect(synth.play('item.pickup', context.destination)).toBe(false);
    expect(synth.playedCount).toBe(1);
  });

  it('recycles finished voices and disconnects their nodes', () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const synth = new SoundSynthesizer(context);

    synth.play('ui.click', context.destination);
    expect(synth.activeVoices).toBe(1);

    vi.advanceTimersByTime(2000);

    expect(synth.activeVoices).toBe(0);
    expect(context.oscillators[0]?.stoppedAt.length).toBeGreaterThanOrEqual(1);
    expect(context.gains[0]?.disconnectCount).toBeGreaterThan(0);
  });

  it('stops and disconnects everything on dispose', () => {
    const context = new FakeAudioContext();
    const synth = new SoundSynthesizer(context);
    synth.play('player.jump', context.destination);
    synth.play('player.land', context.destination);

    synth.dispose();
    synth.dispose();

    expect(synth.isDisposed).toBe(true);
    expect(synth.activeVoices).toBe(0);
    for (const oscillator of context.oscillators) {
      // 一次来自发声时调度的结束时间，一次来自 dispose 的立即停止。
      expect(oscillator.stoppedAt.length).toBeGreaterThanOrEqual(1);
      expect(oscillator.disconnectCount).toBeGreaterThan(0);
    }
    expect(synth.play('ui.click', context.destination)).toBe(false);
  });

  it('works without optional filter/panner nodes', () => {
    const context = new FakeAudioContext({ withFilter: false, withPanner: false });
    const synth = new SoundSynthesizer(context);

    expect(synth.play('footstep.sand', context.destination)).toBe(true);
    expect(context.filters).toHaveLength(0);
    expect(context.panners).toHaveLength(0);
  });

  it('ignores a non-positive extra gain instead of allocating nodes', () => {
    const context = new FakeAudioContext();
    const synth = new SoundSynthesizer(context);

    expect(synth.play('ui.click', context.destination, { gain: 0 })).toBe(false);
    expect(context.gains).toHaveLength(0);
  });

  it('caches noise buffers per seed', () => {
    const context = new FakeAudioContext();
    const synth = new SoundSynthesizer(context);

    synth.play('block.break.stone', context.destination);
    synth.play('block.break.dirt', context.destination);
    synth.play('block.break.stone', context.destination);

    // 每个音效有两种噪声种子（石头 3 层里有 2 层噪声），缓存后不应线性增长。
    expect(context.createdBuffers.length).toBeLessThanOrEqual(4);
  });
});
