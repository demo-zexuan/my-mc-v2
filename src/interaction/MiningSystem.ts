/**
 * 挖掘系统：按住左键按方块硬度累计进度。
 *
 * I. 为什么进度是"每帧累加秒数"而不是"记录开始时间"
 *
 * 1. 手速倍率（未来的效率附魔、工具等级）会让不同方块需要不同时间，
 *    用 `(now - startTime) / hardness` 需要把开始时间与当时的倍率一起记住，
 *    中途换工具就变成一次隐式的重新开始。
 * 2. 累加式进度天然支持"松手暂停、继续按住接着挖"的体验，
 *    也让固定时间步与可变帧率下的行为都可复现——单元测试可以直接注入 dt。
 *
 * II. 为什么每 tick 都回读世界
 *
 * 命中结果是上一帧射线算出来的，它可能已经过期：另一位玩家、爆炸或者
 * 上一 tick 的挖掘本身都可能已经把方块换掉了。回读 `getBlock` 是唯一权威的
 * 校验，成本只有一次数组索引，却能让"对着空气挖出掉落物"这类幽灵 bug 不可能发生。
 *
 * III. 谁负责真正移除方块
 *
 * 挖掘系统自己调用 `setBlock(Air)` 再发 `block:broken`，而不是只发事件等别人删。
 * 否则事件订阅者（掉落物、粒子、音效）会在"方块还在"的世界状态上跑，
 * 掉落物可能被生成在一个随后才被清空的方块里，或者两个订阅者重复删除同一次破坏。
 * 事件只描述**已经发生的事实**。
 *
 * @module interaction/MiningSystem
 */

import type { EventBus } from '@/engine/events/EventBus';
import { BlockId, hardnessOf, isBreakable } from '@/world/BlockRegistry';

import type { BlockAccessor, InteractionHit } from './types';

/** 构造参数。 */
export interface MiningSystemOptions {
  /** 世界读写接口；装配时直接传 `World` 实例。 */
  readonly world: BlockAccessor;
  /** 事件总线。 */
  readonly bus: EventBus;
  /** 手速倍率：每秒推进 `speed / hardness` 的进度，默认 1（徒手）。 */
  readonly speed?: number;
}

export class MiningSystem {
  readonly #world: BlockAccessor;
  readonly #bus: EventBus;
  readonly #speed: number;

  #hit: InteractionHit | null = null;
  /**
   * 已累积的"有效挖掘秒数"。
   *
   * I. 为什么存秒数而不是 0..1 的进度
   *
   * 1. 进度是"已挖秒数 / 硬度"的导出量，存原始秒数就没有除法累积误差：
   *    0.5 + 0.75 + 0.25 秒对 1.5 秒硬度的石头恰好到处，而三次
   *    `0.5/1.5 + 0.75/1.5 + 0.25/1.5` 在浮点下会得到 0.9999999999999999，
   *    于是"最后一下挖不掉"——这类 bug 只在长会话里偶发，极难复现。
   * 2. 日后接入"挖掘速度倍率"时，只需在累加处乘倍率，进度语义不变。
   */
  #mined = 0;
  #progress = 0;

  public constructor(options: MiningSystemOptions) {
    this.#world = options.world;
    this.#bus = options.bus;
    const speed = options.speed ?? 1;
    this.#speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
  }

  /** 当前进度，`0 .. 1`。 */
  public get progress(): number {
    return this.#progress;
  }

  /** 当前挖掘目标；没有目标时为 `null`。 */
  public get target(): InteractionHit | null {
    return this.#hit;
  }

  /** 是否正在推进进度。 */
  public get isMining(): boolean {
    return this.#progress > 0;
  }

  /** 手速倍率。 */
  public get speed(): number {
    return this.#speed;
  }

  /**
   * 更新挖掘目标。
   *
   * I. 目标一变，进度立刻归零
   *
   * 这是"看向别处立即重置"的实现点：只要位置或方块 id 变了，之前积累的进度
   * 就不再属于任何东西。不做这个重置的话，玩家可以对着石头挖 1.4 秒、
   * 转头对着泥土再挖 0.01 秒就把它挖掉。
   *
   * @param hit - 本帧命中结果，或 `null`。
   * @returns 目标是否发生了变化。
   */
  public setTarget(hit: InteractionHit | null): boolean {
    if (hit === null) {
      const changed = this.#hit !== null || this.#progress !== 0;
      this.#hit = null;
      this.#resetProgress();
      return changed;
    }
    const previous = this.#hit;
    const changed =
      previous === null ||
      previous.x !== hit.x ||
      previous.y !== hit.y ||
      previous.z !== hit.z ||
      previous.block !== hit.block;

    this.#hit = { ...hit, normal: { ...hit.normal } };
    if (changed) {
      this.#resetProgress();
    }
    return changed;
  }

  /**
   * 推进一帧。
   *
   * I. 行为细则
   *
   * 1. 没有按住左键、没有目标、目标不可破坏（基岩）或硬度为 `Infinity` 时，
   *    进度归零且**不发**进度事件——"没有进度"和"进度为 0 的一次推进"必须可区分，
   *    否则 UI 会在对着基岩时显示一条永远不动的碎裂纹理。
   * 2. 正常推进时每 tick 发一次 `mining:progress`。
   * 3. 进度到达 1 时先移除方块，再发 `block:broken`，然后清零准备下一次挖掘。
   *
   * @param deltaSeconds - 距上一帧的秒数；非正或非有限值视为 0。
   * @param mining - 左键是否处于按下状态。
   */
  public tick(deltaSeconds: number, mining: boolean): void {
    const hit = this.#hit;
    if (!mining || hit === null) {
      this.#resetProgress();
      return;
    }

    // I. 权威校验：世界里的方块必须仍然是命中时的那个。
    const block = this.#world.getBlock(hit.x, hit.y, hit.z);
    if (block !== hit.block || !isBreakable(block)) {
      this.#resetProgress();
      return;
    }

    const hardness = hardnessOf(block);
    if (!Number.isFinite(hardness)) {
      this.#resetProgress();
      return;
    }

    const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    if (hardness <= 0) {
      // 硬度 0（理论上不存在于当前方块表，但存档/模组可能引入）视为瞬间破坏。
      this.#progress = 1;
    } else {
      this.#mined += dt * this.#speed;
      this.#progress = Math.min(1, this.#mined / hardness);
    }

    this.#bus.emit('mining:progress', {
      x: hit.x,
      y: hit.y,
      z: hit.z,
      block,
      progress: this.#progress,
    });

    if (this.#progress >= 1) {
      this.#breakBlock(hit, block);
    }
  }

  /** 丢弃当前进度（松手、失焦、打开界面）。 */
  public cancel(): void {
    this.#resetProgress();
  }

  /** 清空目标并丢弃进度。 */
  public reset(): void {
    this.#hit = null;
    this.#resetProgress();
  }

  /**
   * 破坏某个方块需要的时间。
   *
   * @param block - 方块 id。
   * @returns 秒数；不可破坏或硬度无限时返回 `Infinity`。
   */
  public timeToBreak(block: BlockId): number {
    if (!isBreakable(block)) {
      return Number.POSITIVE_INFINITY;
    }
    const hardness = hardnessOf(block);
    if (!Number.isFinite(hardness) || hardness < 0) {
      return Number.POSITIVE_INFINITY;
    }
    return hardness / this.#speed;
  }

  #breakBlock(hit: InteractionHit, block: BlockId): void {
    const changed = this.#world.setBlock(hit.x, hit.y, hit.z, BlockId.Air);
    this.#resetProgress();
    if (!changed) {
      // 区块已被卸载或超出世界高度：世界状态没变，因此不能广播"已破坏"，
      // 否则掉落物会凭空出现。
      return;
    }
    this.#bus.emit('block:broken', { x: hit.x, y: hit.y, z: hit.z, block });
  }

  #resetProgress(): void {
    this.#mined = 0;
    this.#progress = 0;
  }
}
