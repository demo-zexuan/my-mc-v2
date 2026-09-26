/**
 * Audio manager: context lifecycle, three-way mixing, distance attenuation.
 *
 * I. 为什么 AudioContext 必须"懒创建 + 手势内恢复"
 *
 * 1. 浏览器 autoplay 策略规定：没有用户手势时创建的 `AudioContext` 会处于 `suspended`，
 *    而 `resume()` 只有在用户手势的调用栈内才会被允许。提前在模块初始化时创建上下文，
 *    结果是"游戏一直没声音"，且没有任何报错可查。
 * 2. 因此本类的生命周期是：`unlock()`（由 pointerdown/keydown 触发）→ 若有需要就创建
 *    上下文 → 立即 `resume()`（不 await 其他东西，保证仍在手势栈内）→ 状态变为
 *    `running`。`playSound` 在未 `running` 时静默返回 `false`，不排队、不报错。
 *
 * II. 为什么创建失败必须降级而不是抛出
 *
 * 1. 音频是增强功能：无声的游戏仍然可玩，能启动的游戏才是合格的产品。
 * 2. 失败路径只记录 `warn` 并把状态置为 `unavailable`；此后所有 `playSound` 都是空操作，
 *    调用方无需到处 try/catch。`unlock()` 只在"完全没有音频实现"时沿用手势回调里的
 *    异常语义返回 `false`，绝不向上抛。
 *
 * III. 三路增益的拓扑
 *
 * ```
 * 合成音效 ──► sfxGain ──┐
 * 环境循环 ──► ambientGain┴─► masterGain ──► destination
 * ```
 *
 * 音量取值经过感知曲线（`v²`）：人耳对响度的感知接近对数，线性映射会让 50% 听起来仍然
 * 很响，滑杆的"前半段"几乎无效。
 *
 * @module audio/AudioManager
 */

import type { GameSettings } from '@/settings/types';
import { AppError } from '@/utils/errors';
import { logger as defaultLogger, type Logger } from '@/utils/logger';
import {
  MIN_GAIN,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike,
  type AudioContextStateLike,
  type AudioNodeLike,
  type AudioParamLike,
  type BiquadFilterNodeLike,
  type BiquadFilterTypeLike,
  type GainNodeLike,
  type OscillatorNodeLike,
  type OscillatorTypeLike,
  type StereoPannerNodeLike,
  type Vec3Like,
} from './audioTypes';
import { SoundSynthesizer, createNoiseBuffer, type SoundName } from './SoundBank';

/** 音效通道；`ambient` 供风声等环境音循环使用。 */
export type AudioChannel = 'sfx' | 'ambient';

/** 音频子系统的公开状态。 */
export type AudioStatus = 'uninitialized' | 'running' | 'suspended' | 'unavailable' | 'disposed';

/** 听者姿态：位置 + 朝向（弧度，0 表示朝 -Z，与 Three.js 约定一致）。 */
export interface ListenerPose {
  readonly position: Vec3Like;
  readonly yaw: number;
}

/** 三路音量。 */
export interface AudioVolumes {
  readonly master: number;
  readonly sfx: number;
  readonly ambient: number;
}

/** 内部可变形态的音量；对外始终暴露只读快照。 */
interface MutableAudioVolumes {
  master: number;
  sfx: number;
  ambient: number;
}

export interface AudioManagerOptions {
  /** 上下文工厂；测试注入假上下文，默认使用浏览器 `AudioContext`。 */
  readonly createContext?: () => AudioContextLike;
  readonly logger?: Logger;
  /** 同时发声上限。 */
  readonly voiceLimit?: number;
  /** 距离衰减的参考距离（米）。 */
  readonly referenceDistance?: number;
  /** 超过该距离的声音直接丢弃。 */
  readonly maxDistance?: number;
  /** 距离衰减指数；1 为标准反比衰减。 */
  readonly rolloffFactor?: number;
  /** 初始音量；默认全部 0.8，随后由 `applySettings` 覆盖。 */
  readonly volumes?: Partial<AudioVolumes>;
}

/** `playSound` 的可选参数。 */
export interface PlaySoundOptions {
  /** 世界坐标位置；省略表示"贴在听者身上"（UI 音、玩家自身动作）。 */
  readonly position?: Vec3Like;
  /** 输出通道；默认 `sfx`。 */
  readonly channel?: AudioChannel;
  /** 额外增益倍数，`0 .. 1`。 */
  readonly gain?: number;
  /** 延迟播放，秒。 */
  readonly delay?: number;
}

/** 自动解锁监听的默认事件列表。 */
const DEFAULT_UNLOCK_EVENTS: readonly string[] = ['pointerdown', 'keydown', 'touchstart'];

/**
 * 感知音量曲线。
 *
 * @param value - 滑杆值，`0 .. 1`。
 * @returns 增益值，`0 .. 1`。
 */
export function perceptualVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped;
}

/**
 * 反比距离衰减。
 *
 * I. 为什么不是简单的 `1 / (1 + d)`
 *
 * 1. 在参考距离以内增益恒为 1：玩家脚下的方块声不应该因为"距离 2 米"就衰减一半。
 * 2. 超过参考距离后按 `ref / (ref + rolloff * (d - ref))` 衰减，`d = maxDistance` 时把手
 *    听不见，由调用方在更远处直接丢弃，省掉无意义的节点分配。
 *
 * @param distance - 听者到声源的距离，米。
 * @param referenceDistance - 参考距离，米。
 * @param rolloffFactor - 衰减强度；大于 1 衰减更快。
 * @returns `0 .. 1` 的增益倍数。
 */
export function distanceAttenuation(
  distance: number,
  referenceDistance: number,
  rolloffFactor: number,
): number {
  if (!Number.isFinite(distance) || distance <= referenceDistance) {
    return 1;
  }
  const reference = Math.max(referenceDistance, MIN_GAIN);
  const rolloff = Math.max(rolloffFactor, 0);
  return clamp01(reference / (reference + rolloff * (distance - reference)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

function isRunningState(state: AudioContextStateLike): boolean {
  return state === 'running';
}

/** 坐标必须是有限数；NaN/Infinity 说明上游物理计算出了问题。 */
function isFiniteVec3(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

/**
 * 过滤非有限配置值。
 *
 * `Math.max(1, Number.NaN)` 仍是 `NaN`，而 NaN 参与的比较永远为 false——距离判断会因此
 * 全部走"未超过上限"分支。配置入口先收敛，后续逻辑就不必到处防御。
 */
function finiteOr(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

/**
 * 音频管理器。
 *
 * 所有对外方法在降级状态下都必须是安全的：`playSound` 返回 `false`，`unlock` 返回
 * `false`，`dispose` 幂等。
 */
export class AudioManager {
  readonly #createContext: () => AudioContextLike;
  readonly #logger: Logger;
  readonly #voiceLimit: number;
  readonly #referenceDistance: number;
  readonly #maxDistance: number;
  readonly #rolloffFactor: number;
  readonly #volumes: MutableAudioVolumes;

  #context: AudioContextLike | null = null;
  #synthesizer: SoundSynthesizer | null = null;
  #master: GainNodeLike | null = null;
  #sfx: GainNodeLike | null = null;
  #ambient: GainNodeLike | null = null;
  #ambientSource: AudioBufferSourceNodeLike | null = null;
  #ambientFilter: BiquadFilterNodeLike | null = null;
  #ambientPlaying = false;
  #status: AudioStatus = 'uninitialized';
  #listener: ListenerPose = { position: { x: 0, y: 0, z: 0 }, yaw: 0 };
  #disposed = false;

  public constructor(options: AudioManagerOptions = {}) {
    this.#createContext = options.createContext ?? createBrowserAudioContext;
    this.#logger = (options.logger ?? defaultLogger).child('audio');
    this.#voiceLimit = Math.max(1, Math.floor(finiteOr(options.voiceLimit, 24)));
    this.#referenceDistance = Math.max(MIN_GAIN, finiteOr(options.referenceDistance, 4));
    this.#maxDistance = Math.max(this.#referenceDistance, finiteOr(options.maxDistance, 40));
    this.#rolloffFactor = Math.max(0, finiteOr(options.rolloffFactor, 1));
    this.#volumes = {
      master: clamp01(options.volumes?.master ?? 0.8),
      sfx: clamp01(options.volumes?.sfx ?? 0.9),
      ambient: clamp01(options.volumes?.ambient ?? 0.5),
    };
  }

  /** 当前状态。 */
  public get status(): AudioStatus {
    return this.#status;
  }

  /** 上下文是否已就绪（可以发声）。 */
  public get isRunning(): boolean {
    return this.#status === 'running';
  }

  /** 音频是否不可用（用户手势后仍无声音）。调用方可据此提示"静音运行"。 */
  public get isUnavailable(): boolean {
    return this.#status === 'unavailable';
  }

  /** 主音量为 0 时视为静音；静音时不分配任何节点。 */
  public get isMuted(): boolean {
    return perceptualVolume(this.#volumes.master) <= 0;
  }

  /** 当前主增益节点值；未初始化时为 `null`。 */
  public get masterGain(): number | null {
    return this.#master === null ? null : this.#master.gain.value;
  }

  /** 当前音效通道增益节点值；未初始化时为 `null`。 */
  public get sfxGain(): number | null {
    return this.#sfx === null ? null : this.#sfx.gain.value;
  }

  /** 当前环境通道增益节点值；未初始化时为 `null`。 */
  public get ambientGain(): number | null {
    return this.#ambient === null ? null : this.#ambient.gain.value;
  }

  /** 当前音量快照。 */
  public get volumes(): AudioVolumes {
    return { master: this.#volumes.master, sfx: this.#volumes.sfx, ambient: this.#volumes.ambient };
  }

  /**
   * 在用户手势中初始化并恢复音频。
   *
   * I. 调用约定
   *
   * 1. 必须在 `pointerdown` / `keydown` 等手势事件的同步调用栈中调用（不要放在
   *    `setTimeout` 或未 await 的 promise 之后），否则 `resume()` 会被策略拒绝。
   * 2. 幂等：已 `running` 时立即返回 `true`，重复调用没有副作用。
   *
   * @returns 是否成功获得可发声的上下文；失败表示已降级为静音。
   */
  public async unlock(): Promise<boolean> {
    if (this.#disposed) {
      return false;
    }

    // I. 首次解锁时创建上下文与节点图。
    // 1. 创建与 resume 之间不 await 任何东西：resume 必须在手势栈内被调用。
    if (this.#context === null) {
      try {
        const context = this.#createContext();
        this.#buildGraph(context);
        this.#context = context;
      } catch (error) {
        this.#status = 'unavailable';
        this.#logger.warn('音频上下文创建失败，游戏将静音运行', error);
        return false;
      }
    }

    const context = this.#context;
    try {
      if (!isRunningState(context.state)) {
        await context.resume();
      }
    } catch (error) {
      this.#logger.warn('音频上下文恢复失败，将等待下一次用户手势', error);
    }

    if (isRunningState(context.state)) {
      this.#status = 'running';
      if (this.#ambientPlaying) {
        this.#startAmbientSource();
      }
      return true;
    }

    this.#status = 'suspended';
    return false;
  }

  /**
   * 把解锁逻辑挂到 DOM 事件上，返回解绑函数。
   *
   * 1. 命中一次并成功 `running` 后自动解绑，避免每帧手势都走一遍状态机。
   * 2. 返回的函数可重复调用（应用卸载时清理）。
   *
   * @param target - 事件目标，通常是 `window` 或 canvas。
   * @param events - 需要监听的手势事件；默认 pointerdown/keydown/touchstart。
   */
  public attachAutoUnlock(
    target: EventTarget,
    events: readonly string[] = DEFAULT_UNLOCK_EVENTS,
  ): () => void {
    let detached = false;
    const detach = (): void => {
      if (detached) {
        return;
      }
      detached = true;
      for (const event of events) {
        target.removeEventListener(event, handler);
      }
    };
    // `no-misused-promises` 不允许把 async 函数直接交给 addEventListener，
    // 因此这里显式吞掉 promise 并依靠 unlock 自身的降级语义。
    const handler = (): void => {
      void this.unlock().then((unlocked) => {
        if (unlocked) {
          detach();
        }
      });
    };

    if (this.#disposed) {
      return detach;
    }
    for (const event of events) {
      target.addEventListener(event, handler);
    }
    return detach;
  }

  /**
   * 播放一个合成音效。
   *
   * @param name - 音效名。
   * @param options - 位置（用于距离衰减与声像）、通道、额外增益与延迟。
   * @returns 是否真的调度了发声；未解锁、已降级、静音、距离过远时返回 `false`。
   */
  public playSound(name: SoundName, options: PlaySoundOptions = {}): boolean {
    const synthesizer = this.#synthesizer;
    const channel = this.#channelGain(options.channel ?? 'sfx');
    if (synthesizer === null || channel === null || this.#status !== 'running') {
      return false;
    }

    // I. 距离衰减与声像。
    // 1. 超过 maxDistance 的声音直接丢弃：既听不见，又没有必要付出节点开销。
    let gain = clamp01(options.gain ?? 1);
    let pan: number | undefined;
    const position = options.position;
    if (position !== undefined) {
      if (!isFiniteVec3(position)) {
        // 非有限坐标通常意味着物理层算出了 NaN；此时宁可静音也不要发出满音量的爆音。
        return false;
      }
      const relative = this.#relativeToListener(position);
      const distance = Math.sqrt(
        relative.right * relative.right +
          relative.up * relative.up +
          relative.forward * relative.forward,
      );
      if (distance > this.#maxDistance) {
        return false;
      }
      gain *= distanceAttenuation(distance, this.#referenceDistance, this.#rolloffFactor);
      pan =
        clamp01(Math.abs(relative.right) / this.#maxDistance) * Math.sign(relative.right) * 0.85;
    }

    if (gain <= 0 || this.isMuted) {
      return false;
    }

    const playOptions: { when?: number; gain: number; pan?: number; maxVoices: number } = {
      gain,
      maxVoices: this.#voiceLimit,
    };
    if (options.delay !== undefined) {
      playOptions.when = options.delay;
    }
    if (pan !== undefined) {
      playOptions.pan = pan;
    }
    return synthesizer.play(name, channel, playOptions);
  }

  /**
   * 设置听者姿态；`playSound` 的位置参数以它为参照。
   *
   * @param pose - 位置与朝向（yaw 弧度，0 朝 -Z）。
   */
  public setListenerPose(pose: ListenerPose): void {
    if (
      !Number.isFinite(pose.position.x) ||
      !Number.isFinite(pose.position.y) ||
      !Number.isFinite(pose.position.z)
    ) {
      return;
    }
    this.#listener = {
      position: { x: pose.position.x, y: pose.position.y, z: pose.position.z },
      yaw: Number.isFinite(pose.yaw) ? pose.yaw : 0,
    };
  }

  /** 当前听者姿态的副本。 */
  public getListenerPose(): ListenerPose {
    return { position: { ...this.#listener.position }, yaw: this.#listener.yaw };
  }

  /**
   * 用玩家设置更新三路音量。
   *
   * @param settings - 至少包含三个音量字段的设置对象。
   */
  public applySettings(
    settings: Pick<GameSettings, 'masterVolume' | 'sfxVolume' | 'ambientVolume'>,
  ): void {
    this.setVolumes({
      master: settings.masterVolume,
      sfx: settings.sfxVolume,
      ambient: settings.ambientVolume,
    });
  }

  /**
   * 直接设置三路音量（跳过 `v²` 感知曲线之外的处理）。
   *
   * @param volumes - 需要更新的通道；未提供的通道保持不变。
   */
  public setVolumes(volumes: Partial<AudioVolumes>): void {
    if (volumes.master !== undefined) {
      this.#volumes.master = clamp01(volumes.master);
    }
    if (volumes.sfx !== undefined) {
      this.#volumes.sfx = clamp01(volumes.sfx);
    }
    if (volumes.ambient !== undefined) {
      this.#volumes.ambient = clamp01(volumes.ambient);
    }
    this.#applyVolumeGains();
  }

  /**
   * 开关环境音（风声循环）。
   *
   * 未解锁时只记录意图，`unlock()` 成功后自动开始播放；降级状态下为空操作。
   *
   * @param playing - 是否播放环境音。
   */
  public setAmbientPlaying(playing: boolean): void {
    this.#ambientPlaying = playing;
    if (this.#status !== 'running') {
      if (!playing) {
        this.#stopAmbientSource();
      }
      return;
    }
    if (playing) {
      this.#startAmbientSource();
    } else {
      this.#stopAmbientSource();
    }
  }

  /** 环境音当前是否在播放。 */
  public get isAmbientPlaying(): boolean {
    return this.#ambientSource !== null;
  }

  /**
   * 释放全部音频资源。
   *
   * I. 顺序很重要
   *
   * 1. 先断开节点、停止循环源（同步完成），因此即使调用方忘记 `await`，节点也已经从图上
   *    摘除，不会有残留声音。
   * 2. 最后才 `close()` 上下文：关闭会异步释放音频线程，失败也只记 warn。
   */
  public async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;

    this.#stopAmbientSource();
    this.#synthesizer?.dispose();
    this.#synthesizer = null;

    for (const node of [this.#sfx, this.#ambient, this.#master]) {
      if (node === null) {
        continue;
      }
      try {
        node.disconnect();
      } catch {
        // 已断开的节点再次 disconnect 会抛异常；清理路径必须容错。
      }
    }

    const context = this.#context;
    this.#context = null;
    this.#sfx = null;
    this.#ambient = null;
    this.#master = null;
    this.#status = 'disposed';

    if (context !== null) {
      try {
        await context.close();
      } catch (error) {
        this.#logger.warn('音频上下文关闭失败', error);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 内部实现
  // -------------------------------------------------------------------------

  /**
   * 构建 `合成器 → sfx/ambient → master → destination` 节点图。
   *
   * 任何一步失败都向上抛，由 `unlock` 统一降级；这里不做局部修补，因为半张图的声音
   * 表现是不可预测的。
   */
  #buildGraph(context: AudioContextLike): void {
    const master = context.createGain();
    const sfx = context.createGain();
    const ambient = context.createGain();

    master.connect(context.destination);
    sfx.connect(master);
    ambient.connect(master);

    this.#master = master;
    this.#sfx = sfx;
    this.#ambient = ambient;
    this.#synthesizer = new SoundSynthesizer(context, { voiceLimit: this.#voiceLimit });
    this.#applyVolumeGains();
  }

  #applyVolumeGains(): void {
    if (this.#master !== null) {
      this.#master.gain.value = perceptualVolume(this.#volumes.master);
    }
    if (this.#sfx !== null) {
      this.#sfx.gain.value = perceptualVolume(this.#volumes.sfx);
    }
    if (this.#ambient !== null) {
      this.#ambient.gain.value = perceptualVolume(this.#volumes.ambient);
    }
  }

  #channelGain(channel: AudioChannel): GainNodeLike | null {
    return channel === 'ambient' ? this.#ambient : this.#sfx;
  }

  /**
   * 把世界坐标转成听者坐标系下的 `right/up/forward` 分量。
   *
   * 1. yaw 为 0 时前方是 -Z、右方是 +X（Three.js 约定）。
   * 2. 只做水平旋转：音频声像取决于左右分量，俯仰不影响左右。
   */
  #relativeToListener(position: Vec3Like): {
    readonly right: number;
    readonly up: number;
    readonly forward: number;
  } {
    const dx = position.x - this.#listener.position.x;
    const dy = position.y - this.#listener.position.y;
    const dz = position.z - this.#listener.position.z;
    const cos = Math.cos(this.#listener.yaw);
    const sin = Math.sin(this.#listener.yaw);
    return {
      right: dx * cos - dz * sin,
      up: dy,
      forward: -dx * sin - dz * cos,
    };
  }

  /** 启动风声循环；已启动时为空操作。 */
  #startAmbientSource(): void {
    const context = this.#context;
    const ambient = this.#ambient;
    if (context === null || ambient === null || this.#ambientSource !== null) {
      return;
    }
    try {
      const source = context.createBufferSource();
      // 种子固定：风声必须可复现，且与其他音效的噪声不相关。
      source.buffer = createNoiseBuffer(context, 0x57_49_4e_44, 2);
      source.loop = true;
      source.playbackRate.value = 0.6;

      let tail: AudioNodeLike = source;
      // I. 直接通过上下文调用可选工厂，而不是先把方法取出来：
      // 1. 取出方法再 `.call(context)` 会丢失 `this` 绑定（真实实现需要 `this` 是上下文），
      //    也是静态检查明确禁止的写法。
      if (context.createBiquadFilter !== undefined) {
        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 420;
        filter.Q.value = 0.7;
        this.#ambientFilter = filter;
        source.connect(filter);
        tail = filter;
      }
      tail.connect(ambient);
      source.start();
      this.#ambientSource = source;
    } catch (error) {
      this.#logger.warn('环境音启动失败，将只播放音效', error);
      this.#stopAmbientSource();
    }
  }

  /** 停止风声循环并断开节点；未播放时为空操作。 */
  #stopAmbientSource(): void {
    const source = this.#ambientSource;
    const filter = this.#ambientFilter;
    this.#ambientSource = null;
    this.#ambientFilter = null;
    if (source !== null) {
      try {
        source.stop();
      } catch {
        // 已停止的源节点会抛 InvalidStateError；忽略。
      }
      try {
        source.disconnect();
      } catch {
        // 同上。
      }
    }
    if (filter !== null) {
      try {
        filter.disconnect();
      } catch {
        // 同上。
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 浏览器实现适配
// ---------------------------------------------------------------------------

/** 最小构造签名；`webkitAudioContext` 在旧版 Safari 上使用同一签名。 */
type AudioContextConstructor = new () => AudioContext;

/**
 * 创建并适配浏览器 `AudioContext`。
 *
 * @throws {AppError} 环境没有 `AudioContext` 实现时抛 `AUDIO_INIT_FAILED`；调用方
 *         （`AudioManager.unlock`）会把它降级为静音。
 */
export function createBrowserAudioContext(): AudioContextLike {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (Constructor === undefined) {
    throw new AppError('AUDIO_INIT_FAILED', '当前环境没有可用的 AudioContext 实现');
  }
  return adaptAudioContext(new Constructor());
}

/**
 * 把真实 `AudioContext` 适配成 {@link AudioContextLike}。
 *
 * I. 为什么必须维护"包装对象 → 原生节点"的注册表
 *
 * 1. 收窄接口里的节点是普通对象（只有这样才能让测试注入替身），而原生
 *    `AudioNode.connect()` 只接受真正的 `AudioNode`。把包装对象直接交给原生方法会抛
 *    `TypeError: Failed to execute 'connect' on 'AudioNode': Overload resolution failed.`
 * 2. 因此每个包装节点都在这里登记它对应的原生节点，连线时先还原再调用；"跨上下文连线"
 *    也变成一个带明确信息的错误，而不是难以定位的运行时异常。
 *
 * II. 其余断言的边界
 *
 * `OscillatorNode.type` 还允许 `'custom'`（本项目不使用 PeriodicWave），滤波器也只用到
 * lowpass/highpass/bandpass；这些收窄只影响引擎不使用的取值。
 */
function adaptAudioContext(context: AudioContext): AudioContextLike {
  // I. 注册表与还原工具
  const natives = new WeakMap<AudioNodeLike, AudioNode>();

  const resolveNode = (value: AudioNodeLike): AudioNode => {
    const native = natives.get(value);
    if (native === undefined) {
      throw new AppError(
        'AUDIO_INIT_FAILED',
        '音频节点不属于当前 AudioContext，无法连线（可能是跨上下文复用了节点）',
      );
    }
    return native;
  };

  const register = <T extends AudioNodeLike>(wrapper: T, native: AudioNode): T => {
    natives.set(wrapper, native);
    return wrapper;
  };

  /** 所有节点共有的连线行为；`connect` 会把包装对象还原成原生节点。 */
  const linkable = (native: AudioNode): Pick<AudioNodeLike, 'connect' | 'disconnect'> => ({
    connect: (destination: AudioNodeLike): unknown => native.connect(resolveNode(destination)),
    disconnect: (): void => {
      native.disconnect();
    },
  });

  const param = (native: AudioParam): AudioParamLike => ({
    get value(): number {
      return native.value;
    },
    set value(next: number) {
      native.value = next;
    },
    setValueAtTime: (value: number, startTime: number): unknown =>
      native.setValueAtTime(value, startTime),
    linearRampToValueAtTime: (value: number, endTime: number): unknown =>
      native.linearRampToValueAtTime(value, endTime),
    exponentialRampToValueAtTime: (value: number, endTime: number): unknown =>
      native.exponentialRampToValueAtTime(value, endTime),
    cancelScheduledValues: (startTime: number): unknown => native.cancelScheduledValues(startTime),
  });

  const wrapGain = (native: GainNode): GainNodeLike =>
    register({ ...linkable(native), gain: param(native.gain) }, native);

  const wrapOscillator = (native: OscillatorNode): OscillatorNodeLike =>
    register(
      {
        ...linkable(native),
        get type(): OscillatorTypeLike {
          // `custom` 只在使用 PeriodicWave 时出现，本项目从不使用。
          return native.type as OscillatorTypeLike;
        },
        set type(next: OscillatorTypeLike) {
          native.type = next;
        },
        frequency: param(native.frequency),
        detune: param(native.detune),
        start: (when?: number): void => {
          scheduleStart(native, when);
        },
        stop: (when?: number): void => {
          scheduleStop(native, when);
        },
      },
      native,
    );

  const wrapBufferSource = (native: AudioBufferSourceNode): AudioBufferSourceNodeLike =>
    register(
      {
        ...linkable(native),
        get buffer(): AudioBuffer | null {
          return native.buffer;
        },
        set buffer(next: AudioBufferLike | null) {
          // `createBuffer()` 返回的就是原生 AudioBuffer（它本身已满足 AudioBufferLike），
          // 因此这里没有包装层需要还原；引擎唯一的数据来源就是它。
          native.buffer = next as AudioBuffer | null;
        },
        get loop(): boolean {
          return native.loop;
        },
        set loop(next: boolean) {
          native.loop = next;
        },
        playbackRate: param(native.playbackRate),
        start: (when?: number): void => {
          scheduleStart(native, when);
        },
        stop: (when?: number): void => {
          scheduleStop(native, when);
        },
      },
      native,
    );

  const wrapFilter = (native: BiquadFilterNode): BiquadFilterNodeLike =>
    register(
      {
        ...linkable(native),
        get type(): BiquadFilterTypeLike {
          // 只使用 lowpass/highpass/bandpass；其余类型在收窄接口外，退化为 lowpass。
          const current = native.type;
          return current === 'lowpass' || current === 'highpass' || current === 'bandpass'
            ? current
            : 'lowpass';
        },
        set type(next: BiquadFilterTypeLike) {
          native.type = next;
        },
        frequency: param(native.frequency),
        Q: param(native.Q),
      },
      native,
    );

  const wrapPanner = (native: StereoPannerNode): StereoPannerNodeLike =>
    register({ ...linkable(native), pan: param(native.pan) }, native);

  // II. 可选能力：缺失时不要定义该属性。
  // 1. `exactOptionalPropertyTypes` 下 `createBiquadFilter: undefined` 不可赋值给可选方法，
  //    因此用条件展开而不是赋 undefined。
  const optional = {
    ...(typeof context.createBiquadFilter === 'function'
      ? {
          createBiquadFilter: (): BiquadFilterNodeLike => wrapFilter(context.createBiquadFilter()),
        }
      : {}),
    ...(typeof context.createStereoPanner === 'function'
      ? {
          createStereoPanner: (): StereoPannerNodeLike => wrapPanner(context.createStereoPanner()),
        }
      : {}),
  };

  // III. 一次性构造上下文本体。
  // 1. **不要**先把带 getter 的对象字面量存进变量再 `{ ...base }`：展开会调用 getter 并把
  //    求值结果固化成静态属性，于是 `state` 会永远停在被创建时的 `'suspended'`，
  //    `unlock()` 永远等不到 `running`——游戏静默无声，且没有任何报错。
  // 2. 因此 `state`/`currentTime`/`sampleRate` 必须是这个最终对象上的实时取值器。
  return {
    get state(): AudioContextStateLike {
      // `AudioContextState` 只有 closed/running/suspended，是收窄接口的子集，无需断言。
      return context.state;
    },
    get currentTime(): number {
      return context.currentTime;
    },
    get sampleRate(): number {
      return context.sampleRate;
    },
    destination: register(linkable(context.destination), context.destination),
    createGain: (): GainNodeLike => wrapGain(context.createGain()),
    createOscillator: (): OscillatorNodeLike => wrapOscillator(context.createOscillator()),
    createBufferSource: (): AudioBufferSourceNodeLike =>
      wrapBufferSource(context.createBufferSource()),
    createBuffer: (channels: number, length: number, sampleRate: number): AudioBuffer =>
      context.createBuffer(Math.max(1, channels), Math.max(1, length), sampleRate),
    resume: (): Promise<void> => context.resume(),
    suspend: (): Promise<void> => context.suspend(),
    close: (): Promise<void> => context.close(),
    ...optional,
  };
}

/** `start(when?)` 的空参数调用与带参调用在 DOM 里是两个重载，这里归一化。 */
function scheduleStart(target: { start(when?: number): void }, when: number | undefined): void {
  if (when === undefined) {
    target.start();
  } else {
    target.start(when);
  }
}

/** `stop(when?)` 同上。 */
function scheduleStop(target: { stop(when?: number): void }, when: number | undefined): void {
  if (when === undefined) {
    target.stop();
  } else {
    target.stop(when);
  }
}
