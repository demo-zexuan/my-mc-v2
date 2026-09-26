/**
 * "原生" Web Audio 替身：`connect()` 严格校验参数。
 *
 * I. 为什么需要它（而不是复用 `FakeAudioContext`）
 *
 * 1. `FakeAudioContext` 是**宽容**的：它的 `connect()` 接受任何对象，因此无法发现
 *    "把适配层包装对象当成原生 AudioNode 传给浏览器"这类缺陷——真实 Chromium 会抛
 *    `TypeError: Failed to execute 'connect' on 'AudioNode': Overload resolution failed.`
 * 2. 本替身模拟原生语义：节点只能连接同一个上下文里的节点或 `AudioParam`，否则抛
 *    `TypeError`。用它可以验证适配器在连线前确实把包装对象还原成了原生节点。
 *
 * II. 用法
 *
 * `vi.stubGlobal('AudioContext', FakeNativeAudioContext)` 之后走
 * `createBrowserAudioContext()`，即可在 node 环境下完整跑通"适配器 + AudioManager"的
 * 真实连线路径。
 *
 * @module tests/unit/audio/fakeNativeAudioContext
 */

/** 原生 `AudioParam` 替身；属于某个上下文，不能跨上下文连线。 */
export class FakeNativeAudioParam {
  public value: number;
  public readonly context: FakeNativeAudioContext;
  public readonly automation: {
    readonly kind: string;
    readonly value: number;
    readonly time: number;
  }[] = [];

  public constructor(context: FakeNativeAudioContext, initial = 1) {
    this.context = context;
    this.value = initial;
  }

  public setValueAtTime(value: number, startTime: number): FakeNativeAudioParam {
    this.automation.push({ kind: 'set', value, time: startTime });
    return this;
  }

  public linearRampToValueAtTime(value: number, endTime: number): FakeNativeAudioParam {
    this.automation.push({ kind: 'linear', value, time: endTime });
    return this;
  }

  public exponentialRampToValueAtTime(value: number, endTime: number): FakeNativeAudioParam {
    this.automation.push({ kind: 'exponential', value, time: endTime });
    return this;
  }

  public cancelScheduledValues(startTime: number): FakeNativeAudioParam {
    this.automation.push({ kind: 'cancel', value: 0, time: startTime });
    return this;
  }
}

/**
 * 原生 `AudioNode` 替身。
 *
 * `connect` 复刻浏览器的两个关键约束：参数必须是节点或 `AudioParam`，且必须属于同一个
 * 上下文。
 */
export class FakeNativeAudioNode {
  public readonly context: FakeNativeAudioContext;
  /** 成功建立的连线目标。 */
  public readonly connections: unknown[] = [];
  public disconnectCount = 0;

  public constructor(context: FakeNativeAudioContext) {
    this.context = context;
  }

  public connect(destination: unknown): unknown {
    const isParam = destination instanceof FakeNativeAudioParam;
    if (!(destination instanceof FakeNativeAudioNode) && !isParam) {
      // 与 Chromium 的报错文本保持一致，便于在日志里一眼认出这个缺陷。
      throw new TypeError(
        "Failed to execute 'connect' on 'AudioNode': Overload resolution failed.",
      );
    }
    if (destination.context !== this.context) {
      throw new TypeError(
        "Failed to execute 'connect' on 'AudioNode': 节点属于不同的 AudioContext.",
      );
    }
    this.connections.push(destination);
    this.context.connectCalls.push({ source: this, destination });
    return isParam ? undefined : destination;
  }

  public disconnect(): void {
    this.disconnectCount += 1;
  }
}

/** 增益节点。 */
export class FakeNativeGainNode extends FakeNativeAudioNode {
  public readonly gain: FakeNativeAudioParam;

  public constructor(context: FakeNativeAudioContext) {
    super(context);
    this.gain = new FakeNativeAudioParam(context);
  }
}

/** 振荡器节点；重复 `start`/`stop` 与浏览器一样抛错。 */
export class FakeNativeOscillatorNode extends FakeNativeAudioNode {
  public type = 'sine';
  public readonly frequency: FakeNativeAudioParam;
  public readonly detune: FakeNativeAudioParam;
  public startCount = 0;
  public stopCount = 0;

  public constructor(context: FakeNativeAudioContext) {
    super(context);
    this.frequency = new FakeNativeAudioParam(context, 440);
    this.detune = new FakeNativeAudioParam(context, 0);
  }

  public start(): void {
    this.startCount += 1;
  }

  public stop(): void {
    this.stopCount += 1;
  }
}

/** 采样缓冲。 */
export class FakeNativeAudioBuffer {
  readonly #data: Float32Array;

  public constructor(
    public readonly length: number,
    public readonly sampleRate: number,
    public readonly numberOfChannels: number,
  ) {
    this.#data = new Float32Array(length);
  }

  public getChannelData(): Float32Array {
    return this.#data;
  }
}

/** 缓冲源节点；未设置 buffer 时 `start` 与浏览器一样抛错。 */
export class FakeNativeBufferSourceNode extends FakeNativeAudioNode {
  public buffer: FakeNativeAudioBuffer | null = null;
  public loop = false;
  public readonly playbackRate: FakeNativeAudioParam;
  public startCount = 0;
  public stopCount = 0;

  public constructor(context: FakeNativeAudioContext) {
    super(context);
    this.playbackRate = new FakeNativeAudioParam(context);
  }

  public start(): void {
    if (this.buffer === null) {
      throw new Error("Failed to execute 'start' on 'AudioBufferSourceNode': buffer 未设置");
    }
    this.startCount += 1;
  }

  public stop(): void {
    this.stopCount += 1;
  }
}

/** 双二阶滤波器。 */
export class FakeNativeFilterNode extends FakeNativeAudioNode {
  public type = 'lowpass';
  public readonly frequency: FakeNativeAudioParam;
  public readonly Q: FakeNativeAudioParam;

  public constructor(context: FakeNativeAudioContext) {
    super(context);
    this.frequency = new FakeNativeAudioParam(context, 350);
    this.Q = new FakeNativeAudioParam(context);
  }
}

/** 立体声声像节点。 */
export class FakeNativePannerNode extends FakeNativeAudioNode {
  public readonly pan: FakeNativeAudioParam;

  public constructor(context: FakeNativeAudioContext) {
    super(context);
    this.pan = new FakeNativeAudioParam(context);
  }
}

/** 连接终点。 */
export class FakeNativeDestinationNode extends FakeNativeAudioNode {}

/** 原生 `AudioContext` 替身。 */
export class FakeNativeAudioContext {
  public state: 'suspended' | 'running' | 'closed' = 'suspended';
  public currentTime = 0;
  public readonly sampleRate = 48_000;
  public readonly destination = new FakeNativeDestinationNode(this);

  /** 全部成功建立的连线，供测试断言。 */
  public readonly connectCalls: { readonly source: unknown; readonly destination: unknown }[] = [];
  public readonly gains: FakeNativeGainNode[] = [];
  public readonly oscillators: FakeNativeOscillatorNode[] = [];
  public readonly bufferSources: FakeNativeBufferSourceNode[] = [];
  public readonly filters: FakeNativeFilterNode[] = [];
  public readonly panners: FakeNativePannerNode[] = [];

  public resumeCount = 0;
  public suspendCount = 0;
  public closeCount = 0;

  public createGain(): FakeNativeGainNode {
    const node = new FakeNativeGainNode(this);
    this.gains.push(node);
    return node;
  }

  public createOscillator(): FakeNativeOscillatorNode {
    const node = new FakeNativeOscillatorNode(this);
    this.oscillators.push(node);
    return node;
  }

  public createBufferSource(): FakeNativeBufferSourceNode {
    const node = new FakeNativeBufferSourceNode(this);
    this.bufferSources.push(node);
    return node;
  }

  public createBiquadFilter(): FakeNativeFilterNode {
    const node = new FakeNativeFilterNode(this);
    this.filters.push(node);
    return node;
  }

  public createStereoPanner(): FakeNativePannerNode {
    const node = new FakeNativePannerNode(this);
    this.panners.push(node);
    return node;
  }

  public createBuffer(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ): FakeNativeAudioBuffer {
    return new FakeNativeAudioBuffer(length, sampleRate, numberOfChannels);
  }

  public resume(): Promise<void> {
    this.resumeCount += 1;
    this.state = 'running';
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
}
