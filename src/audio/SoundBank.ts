/**
 * Procedural sound bank: every game sound is synthesised at runtime.
 *
 * I. 为什么完全不用音频文件
 *
 * 1. 音效文件意味着网络请求、解码、CORS 与缓存策略；一期游戏只需要几十个很短的声音，
 *    用振荡器 + 噪声缓冲 + 包络合成可以做到零资源、零加载时间、零体积。
 * 2. 合成参数是"数据"而不是"音频二进制"，因此每个音效都可以被单元测试断言：一次
 *    `play()` 会创建哪些节点、包络如何调度、时长多少。
 *
 * II. 为什么噪声必须是确定性随机
 *
 * 1. 噪声缓冲用 mulberry32 以固定种子生成。"听起来随机"和"每次运行都相同"并不矛盾，
 *    但只有后者才能让回归测试稳定（同一音效两次生成的采样序列必须逐点相等）。
 * 2. 每个音效的种子由音效名哈希得到，因此石头的破碎声在任意两台机器上完全一致。
 *
 * III. 合成配方（Recipe）的结构
 *
 * 1. 一个音效 = 若干层（Layer），每层是一个振荡器或一段噪声。
 * 2. 每层有独立的起始时间、时长、峰值增益与包络，叠加后就是最终音色。例如石头破碎 =
 *    低频"闷响"（正弦扫频下行）+ 中频噪声（低通）。
 *
 * @module audio/SoundBank
 */

import {
  MIN_GAIN,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike,
  type AudioNodeLike,
  type AudioParamLike,
  type BiquadFilterNodeLike,
  type BiquadFilterTypeLike,
  type OscillatorNodeLike,
  type OscillatorTypeLike,
  type StereoPannerNodeLike,
} from './audioTypes';

// ---------------------------------------------------------------------------
// 音效名称
// ---------------------------------------------------------------------------

/** 方块材质分组；破坏与脚步声按材质取音色。 */
export type SoundMaterial =
  'stone' | 'dirt' | 'grass' | 'sand' | 'wood' | 'glass' | 'water' | 'snow';

/** 需要按材质细分的行为。 */
export type MaterialAction = 'break' | 'footstep';

/** 全部音效名。 */
export type SoundName =
  | `block.break.${SoundMaterial}`
  | `footstep.${SoundMaterial}`
  | 'block.place'
  | 'player.jump'
  | 'player.land'
  | 'ui.click'
  | 'item.pickup';

/** 材质列表，供 UI/调试面板遍历。 */
export const SOUND_MATERIALS: readonly SoundMaterial[] = [
  'stone',
  'dirt',
  'grass',
  'sand',
  'wood',
  'glass',
  'water',
  'snow',
];

/** 全部音效名，顺序固定以保证调试面板与测试稳定。 */
export const SOUND_NAMES: readonly SoundName[] = [
  ...SOUND_MATERIALS.map((material): SoundName => `block.break.${material}`),
  ...SOUND_MATERIALS.map((material): SoundName => `footstep.${material}`),
  'block.place',
  'player.jump',
  'player.land',
  'ui.click',
  'item.pickup',
];

/**
 * 方块名 → 音效材质。
 *
 * I. 为什么不在这里 import 方块注册表
 *
 * 1. 音频层只需要"材质"这一抽象，认识 `BlockId` 会把音频层与方块表编号绑死；方块表一旦
 *    增删条目，音频层也要跟着改。
 * 2. 调用方（交互层）传入 `definitionOf(id).name` 即可，映射表保持为纯数据 + 纯函数，
 *    因此可以独立测试，也不会引入任何 Three.js 依赖。
 *
 * 未登记的方块（未来新增的类型）回退到 `stone`：一个"能听见但音色不对"的声音，远好于
 * 一个静默的世界。
 */
const MATERIAL_BY_BLOCK_NAME: Readonly<Record<string, SoundMaterial>> = {
  stone: 'stone',
  cobblestone: 'stone',
  bedrock: 'stone',
  gravel: 'stone',
  sandstone: 'stone',
  coalOre: 'stone',
  ironOre: 'stone',
  goldOre: 'stone',
  diamondOre: 'stone',
  brick: 'stone',
  lamp: 'glass',
  dirt: 'dirt',
  grass: 'grass',
  sand: 'sand',
  log: 'wood',
  planks: 'wood',
  leaves: 'grass',
  glass: 'glass',
  water: 'water',
  ice: 'glass',
  snow: 'snow',
};

/** 默认材质；未知方块与空手事件都使用它。 */
export const DEFAULT_SOUND_MATERIAL: SoundMaterial = 'stone';

/**
 * 查询方块的音效材质。
 *
 * @param blockName - `BlockDefinition.name`。
 * @returns 匹配的材质，未登记时返回 {@link DEFAULT_SOUND_MATERIAL}。
 */
export function materialForBlockName(blockName: string): SoundMaterial {
  return MATERIAL_BY_BLOCK_NAME[blockName] ?? DEFAULT_SOUND_MATERIAL;
}

/**
 * 生成"行为 + 材质"对应的音效名。
 *
 * @param action - 破坏或脚步。
 * @param material - 方块材质。
 * @returns 可直接交给 `AudioManager.playSound` 的名称。
 */
export function soundNameFor(action: MaterialAction, material: SoundMaterial): SoundName {
  return action === 'break' ? `block.break.${material}` : `footstep.${material}`;
}

/** 运行时校验：字符串是否是已知音效名。 */
export function isSoundName(value: string): value is SoundName {
  return (SOUND_NAMES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 配方结构
// ---------------------------------------------------------------------------

/** 振荡器层。 */
export interface ToneLayer {
  readonly kind: 'tone';
  readonly wave: OscillatorTypeLike;
  /** 起始频率，Hz。 */
  readonly frequency: number;
  /** 结束频率；等于起始频率时不扫频。 */
  readonly endFrequency: number;
  /** 该层相对音效起点的延迟，秒。 */
  readonly delay: number;
  /** 发声时长，秒。 */
  readonly duration: number;
  /** 该层峰值增益。 */
  readonly gain: number;
  /** 起音时长，秒；过长会听不出"打击感"。 */
  readonly attack: number;
}

/** 噪声层。 */
export interface NoiseLayer {
  readonly kind: 'noise';
  readonly delay: number;
  readonly duration: number;
  readonly gain: number;
  readonly attack: number;
  /** 噪声种子；相同种子生成相同采样序列。 */
  readonly seed: number;
  /** 播放速率；大于 1 会让噪声更"细"，用于沙/雪。 */
  readonly playbackRate: number;
  /** 可选的带通/低通滤波；`null` 表示不过滤。 */
  readonly filter: {
    readonly type: BiquadFilterTypeLike;
    readonly frequency: number;
    readonly q: number;
  } | null;
}

/** 一层合成。 */
export type SoundLayer = ToneLayer | NoiseLayer;

/** 一个完整音效的配方。 */
export interface SoundRecipe {
  /** 峰值缩放；不同音效之间的相对响度。 */
  readonly gain: number;
  /** 总时长（不含层延迟），秒；用于节点回收调度。 */
  readonly duration: number;
  readonly layers: readonly SoundLayer[];
}

interface ToneOptions {
  readonly endFrequency?: number;
  readonly delay?: number;
  readonly attack?: number;
}

interface NoiseOptions {
  readonly delay?: number;
  readonly attack?: number;
  readonly seed?: number;
  readonly playbackRate?: number;
  readonly filter?: {
    readonly type: BiquadFilterTypeLike;
    readonly frequency: number;
    readonly q?: number;
  };
}

function tone(
  wave: OscillatorTypeLike,
  frequency: number,
  duration: number,
  gain: number,
  options: ToneOptions = {},
): ToneLayer {
  return {
    kind: 'tone',
    wave,
    frequency,
    endFrequency: options.endFrequency ?? frequency,
    delay: options.delay ?? 0,
    duration,
    gain,
    attack: options.attack ?? 0.003,
  };
}

function noise(duration: number, gain: number, options: NoiseOptions = {}): NoiseLayer {
  const filter = options.filter;
  return {
    kind: 'noise',
    delay: options.delay ?? 0,
    duration,
    gain,
    attack: options.attack ?? 0.002,
    seed: options.seed ?? 1,
    playbackRate: options.playbackRate ?? 1,
    filter:
      filter === undefined
        ? null
        : { type: filter.type, frequency: filter.frequency, q: filter.q ?? 1 },
  };
}

/**
 * 全部合成配方。
 *
 * I. 设计意图
 *
 * 1. 破坏音以"噪声爆裂 + 低频闷响"为骨架，材质差异体现在滤波频率与低频音高上：石头最硬
 *    最亮，泥土闷，木头有共鸣，玻璃是高频碎裂，沙子是细碎的高频噪声，水是下行的低频。
 * 2. 脚步音刻意做得短（60~160 ms）且轻，否则连续行走会糊成一片。
 * 3. 界面点击与拾取用极短的方波/三角波，符合"电子提示音"的直觉。
 */
export const SOUND_RECIPES: Readonly<Record<SoundName, SoundRecipe>> = {
  // I. 方块破坏（按材质）
  'block.break.stone': {
    gain: 0.9,
    duration: 0.19,
    layers: [
      tone('triangle', 150, 0.17, 0.5, { endFrequency: 82 }),
      noise(0.15, 0.75, { filter: { type: 'lowpass', frequency: 1400, q: 0.8 } }),
      noise(0.06, 0.35, { filter: { type: 'highpass', frequency: 2200, q: 0.7 } }),
    ],
  },
  'block.break.dirt': {
    gain: 0.85,
    duration: 0.2,
    layers: [
      tone('sine', 110, 0.18, 0.45, { endFrequency: 62 }),
      noise(0.19, 0.6, { filter: { type: 'lowpass', frequency: 620, q: 0.9 } }),
    ],
  },
  'block.break.grass': {
    gain: 0.8,
    duration: 0.22,
    layers: [
      tone('sine', 130, 0.16, 0.35, { endFrequency: 78 }),
      noise(0.21, 0.5, { filter: { type: 'bandpass', frequency: 2600, q: 0.9 }, seed: 3 }),
    ],
  },
  'block.break.sand': {
    gain: 0.75,
    duration: 0.26,
    layers: [
      noise(0.25, 0.55, { filter: { type: 'bandpass', frequency: 2400, q: 0.7 }, seed: 5 }),
      noise(0.12, 0.3, {
        filter: { type: 'lowpass', frequency: 900, q: 0.8 },
        seed: 6,
        delay: 0.03,
      }),
    ],
  },
  'block.break.wood': {
    gain: 0.9,
    duration: 0.24,
    layers: [
      tone('triangle', 220, 0.2, 0.5, { endFrequency: 130 }),
      tone('sine', 430, 0.14, 0.22, { endFrequency: 300, delay: 0.01 }),
      noise(0.14, 0.42, { filter: { type: 'bandpass', frequency: 1100, q: 0.9 }, seed: 7 }),
    ],
  },
  'block.break.glass': {
    gain: 0.85,
    duration: 0.3,
    layers: [
      tone('triangle', 2400, 0.12, 0.35, { endFrequency: 2000 }),
      tone('triangle', 3300, 0.16, 0.28, { endFrequency: 2600, delay: 0.015 }),
      tone('square', 1700, 0.09, 0.14, { endFrequency: 1500, delay: 0.03 }),
      noise(0.22, 0.5, { filter: { type: 'highpass', frequency: 3200, q: 0.7 }, seed: 11 }),
    ],
  },
  'block.break.water': {
    gain: 0.8,
    duration: 0.36,
    layers: [
      tone('sine', 420, 0.3, 0.35, { endFrequency: 150 }),
      noise(0.34, 0.45, { filter: { type: 'lowpass', frequency: 800, q: 1.1 }, seed: 13 }),
    ],
  },
  'block.break.snow': {
    gain: 0.7,
    duration: 0.22,
    layers: [
      noise(0.2, 0.5, { filter: { type: 'highpass', frequency: 2600, q: 0.6 }, seed: 17 }),
      tone('sine', 180, 0.14, 0.2, { endFrequency: 110 }),
    ],
  },

  // II. 放置
  'block.place': {
    gain: 0.8,
    duration: 0.16,
    layers: [
      tone('sine', 240, 0.13, 0.55, { endFrequency: 150 }),
      noise(0.07, 0.35, { filter: { type: 'lowpass', frequency: 1800, q: 0.8 }, seed: 19 }),
    ],
  },

  // III. 脚步（按地面材质）
  'footstep.stone': {
    gain: 0.45,
    duration: 0.09,
    layers: [
      noise(0.075, 0.7, { filter: { type: 'lowpass', frequency: 1500, q: 0.8 }, seed: 23 }),
      tone('triangle', 130, 0.06, 0.3, { endFrequency: 90 }),
    ],
  },
  'footstep.dirt': {
    gain: 0.4,
    duration: 0.1,
    layers: [noise(0.09, 0.65, { filter: { type: 'lowpass', frequency: 700, q: 0.9 }, seed: 29 })],
  },
  'footstep.grass': {
    gain: 0.38,
    duration: 0.11,
    layers: [noise(0.1, 0.6, { filter: { type: 'bandpass', frequency: 2200, q: 0.8 }, seed: 31 })],
  },
  'footstep.sand': {
    gain: 0.42,
    duration: 0.13,
    layers: [
      noise(0.12, 0.55, {
        filter: { type: 'highpass', frequency: 1500, q: 0.7 },
        seed: 37,
        playbackRate: 1.1,
      }),
    ],
  },
  'footstep.wood': {
    gain: 0.45,
    duration: 0.1,
    layers: [
      noise(0.055, 0.4, { filter: { type: 'lowpass', frequency: 900, q: 0.9 }, seed: 41 }),
      tone('triangle', 165, 0.09, 0.4, { endFrequency: 120 }),
    ],
  },
  'footstep.water': {
    gain: 0.5,
    duration: 0.18,
    layers: [
      noise(0.16, 0.6, { filter: { type: 'lowpass', frequency: 1100, q: 1.2 }, seed: 43 }),
      tone('sine', 380, 0.12, 0.2, { endFrequency: 200, delay: 0.01 }),
    ],
  },
  'footstep.snow': {
    gain: 0.35,
    duration: 0.14,
    layers: [
      noise(0.13, 0.6, {
        filter: { type: 'highpass', frequency: 3000, q: 0.6 },
        seed: 47,
        playbackRate: 0.9,
      }),
    ],
  },
  'footstep.glass': {
    gain: 0.42,
    duration: 0.1,
    layers: [
      noise(0.05, 0.35, { filter: { type: 'highpass', frequency: 2600, q: 0.7 }, seed: 53 }),
      tone('triangle', 900, 0.06, 0.2, { endFrequency: 700 }),
    ],
  },

  // IV. 玩家动作
  'player.jump': {
    gain: 0.5,
    duration: 0.16,
    layers: [
      tone('sine', 300, 0.13, 0.4, { endFrequency: 620, attack: 0.008 }),
      noise(0.12, 0.18, { filter: { type: 'bandpass', frequency: 1200, q: 0.9 }, seed: 59 }),
    ],
  },
  'player.land': {
    gain: 0.85,
    duration: 0.2,
    layers: [
      tone('sine', 165, 0.16, 0.6, { endFrequency: 70 }),
      noise(0.14, 0.45, { filter: { type: 'lowpass', frequency: 900, q: 0.9 }, seed: 61 }),
    ],
  },

  // V. 界面与物品
  'ui.click': {
    gain: 0.35,
    duration: 0.06,
    layers: [tone('square', 900, 0.045, 0.5, { endFrequency: 780 })],
  },
  'item.pickup': {
    gain: 0.4,
    duration: 0.16,
    layers: [
      tone('triangle', 700, 0.09, 0.5, { endFrequency: 900 }),
      tone('triangle', 1050, 0.1, 0.4, { endFrequency: 1300, delay: 0.05 }),
    ],
  },
};

// ---------------------------------------------------------------------------
// 合成器
// ---------------------------------------------------------------------------

/** 一次发声的可选参数。 */
export interface SynthPlayOptions {
  /** 相对当前时间的延迟，秒。 */
  readonly when?: number;
  /** 额外增益倍数（距离衰减的结果），`0 .. 1`。 */
  readonly gain?: number;
  /** 立体声声像，`-1`（左）到 `1`（右）；上下文不支持时忽略。 */
  readonly pan?: number;
  /** 本次发声使用的最大同时声音数；默认取合成器的全局上限。 */
  readonly maxVoices?: number;
}

/** 默认同时发声上限；超过后丢弃新声音，避免连点造成节点爆炸。 */
export const DEFAULT_VOICE_LIMIT = 24;

/** 噪声缓冲时长，秒；所有噪声层共用同一份按种子生成的缓冲。 */
const NOISE_BUFFER_SECONDS = 1.2;

/** 节点回收的额外余量，秒。 */
const CLEANUP_MARGIN_SECONDS = 0.05;

interface ActiveVoice {
  readonly sources: readonly (OscillatorNodeLike | AudioBufferSourceNodeLike)[];
  readonly nodes: readonly AudioNodeLike[];
}

/**
 * mulberry32：小而快的可复现伪随机数发生器。
 *
 * 用它而不是 `Math.random()` 的唯一原因是可复现：同一个种子必须产生同一段噪声，
 * 否则噪声相关的回归测试无法稳定。
 */
function createRandom(seed: number): () => number {
  let state = (seed >>> 0) + 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

/**
 * 把音效名哈希成一个稳定的正整数种子。
 *
 * 用 FNV-1a：短字符串上分布够好，且实现只有几行、没有依赖。
 */
function hashSeed(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash === 0 ? 1 : hash;
}

/**
 * 在参数上调度"起音 → 指数衰减"包络。
 *
 * I. 为什么目标是 `MIN_GAIN` 而不是 0
 *
 * 1. `exponentialRampToValueAtTime` 的终点必须严格大于 0，传 0 会抛 `RangeError`。
 * 2. 从 `MIN_GAIN` 起音也同样必要：从 0 线性起音会有可闻的"咔哒"声。
 */
function scheduleEnvelope(
  param: AudioParamLike,
  startTime: number,
  peak: number,
  attack: number,
  duration: number,
): void {
  const target = Math.max(peak, MIN_GAIN);
  const attackEnd = startTime + clamp(attack, 0.001, duration * 0.5);
  param.cancelScheduledValues(startTime);
  param.setValueAtTime(MIN_GAIN, startTime);
  param.linearRampToValueAtTime(target, attackEnd);
  param.exponentialRampToValueAtTime(MIN_GAIN, startTime + duration);
}

/** 在参数上调度频率扫描；扫频只支持指数（听感上才是线性的音高变化）。 */
function scheduleSweep(
  param: AudioParamLike,
  startTime: number,
  from: number,
  to: number,
  duration: number,
): void {
  param.setValueAtTime(Math.max(from, 1), startTime);
  if (to !== from) {
    param.exponentialRampToValueAtTime(Math.max(to, 1), startTime + duration);
  }
}

/**
 * 生成一段确定性的白噪声缓冲。
 *
 * I. 为什么导出而不是留在合成器内部
 *
 * 1. 环境音（风声）需要一段可循环的噪声，它由 `AudioManager` 自己维护循环源；把生成逻辑
 *    放在这里可以让"噪声 = 固定种子"这条规则只有一个实现。
 * 2. 采样率取上下文采样率，因此不同设备上的缓冲长度不同，但"同一设备上同一秒数 → 同一
 *    采样序列"始终成立。
 *
 * @param context - 用于创建缓冲的上下文。
 * @param seed - 随机种子；相同种子产生相同采样序列。
 * @param seconds - 缓冲时长，秒。
 * @returns 单声道、取值范围 `-1 .. 1` 的噪声缓冲。
 */
export function createNoiseBuffer(
  context: AudioContextLike,
  seed: number,
  seconds: number,
): AudioBufferLike {
  const sampleRate = Math.max(8000, Math.floor(context.sampleRate));
  const length = Math.max(1, Math.floor(sampleRate * Math.max(seconds, 0.01)));
  const buffer = context.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  const random = createRandom(seed);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = random() * 2 - 1;
  }
  return buffer;
}

/**
 * 程序化音效合成器。
 *
 * I. 职责边界
 *
 * 1. 只负责"把配方变成节点图并调度时间"，不认识音量设置、距离衰减、用户手势：
 *    那些属于 `AudioManager`。
 * 2. 持有节点回收责任：每次发声登记一个 voice，到期（或 `dispose`）后停止并断开所有
 *    节点。少了这一步，长时间游戏会泄漏成千上万个 `AudioNode`，最终拖慢音频线程。
 */
export class SoundSynthesizer {
  readonly #context: AudioContextLike;
  readonly #voiceLimit: number;
  readonly #noiseBuffers = new Map<number, AudioBufferLike>();
  readonly #voices = new Set<ActiveVoice>();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  #playedCount = 0;
  #disposed = false;

  public constructor(context: AudioContextLike, options: { readonly voiceLimit?: number } = {}) {
    this.#context = context;
    const limit = options.voiceLimit;
    // 非有限值会污染后续的 `>=` 比较，使声部上限静默失效。
    this.#voiceLimit =
      limit === undefined || !Number.isFinite(limit)
        ? DEFAULT_VOICE_LIMIT
        : Math.max(1, Math.floor(limit));
  }

  /** 累计成功调度的发声次数；调试与测试用。 */
  public get playedCount(): number {
    return this.#playedCount;
  }

  /** 当前仍在发声（尚未回收）的声音数。 */
  public get activeVoices(): number {
    return this.#voices.size;
  }

  /** 是否已释放；释放后 `play` 恒返回 `false`。 */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /**
   * 播放一个合成音效。
   *
   * @param name - 音效名。
   * @param destination - 目标节点（通常是某一路增益节点）。
   * @param options - 延迟、增益倍数与声像。
   * @returns 是否真的调度了发声；未知音效、已达上限或已释放时返回 `false`。
   */
  public play(
    name: SoundName,
    destination: AudioNodeLike,
    options: SynthPlayOptions = {},
  ): boolean {
    if (this.#disposed) {
      return false;
    }
    const recipe = SOUND_RECIPES[name];
    if (recipe === undefined) {
      return false;
    }
    const limit = options.maxVoices ?? this.#voiceLimit;
    if (this.#voices.size >= limit) {
      return false;
    }

    const gainScale = clamp(options.gain ?? 1, 0, 1);
    if (gainScale <= 0) {
      return false;
    }

    // I. 起点留 1 ms 余量，避免把事件调度到"当前时刻之前"而被浏览器吞掉。
    const start = this.#context.currentTime + Math.max(options.when ?? 0, 0) + 0.001;

    // II. 每个声音一个输出增益节点：
    // 1. 配方增益与距离衰减在这里相乘，下游音量变化不会破坏已调度的时间线。
    // 2. 声像节点插在它与目标之间；老浏览器没有 StereoPanner 时退化为单声道。
    const output = this.#context.createGain();
    output.gain.value = clamp(recipe.gain * gainScale, MIN_GAIN, 1);

    const nodes: AudioNodeLike[] = [output];
    let tail: AudioNodeLike = output;
    const panner = this.#createPanner(options.pan);
    if (panner !== null) {
      nodes.push(panner);
      panner.connect(destination);
      tail = panner;
    } else {
      output.connect(destination);
    }

    const sources: (OscillatorNodeLike | AudioBufferSourceNodeLike)[] = [];
    let layerEnd = 0;

    for (const layer of recipe.layers) {
      const layerStart = start + Math.max(layer.delay, 0);
      const layerEndLocal = layerStart + layer.duration;
      const layerGain = this.#context.createGain();
      nodes.push(layerGain);
      scheduleEnvelope(
        layerGain.gain,
        layerStart,
        clamp(layer.gain, MIN_GAIN, 1),
        layer.attack,
        layer.duration,
      );

      const stream = this.#createLayerSource(layer, layerStart, hashSeed(name));
      sources.push(stream);
      nodes.push(stream);

      // 先接滤波器（若有），再接输出；滤波器在无支持的上下文里被跳过。
      const filter = this.#createFilter(layer);
      if (filter !== null) {
        nodes.push(filter);
        stream.connect(filter);
        filter.connect(layerGain);
      } else {
        stream.connect(layerGain);
      }
      layerGain.connect(tail);

      stream.start(layerStart);
      stream.stop(layerEndLocal + CLEANUP_MARGIN_SECONDS);
      layerEnd = Math.max(layerEnd, layerEndLocal);
    }

    const voice: ActiveVoice = { sources, nodes };
    this.#voices.add(voice);
    this.#scheduleCleanup(
      voice,
      Math.max(0, layerEnd - this.#context.currentTime) + CLEANUP_MARGIN_SECONDS,
    );
    this.#playedCount += 1;
    return true;
  }

  /**
   * 立即停止并断开所有正在发声的节点。
   *
   * 正常发声结束后节点会自动回收；`dispose` 处理"上下文正在关闭"这一类情况。
   */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    for (const voice of this.#voices) {
      this.#releaseVoice(voice);
    }
    this.#voices.clear();
    this.#noiseBuffers.clear();
  }

  #createPanner(pan: number | undefined): StereoPannerNodeLike | null {
    const context = this.#context;
    if (context.createStereoPanner === undefined || pan === undefined || !Number.isFinite(pan)) {
      return null;
    }
    try {
      // 必须通过上下文调用：真实实现依赖 `this` 绑定，取出方法再调用会丢失它。
      const node = context.createStereoPanner();
      node.pan.value = clamp(pan, -1, 1);
      return node;
    } catch {
      // 声像节点只是锦上添花；创建失败时退化为居中播放。
      return null;
    }
  }

  #createFilter(layer: SoundLayer): BiquadFilterNodeLike | null {
    if (layer.kind !== 'noise' || layer.filter === null) {
      return null;
    }
    const context = this.#context;
    const filterSpec = layer.filter;
    if (context.createBiquadFilter === undefined) {
      return null;
    }
    try {
      const filter = context.createBiquadFilter();
      filter.type = filterSpec.type;
      filter.frequency.value = filterSpec.frequency;
      filter.Q.value = filterSpec.q;
      return filter;
    } catch {
      return null;
    }
  }

  #createLayerSource(
    layer: SoundLayer,
    startTime: number,
    seedBase: number,
  ): OscillatorNodeLike | AudioBufferSourceNodeLike {
    if (layer.kind === 'tone') {
      const oscillator = this.#context.createOscillator();
      oscillator.type = layer.wave;
      scheduleSweep(
        oscillator.frequency,
        startTime,
        layer.frequency,
        layer.endFrequency,
        layer.duration,
      );
      return oscillator;
    }

    const source = this.#context.createBufferSource();
    // 音效名参与种子：即使两个配方写了相同的层种子，它们的噪声也不会完全相同。
    source.buffer = this.#noiseBuffer(layer.seed ^ seedBase);
    source.loop = true;
    source.playbackRate.value = clamp(layer.playbackRate, 0.25, 4);
    return source;
  }

  /**
   * 取得（并按需生成）某个种子的噪声缓冲。
   *
   * 1. 首次访问时生成 `NOISE_BUFFER_SECONDS` 秒的白噪声并缓存；后续同种子的层直接复用，
   *    避免每次脚步都分配几万个采样点。
   * 2. 噪声节点开启 `loop`，因此层时长可以超过缓冲时长而不产生静音尾巴。
   */
  #noiseBuffer(seed: number): AudioBufferLike {
    const cached = this.#noiseBuffers.get(seed);
    if (cached !== undefined) {
      return cached;
    }
    const buffer = createNoiseBuffer(this.#context, seed, NOISE_BUFFER_SECONDS);
    this.#noiseBuffers.set(seed, buffer);
    return buffer;
  }

  #scheduleCleanup(voice: ActiveVoice, afterSeconds: number): void {
    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        if (!this.#voices.delete(voice)) {
          return;
        }
        this.#releaseVoice(voice);
      },
      Math.max(1, afterSeconds * 1000),
    );
    this.#timers.add(timer);
  }

  #releaseVoice(voice: ActiveVoice): void {
    for (const source of voice.sources) {
      try {
        source.stop();
      } catch {
        // 已经停止的源节点再次 stop 会抛 InvalidStateError；回收路径必须容错。
      }
    }
    for (const node of voice.nodes) {
      try {
        node.disconnect();
      } catch {
        // 未连接的节点断开同样是 InvalidAccessError；忽略。
      }
    }
  }
}

/** 程序化合成入口；`AudioManager` 是它唯一的调用方。 */
