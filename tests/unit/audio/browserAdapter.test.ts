/**
 * 浏览器适配器回归测试。
 *
 * I. 这个缺陷是什么
 *
 * 收窄接口里的节点是普通对象。第一版适配器直接把这种包装对象转交给原生
 * `AudioNode.connect()`，在真实 Chromium 中抛
 * `TypeError: Failed to execute 'connect' on 'AudioNode': Overload resolution failed.`，
 * 结果整个音频子系统静默降级为"不可用"。
 *
 * II. 为什么这个测试能抓到它
 *
 * `FakeNativeAudioContext` 复刻了原生 `connect` 的校验（只接受同一上下文里的节点或
 * AudioParam），因此"把包装对象当原生节点传"必然抛错 → `unlock()` 返回 false →
 * 下面的断言失败。修复后适配器会先把包装对象还原成原生节点，连线全部合法。
 *
 * @module tests/unit/audio/browserAdapter.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioManager, createBrowserAudioContext } from '@/audio/AudioManager';
import { Logger } from '@/utils/logger';

import {
  FakeNativeAudioContext,
  FakeNativeAudioNode,
  FakeNativeAudioParam,
} from './fakeNativeAudioContext';

function silentLogger(): Logger {
  return new Logger({ level: 'silent' });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 在"全局存在 AudioContext"的前提下创建管理器。
 *
 * 注入的 `createContext` 就是**生产实现** `createBrowserAudioContext`；构造函数被替换成
 * 一个返回固定替身实例的函数，从而既能走真实适配路径，又能在测试里持有该实例做断言。
 */
function createBrowserManager(): {
  readonly audio: AudioManager;
  readonly native: FakeNativeAudioContext;
} {
  const native = new FakeNativeAudioContext();
  vi.stubGlobal('AudioContext', function AudioContextStub(): FakeNativeAudioContext {
    return native;
  });
  const audio = new AudioManager({ logger: silentLogger(), createContext: createBrowserAudioContext });
  return { audio, native };
}

describe('createBrowserAudioContext', () => {
  it('unlocks successfully against a strict native-like AudioContext', async () => {
    const { audio, native } = createBrowserManager();

    await expect(audio.unlock()).resolves.toBe(true);

    expect(audio.status).toBe('running');
    expect(native.resumeCount).toBe(1);
    await audio.dispose();
  });

  it('passes only real nodes or AudioParams to connect()', async () => {
    const { audio, native } = createBrowserManager();
    await audio.unlock();
    audio.playSound('block.break.stone', { position: { x: 3, y: 0, z: 0 } });
    audio.setAmbientPlaying(true);

    expect(native.connectCalls.length).toBeGreaterThan(0);
    for (const call of native.connectCalls) {
      expect(call.source).toBeInstanceOf(FakeNativeAudioNode);
      // 目标必须是同一上下文里的节点或参数；包装对象会让这两条断言失败。
      expect(
        call.destination instanceof FakeNativeAudioNode ||
          call.destination instanceof FakeNativeAudioParam,
      ).toBe(true);
    }
    await audio.dispose();
  });

  it('wires the three-channel graph on native nodes', async () => {
    const { audio, native } = createBrowserManager();
    await audio.unlock();

    const [master, sfx, ambient] = native.gains;
    expect(master?.connections).toContain(native.destination);
    expect(sfx?.connections).toContain(master);
    expect(ambient?.connections).toContain(master);

    audio.applySettings({ masterVolume: 0.5, sfxVolume: 0.25, ambientVolume: 1 });
    expect(master?.gain.value).toBeCloseTo(0.25, 6);
    expect(sfx?.gain.value).toBeCloseTo(0.0625, 6);
    expect(ambient?.gain.value).toBeCloseTo(1, 6);

    await audio.dispose();
  });

  it('plays synthesised sounds and the ambient loop on native nodes', async () => {
    const { audio, native } = createBrowserManager();
    await audio.unlock();

    expect(audio.playSound('ui.click')).toBe(true);
    expect(native.oscillators.length).toBeGreaterThan(0);
    expect(native.oscillators[0]?.startCount).toBe(1);

    audio.setAmbientPlaying(true);
    const ambientSource = native.bufferSources.at(-1);
    // 原生 AudioBufferSourceNode 未设置 buffer 时 start() 会抛错，这里能通过就证明
    // `createBuffer` 的返回值被正确接上。
    expect(ambientSource?.buffer).not.toBeNull();
    expect(ambientSource?.loop).toBe(true);
    expect(ambientSource?.startCount).toBe(1);

    await audio.dispose();
  });

  it('filters and pans through native nodes when the context supports them', async () => {
    const { audio, native } = createBrowserManager();
    await audio.unlock();
    audio.setListenerPose({ position: { x: 0, y: 0, z: 0 }, yaw: 0 });

    expect(audio.playSound('block.break.sand', { position: { x: 10, y: 0, z: 0 } })).toBe(true);

    expect(native.filters.length).toBeGreaterThan(0);
    expect(native.panners.length).toBeGreaterThan(0);
    const panner = native.panners.at(-1);
    expect(panner?.pan.value).toBeGreaterThan(0);
    // 声像节点必须连到音效通道，而不是悬空。
    expect(panner?.connections.length).toBe(1);

    await audio.dispose();
  });

  it('closes the native context on dispose and disconnects the graph', async () => {
    const { audio, native } = createBrowserManager();
    await audio.unlock();
    const [master, sfx, ambient] = native.gains;

    await audio.dispose();

    expect(native.closeCount).toBe(1);
    for (const node of [master, sfx, ambient]) {
      expect(node?.disconnectCount).toBeGreaterThan(0);
    }
  });

  it('degrades instead of throwing when the adapter cannot build a legal graph', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 一个"节点创建即失败"的上下文：适配器会在建图时抛错，必须走降级路径。
    class BrokenContext extends FakeNativeAudioContext {
      public override createGain(): never {
        throw new TypeError('节点创建失败');
      }
    }
    vi.stubGlobal('AudioContext', BrokenContext);
    const audio = new AudioManager({
      logger: new Logger({ level: 'warn' }),
      createContext: createBrowserAudioContext,
    });

    await expect(audio.unlock()).resolves.toBe(false);
    expect(audio.isUnavailable).toBe(true);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    await audio.dispose();
  });
});

describe('applySettings before unlock', () => {
  it('is safe to call before a user gesture and is applied on unlock', async () => {
    const native = new FakeNativeAudioContext();
    const audio = new AudioManager({ logger: silentLogger() });

    // 启动阶段先应用设置：此时节点图还不存在，不应抛异常。
    expect(() =>
      audio.applySettings({ masterVolume: 0.3, sfxVolume: 0.5, ambientVolume: 0 }),
    ).not.toThrow();
    expect(audio.masterGain).toBeNull();

    await audio.unlock();

    expect(audio.masterGain).toBeCloseTo(0.09, 6);
    expect(audio.sfxGain).toBeCloseTo(0.25, 6);
    expect(audio.ambientGain).toBe(0);
    expect(native.gains[0]?.gain.value).toBeCloseTo(0.09, 6);

    await audio.dispose();
  });
});
