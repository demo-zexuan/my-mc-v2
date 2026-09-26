/**
 * Narrow structural view of the Web Audio API used by the engine.
 *
 * I. 为什么不直接用 DOM 的 `AudioContext` 类型
 *
 * 1. 浏览器 autoplay 策略要求音频上下文必须在用户手势后创建，而"创建失败要降级为静音"
 *    这条规则必须被单元测试覆盖。测试里不可能构造一个完整的 `AudioContext`（它有几十个
 *    方法、`AudioParam` 的重载签名与 `AudioNode.connect` 的十几种重载），于是只能把依赖
 *    收窄成"我们真正调用的那部分"。
 * 2. 收窄之后，`AudioManager`/`SoundBank` 变成对接口编程：默认实现由
 *    `createBrowserAudioContext()` 把真实的 `AudioContext` 适配进来，测试注入手写假对象。
 *    适配器是唯一出现类型断言的地方，断言的理由写在适配器里。
 *
 * II. 为什么把类型单独放在一个文件
 *
 * 1. 让"引擎用到的音频能力"成为一份可审阅的清单；将来要用 `AudioWorklet` 或第三方合成
 *    器时，改动集中在这一个文件。
 * 2. `SoundBank` 与 `AudioManager` 互相引用对方的类型，单独一层可以避免循环依赖。
 *
 * @module audio/audioTypes
 */

/** 三维向量；音频只读它，因此不依赖任何数学库（也避免依赖 Three.js）。 */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** 采样精度内可接受的最小正增益；`exponentialRampToValueAtTime` 不允许目标为 0。 */
export const MIN_GAIN = 0.0001;

/** 振荡器波形；`custom` 被排除，因为程序化合成只会用标准波形。 */
export type OscillatorTypeLike = 'sine' | 'square' | 'sawtooth' | 'triangle';

/** 双二阶滤波器类型子集。 */
export type BiquadFilterTypeLike = 'lowpass' | 'highpass' | 'bandpass';

/** 上下文状态；`interrupted` 是 iOS Safari 在来电等场景下的扩展状态。 */
export type AudioContextStateLike = 'suspended' | 'running' | 'closed' | 'interrupted';

/**
 * `AudioParam` 的最小可用面。
 *
 * 所有自动化方法都返回 `unknown`：真实实现返回 `AudioParam` 以便链式调用，而我们从不链式
 * 调用，声明成 `unknown` 可以让真实对象与测试替身都无需额外包装即可满足。
 */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(startTime: number): unknown;
}

/** 可连接、可断开的音频节点。 */
export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

/** 增益节点。 */
export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

/** 振荡器节点。 */
export interface OscillatorNodeLike extends AudioNodeLike {
  type: OscillatorTypeLike;
  readonly frequency: AudioParamLike;
  readonly detune: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

/** 一段可复用的采样数据。 */
export interface AudioBufferLike {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/** 播放 `AudioBuffer` 的源节点。 */
export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  readonly playbackRate: AudioParamLike;
  start(when?: number): void;
  stop(when?: number): void;
}

/** 滤波器节点。 */
export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterTypeLike;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

/** 立体声声像节点。 */
export interface StereoPannerNodeLike extends AudioNodeLike {
  readonly pan: AudioParamLike;
}

/**
 * 引擎使用的音频上下文子集。
 *
 * `createBiquadFilter` / `createStereoPanner` 声明为可选：旧版 Safari 缺少后者，合成器必须
 * 在缺失时退化为"不滤波/不声像"而不是崩溃。
 */
export interface AudioContextLike {
  readonly state: AudioContextStateLike;
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodeLike;
  createGain(): GainNodeLike;
  createOscillator(): OscillatorNodeLike;
  createBufferSource(): AudioBufferSourceNodeLike;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike;
  createBiquadFilter?(): BiquadFilterNodeLike;
  createStereoPanner?(): StereoPannerNodeLike;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}
