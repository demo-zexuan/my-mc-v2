/**
 * AudioManager 单元测试。
 *
 * I. 覆盖重点
 *
 * 1. autoplay 策略：未解锁不发声、`unlock` 在建上下文后立刻 `resume`、重复调用幂等。
 * 2. 降级：上下文创建失败或 `resume` 被拒绝时不抛异常、状态变为不可用、后续发声静默失败。
 * 3. 三路增益与感知曲线、距离衰减、静音短路。
 * 4. `dispose` 断开全部节点并关闭上下文。
 *
 * @module tests/unit/audio/AudioManager.test
 */

import { describe, expect, it, vi } from 'vitest';

import {
  AudioManager,
  distanceAttenuation,
  perceptualVolume,
  type AudioManagerOptions,
} from '@/audio/AudioManager';
import { Logger } from '@/utils/logger';

import { FakeAudioContext, FakeGainNode } from './fakeAudioContext';

/** 测试用静默 logger，避免断言失败的用例刷屏。 */
function silentLogger(): Logger {
  return new Logger({ level: 'silent' });
}

function createManager(overrides: Partial<AudioManagerOptions> = {}): {
  readonly audio: AudioManager;
  readonly contexts: FakeAudioContext[];
  readonly createCount: () => number;
} {
  const contexts: FakeAudioContext[] = [];
  const options: AudioManagerOptions = {
    logger: silentLogger(),
    createContext: () => {
      const context = new FakeAudioContext();
      contexts.push(context);
      return context;
    },
    ...overrides,
  };
  const audio = new AudioManager(options);
  return { audio, contexts, createCount: () => contexts.length };
}

describe('perceptualVolume', () => {
  it('applies a square curve so slider positions match perceived loudness', () => {
    expect(perceptualVolume(1)).toBe(1);
    expect(perceptualVolume(0.5)).toBeCloseTo(0.25, 6);
    expect(perceptualVolume(0)).toBe(0);
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(perceptualVolume(-3)).toBe(0);
    expect(perceptualVolume(12)).toBe(1);
    expect(perceptualVolume(Number.NaN)).toBe(0);
  });
});

describe('distanceAttenuation', () => {
  it('keeps full gain inside the reference distance', () => {
    expect(distanceAttenuation(0, 4, 1)).toBe(1);
    expect(distanceAttenuation(4, 4, 1)).toBe(1);
  });

  it('falls off inversely beyond the reference distance', () => {
    // 4 / (4 + 1 * (40 - 4)) = 0.1
    expect(distanceAttenuation(40, 4, 1)).toBeCloseTo(0.1, 6);
  });

  it('attenuates faster with a larger rolloff factor', () => {
    expect(distanceAttenuation(20, 4, 2)).toBeLessThan(distanceAttenuation(20, 4, 1));
  });

  it('passes non-finite distances through; the manager filters those positions itself', () => {
    expect(distanceAttenuation(Number.POSITIVE_INFINITY, 4, 1)).toBe(1);
    expect(distanceAttenuation(Number.NaN, 4, 1)).toBe(1);
  });
});

describe('AudioManager lifecycle', () => {
  it('does not create an AudioContext before a user gesture', () => {
    const { audio, createCount } = createManager();

    expect(createCount()).toBe(0);
    expect(audio.status).toBe('uninitialized');
    expect(audio.playSound('ui.click')).toBe(false);
    expect(createCount()).toBe(0);
  });

  it('creates the context and resumes it inside unlock()', async () => {
    const { audio, contexts } = createManager();

    await expect(audio.unlock()).resolves.toBe(true);

    expect(contexts).toHaveLength(1);
    const context = contexts[0];
    expect(context?.resumeCount).toBe(1);
    expect(audio.status).toBe('running');
    expect(audio.isRunning).toBe(true);
  });

  it('is idempotent: a second unlock reuses the context without another resume', async () => {
    const { audio, contexts } = createManager();

    await audio.unlock();
    await audio.unlock();

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.resumeCount).toBe(1);
  });

  it('degrades to silence when the context cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const audio = new AudioManager({
      logger: new Logger({ level: 'warn' }),
      createContext: () => {
        throw new Error('AudioContext 被策略禁用');
      },
    });

    await expect(audio.unlock()).resolves.toBe(false);

    expect(audio.status).toBe('unavailable');
    expect(audio.isUnavailable).toBe(true);
    expect(audio.playSound('block.break.stone')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stays suspended (not unavailable) when resume is rejected by the policy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { audio } = createManager({
      logger: new Logger({ level: 'warn' }),
      createContext: () => new FakeAudioContext({ failResume: true }),
    });

    await expect(audio.unlock()).resolves.toBe(false);

    expect(audio.status).toBe('suspended');
    expect(audio.playSound('ui.click')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('unlocks from a DOM gesture via attachAutoUnlock and then detaches itself', async () => {
    const { audio, contexts } = createManager();
    const target = new EventTarget();
    const detach = audio.attachAutoUnlock(target);

    target.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => {
      expect(audio.isRunning).toBe(true);
    });

    // 第二次手势不应再触发 resume：监听器已经自行解绑。
    target.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(contexts[0]?.resumeCount).toBe(1);

    detach();
    detach();
    expect(audio.isRunning).toBe(true);
  });

  it('detaches without unlocking when the gesture never happens', () => {
    const { audio, createCount } = createManager();
    const detach = audio.attachAutoUnlock(new EventTarget());
    detach();
    expect(createCount()).toBe(0);
  });
});

describe('AudioManager mixing', () => {
  it('ignores non-finite configuration instead of poisoning distance maths', async () => {
    const { audio } = createManager({
      voiceLimit: Number.NaN,
      referenceDistance: Number.NaN,
      maxDistance: Number.NaN,
      rolloffFactor: Number.NaN,
    });
    await audio.unlock();

    // 退化回默认参数后，超远的声音仍会被丢弃（NaN 配置会让"距离 > 上限"恒为 false）。
    expect(audio.playSound('block.break.stone', { position: { x: 500, y: 0, z: 0 } })).toBe(false);
    expect(audio.playSound('block.break.stone')).toBe(true);
  });

  it('builds sfx/ambient into master into destination', async () => {
    const { audio, contexts } = createManager();
    await audio.unlock();

    const context = contexts[0];
    const [master, sfx, ambient] = context?.gains ?? [];
    expect(master).toBeInstanceOf(FakeGainNode);
    // I. 三路增益的拓扑：前三个 createGain 依次是 master、sfx、ambient。
    expect(master?.outputs).toEqual([context?.destination]);
    expect(sfx?.outputs).toEqual([master]);
    expect(ambient?.outputs).toEqual([master]);
  });

  it('maps settings volumes onto the three channels with the perceptual curve', async () => {
    const { audio } = createManager();
    await audio.unlock();

    audio.applySettings({ masterVolume: 0.5, sfxVolume: 0.25, ambientVolume: 1 });

    expect(audio.masterGain).toBeCloseTo(0.25, 6);
    expect(audio.sfxGain).toBeCloseTo(0.0625, 6);
    expect(audio.ambientGain).toBe(1);
  });

  it('short-circuits playback while muted', async () => {
    const { audio, contexts } = createManager();
    await audio.unlock();
    audio.setVolumes({ master: 0 });

    expect(audio.isMuted).toBe(true);
    expect(audio.playSound('ui.click')).toBe(false);
    // 静音时不应该分配任何节点：解锁只建了 3 个增益节点。
    expect(contexts[0]?.gains).toHaveLength(3);
  });
});

describe('AudioManager distance attenuation', () => {
  it('schedules a quieter voice for distant sounds', async () => {
    const { audio, contexts } = createManager({ referenceDistance: 4, maxDistance: 40 });
    await audio.unlock();
    audio.setListenerPose({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });
    const context = contexts[0];
    if (context === undefined) {
      throw new Error('上下文未创建');
    }

    const beforeNear = context.gains.length;
    expect(audio.playSound('ui.click', { position: { x: 0, y: 0, z: 0 } })).toBe(true);
    const nearGain = context.gains[beforeNear]?.gain.value ?? 0;
    context.currentTime += 0.5;

    const beforeFar = context.gains.length;
    expect(audio.playSound('ui.click', { position: { x: 30, y: 0, z: 0 } })).toBe(true);
    const farGain = context.gains[beforeFar]?.gain.value ?? 0;

    expect(nearGain).toBeGreaterThan(0);
    expect(farGain).toBeLessThan(nearGain);
  });

  it('drops sounds beyond maxDistance without allocating nodes', async () => {
    const { audio, contexts } = createManager({ maxDistance: 20 });
    await audio.unlock();
    const context = contexts[0];
    if (context === undefined) {
      throw new Error('上下文未创建');
    }

    const before = context.gains.length;
    expect(audio.playSound('block.break.stone', { position: { x: 100, y: 0, z: 0 } })).toBe(false);
    expect(context.gains.length).toBe(before);
  });

  it('pans sounds to the side they come from', async () => {
    const { audio, contexts } = createManager();
    await audio.unlock();
    audio.setListenerPose({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });
    const context = contexts[0];
    if (context === undefined) {
      throw new Error('上下文未创建');
    }

    // 听者朝 -Z，+X 方向的声源应出现在右侧（pan > 0）。
    expect(audio.playSound('ui.click', { position: { x: 12, y: 0, z: 0 } })).toBe(true);
    expect(context.panners.at(-1)?.pan.value ?? 0).toBeGreaterThan(0);

    expect(audio.playSound('ui.click', { position: { x: -12, y: 0, z: 0 } })).toBe(true);
    expect(context.panners.at(-1)?.pan.value ?? 0).toBeLessThan(0);
  });

  it('survives a context without a stereo panner', async () => {
    const { audio } = createManager({
      createContext: () => new FakeAudioContext({ withPanner: false }),
    });
    await audio.unlock();

    expect(audio.playSound('ui.click', { position: { x: 5, y: 0, z: 0 } })).toBe(true);
  });

  it('drops sounds with a non-finite position instead of playing them at full gain', async () => {
    const { audio } = createManager();
    await audio.unlock();

    expect(audio.playSound('ui.click', { position: { x: Number.NaN, y: 0, z: 0 } })).toBe(false);
  });

  it('keeps a coherent listener pose and rejects non-finite input', async () => {
    const { audio } = createManager();
    await audio.unlock();

    audio.setListenerPose({ position: { x: 1, y: 2, z: 3 }, yaw: 0.5 });
    expect(audio.getListenerPose()).toEqual({ position: { x: 1, y: 2, z: 3 }, yaw: 0.5 });

    audio.setListenerPose({ position: { x: Number.NaN, y: 0, z: 0 }, yaw: Number.NaN });
    expect(audio.getListenerPose()).toEqual({ position: { x: 1, y: 2, z: 3 }, yaw: 0.5 });
  });
});

describe('AudioManager ambient bed', () => {
  it('starts a looping filtered noise loop on the ambient channel', async () => {
    const { audio, contexts } = createManager();
    audio.setAmbientPlaying(true);

    await audio.unlock();

    const context = contexts[0];
    expect(context?.sources).toHaveLength(1);
    expect(context?.sources[0]?.loop).toBe(true);
    expect(context?.filters).toHaveLength(1);
    expect(audio.isAmbientPlaying).toBe(true);
  });

  it('stops the ambient loop and keeps the intent for the next unlock', async () => {
    const { audio, contexts } = createManager();
    await audio.unlock();
    audio.setAmbientPlaying(true);
    const context = contexts[0];
    expect(context?.sources).toHaveLength(1);

    audio.setAmbientPlaying(false);

    expect(context?.sources[0]?.stoppedAt).toHaveLength(1);
    expect(audio.isAmbientPlaying).toBe(false);
  });
});

describe('AudioManager dispose', () => {
  it('disconnects every node and closes the context exactly once', async () => {
    const { audio, contexts } = createManager();
    await audio.unlock();
    const context = contexts[0];
    if (context === undefined) {
      throw new Error('上下文未创建');
    }
    audio.setAmbientPlaying(true);
    expect(audio.playSound('player.land')).toBe(true);

    await audio.dispose();
    await audio.dispose();

    expect(context.closeCount).toBe(1);
    expect(audio.status).toBe('disposed');
    const graphNodes = [context.gains[0], context.gains[1], context.gains[2]];
    for (const node of graphNodes) {
      expect(node?.disconnectCount).toBeGreaterThan(0);
    }
    expect(context.sources[0]?.stoppedAt).toHaveLength(1);
    expect(audio.playSound('ui.click')).toBe(false);
  });

  it('never throws when closing the context fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context = new FakeAudioContext();
    context.close = (): Promise<void> => Promise.reject(new Error('close 失败'));
    const audio = new AudioManager({
      logger: new Logger({ level: 'warn' }),
      createContext: () => context,
    });
    await audio.unlock();

    await expect(audio.dispose()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses to unlock after being disposed', async () => {
    const { audio, createCount } = createManager();
    await audio.dispose();

    await expect(audio.unlock()).resolves.toBe(false);
    expect(createCount()).toBe(0);
  });
});

describe('AudioManager fallback without any AudioContext implementation', () => {
  it('reports unavailable instead of throwing when the environment has no factory', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 不注入 createContext：走 createBrowserAudioContext 的默认路径，node 环境下没有
    // AudioContext，因此必然走降级分支。
    const hasBrowserAudioContext = (globalThis as { AudioContext?: unknown }).AudioContext;
    const audio = new AudioManager({ logger: new Logger({ level: 'warn' }) });

    if (hasBrowserAudioContext === undefined) {
      await expect(audio.unlock()).resolves.toBe(false);
      expect(audio.isUnavailable).toBe(true);
    } else {
      // 运行环境自带 AudioContext（例如 jsdom）时本用例不适用。
      expect(hasBrowserAudioContext).toBeDefined();
    }
    warn.mockRestore();
  });
});
