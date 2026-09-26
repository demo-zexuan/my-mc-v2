/**
 * 当前瞄准方块的唯一真源。
 *
 * I. 为什么需要一个独立的 selector
 *
 * 每帧都有一条新的射线结果，而"目标变了"这件事必须**恰好**发生一次：
 * 挖掘进度要在目标变化时清零，准星要在有目标时改变形态，音效只在切换时播放。
 * 如果每个系统各自比较"上一帧的命中"，它们会因为帧内执行顺序不同而得出不同结论。
 * 把比较收敛到一处，其余系统只消费事件或读取 `current`。
 *
 * II. 为什么只比较坐标与方块 id
 *
 * `distance` 每帧都在变（玩家一直在动），把它纳入相等性判断会让目标每帧都"变化"，
 * 事件会变成每帧一次，UI 与音效随之抖动。距离只是同一目标的附加信息，
 * 因此命中相同时仅刷新存量对象，不发事件。
 *
 * @module interaction/BlockSelector
 */

import type { EventBus } from '@/engine/events/EventBus';

import type { InteractionHit } from './types';

export class BlockSelector {
  readonly #bus: EventBus;
  #hit: InteractionHit | null = null;

  public constructor(bus: EventBus) {
    this.#bus = bus;
  }

  /** 当前命中结果，没有命中时为 `null`。 */
  public get current(): InteractionHit | null {
    return this.#hit;
  }

  /** 是否瞄准着某个方块。 */
  public get hasTarget(): boolean {
    return this.#hit !== null;
  }

  /**
   * 提交本帧的射线结果。
   *
   * @param hit - 本帧命中结果，或 `null`（没有命中）。
   * @returns 目标是否发生了变化（调用方据此决定是否重播音效等）。
   */
  public update(hit: InteractionHit | null): boolean {
    // 复制一份：射线实现通常复用同一个结果对象，直接持有会让 `current` 在下一次
    // 射线后悄悄改变，破坏"事件发出时的目标"与"读取到的目标"一致这一前提。
    const next = hit === null ? null : { ...hit, normal: { ...hit.normal } };

    if (next === null) {
      if (this.#hit === null) {
        return false;
      }
      this.#hit = null;
      this.#bus.emit('mining:target-changed', null);
      return true;
    }

    if (isSameTarget(this.#hit, next)) {
      // 同一目标：刷新距离/法线等附加信息，但不发事件。
      this.#hit = next;
      return false;
    }

    this.#hit = next;
    this.#bus.emit('mining:target-changed', {
      x: next.x,
      y: next.y,
      z: next.z,
      block: next.block,
    });
    return true;
  }

  /** 清空目标（例如打开背包、失去指针锁定时）。 */
  public clear(): void {
    this.update(null);
  }
}

/** 目标身份比较：只看位置与方块 id。 */
function isSameTarget(a: InteractionHit | null, b: InteractionHit): boolean {
  if (a === null) {
    return false;
  }
  return a.x === b.x && a.y === b.y && a.z === b.z && a.block === b.block;
}
