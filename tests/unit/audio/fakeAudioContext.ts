/**
 * 音频测试替身：手写的窄接口实现。
 *
 * I. 为什么需要它
 *
 * 1. `AudioManager` 的降级行为（创建失败 → 静音）与距离衰减只能在"能精确观察节点创建与
 *    参数调度"的环境里验证；真实 `AudioContext` 在 node 环境不存在，在 jsdom 里也只是空壳。
 * 2. 因此这里实现 `AudioContextLike` 这一层窄接口：记录每次节点创建、每次参数自动化、
 *    每次 start/stop，让断言可以精确到"某个增益节点的值是多少"。
 *
 * @module tests/unit/audio/fakeAudioContext
 */

import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike,
  AudioContextStateLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  BiquadFilterTypeLike,
  GainNodeLike,
  OscillatorNodeLike,
  OscillatorTypeLike,
  StereoPannerNodeLike,
} from '@/audio/audioTypes';

/** 一次参数自动化的记录。 */
export interface ParamEvent {
  readonly kind: 'set' | 'linear' | 'exponential' | 'cancel';
  readonly value: number;
  readonly time: number;
}

/** 可观察的 `AudioParam` 替身。 */
export class FakeAudioParam implements AudioParamLike {
  public value: number;
  public readonly events: ParamEvent[] = [];

  public constructor(initial = 1) {
    this.value = initial;
  }

  public setValueAtTime(value: number, startTime: number): unknown {
    this.events.push({ kind: 'set', value, time: startTime });
    return this;
  }

  public linearRampToValueAtTime(value: number, endTime: number): unknown {
    this.events.push({ kind: 'linear', value, time: endTime });
    return this;
  }

  public exponentialRampToValueAtTime(value: number, endTime: number): unknown {
    this.events.push({ kind: 'exponential', value, time: endTime });
    return this;
  }

  public cancelScheduledValues(startTime: number): unknown {
    this.events.push({ kind: 'cancel', value: 0, time: startTime });
    return this;
  }
}

/** 基础节点替身：记录连接关系与断开次数。 */
export class FakeAudioNode implements AudioNodeLike {
  /** 连接目标日志（只追加，不在断开时清空，便于断言"曾经连到哪里"）。 */
  public readonly outputs: AudioNodeLike[] = [];
  public disconnectCount = 0;

  public connect(destination: AudioNodeLike): unknown {
    this.outputs.push(destination);
    return destination;
  }

  public disconnect(): void {
    this.disconnectCount += 1;
  }
}

/** 增益节点替身。 */
export class FakeGainNode extends FakeAudioNode implements GainNodeLike {
  public readonly gain = new FakeAudioParam(1);
}

/** 振荡器节点替身。 */
export class FakeOscillatorNode extends FakeAudioNode implements OscillatorNodeLike {
  public type: OscillatorTypeLike = 'sine';
  public readonly frequency = new FakeAudioParam(440);
  public readonly detune = new FakeAudioParam(0);
  public readonly startedAt: number[] = [];
  public readonly stoppedAt: number[] = [];

  public start(when?: number): void {
    this.startedAt.push(when ?? 0);
  }

  public stop(when?: number): void {
    this.stoppedAt.push(when ?? 0);
  }
}

/** 采样缓冲替身。 */
export class FakeAudioBuffer implements AudioBufferLike {
  public readonly length: number;
  public readonly sampleRate: number;
  public readonly numberOfChannels: number;
  readonly #data: Float32Array;

  public constructor(length: number, sampleRate: number, numberOfChannels = 1) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.numberOfChannels = numberOfChannels;
    this.#data = new Float32Array(length);
  }

  public getChannelData(channel: number): Float32Array {
    void channel;
    return this.#data;
  }
}

/** 缓冲源节点替身。 */
export class FakeBufferSourceNode extends FakeAudioNode implements AudioBufferSourceNodeLike {
  public buffer: AudioBufferLike | null = null;
  public loop = false;
  public readonly playbackRate = new FakeAudioParam(1);
  public readonly startedAt: number[] = [];
  public readonly stoppedAt: number[] = [];

  public start(when?: number): void {
    this.startedAt.push(when ?? 0);
  }

  public stop(when?: number): void {
    this.stoppedAt.push(when ?? 0);
  }
}

/** 滤波器节点替身。 */
export class FakeFilterNode extends FakeAudioNode implements BiquadFilterNodeLike {
  public type: BiquadFilterTypeLike = 'lowpass';
  public readonly frequency = new FakeAudioParam(350);
  public readonly Q = new FakeAudioParam(1);
}

/** 声像节点替身。 */
export class FakePannerNode extends FakeAudioNode implements StereoPannerNodeLike {
  public readonly pan = new FakeAudioParam(0);
}

export interface FakeAudioContextOptions {
  readonly sampleRate?: number;
  /** 初始状态；默认 `suspended`，与"未经过用户手势"的真实浏览器行为一致。 */
  readonly state?: AudioContextStateLike;
  /** `resume()` 之后的状态；默认 `running`。 */
  readonly resumedState?: AudioContextStateLike;
  /** `resume()` 是否抛错。 */
  readonly failResume?: boolean;
  /** 是否提供 `createBiquadFilter`；默认提供。 */
  readonly withFilter?: boolean;
  /** 是否提供 `createStereoPanner`；默认提供。 */
  readonly withPanner?: boolean;
}

/**
 * 可观察的音频上下文替身。
 *
 * 所有创建出来的节点都按创建顺序记录在对应数组里，测试据此断言"这次发声建了哪些节点"。
 */
export class FakeAudioContext implements AudioContextLike {
  public state: AudioContextStateLike;
  public currentTime = 0;
  public readonly sampleRate: number;
  public readonly destination = new FakeAudioNode();

  public readonly gains: FakeGainNode[] = [];
  public readonly oscillators: FakeOscillatorNode[] = [];
  public readonly sources: FakeBufferSourceNode[] = [];
  public readonly filters: FakeFilterNode[] = [];
  public readonly panners: FakePannerNode[] = [];
  public readonly createdBuffers: FakeAudioBuffer[] = [];

  public resumeCount = 0;
  public suspendCount = 0;
  public closeCount = 0;

  public createBiquadFilter?: () => BiquadFilterNodeLike;
  public createStereoPanner?: () => StereoPannerNodeLike;

  readonly #options: FakeAudioContextOptions;

  public constructor(options: FakeAudioContextOptions = {}) {
    this.#options = options;
    this.sampleRate = options.sampleRate ?? 48_000;
    this.state = options.state ?? 'suspended';
    if (options.withFilter !== false) {
      this.createBiquadFilter = () => {
        const node = new FakeFilterNode();
        this.filters.push(node);
        return node;
      };
    }
    if (options.withPanner !== false) {
      this.createStereoPanner = () => {
        const node = new FakePannerNode();
        this.panners.push(node);
        return node;
      };
    }
  }

  public createGain(): GainNodeLike {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  public createOscillator(): OscillatorNodeLike {
    const node = new FakeOscillatorNode();
    this.oscillators.push(node);
    return node;
  }

  public createBufferSource(): AudioBufferSourceNodeLike {
    const node = new FakeBufferSourceNode();
    this.sources.push(node);
    return node;
  }

  public createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): AudioBufferLike {
    const buffer = new FakeAudioBuffer(length, sampleRate, numberOfChannels);
    this.createdBuffers.push(buffer);
    return buffer;
  }

  public resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.#options.failResume === true) {
      return Promise.reject(new Error('resume 被拒绝'));
    }
    this.state = this.#options.resumedState ?? 'running';
    return Promise.resolve();
  }

  public suspend(): Promise<void> {
    this.suspendCount += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }

  public close(): Promise<void> {
    this.closeCount += 1;
    this.state = 'closed';
    return Promise.resolve();
  }

  /** 上下文创建出来的全部节点，便于统一断言"都已断开"。 */
  public allNodes(): readonly FakeAudioNode[] {
    return [
      this.destination,
      ...this.gains,
      ...this.oscillators,
      ...this.sources,
      ...this.filters,
      ...this.panners,
    ];
  }
}
