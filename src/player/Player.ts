/**
 * 玩家状态容器。
 *
 * I. 为什么把状态与行为拆开
 *
 * 1. `Player` 只回答"玩家现在在哪、速度多少、是否站在地上"，不关心输入、不关心
 *    世界，也不推进物理。这样它可以在测试里被直接构造，也方便存档系统做
 *    快照/恢复。
 * 2. 推进逻辑集中在 `PlayerController`，读代码时"谁改了位置"只有一个答案。
 *
 * II. 尺寸与坐标约定
 *
 * 1. AABB 为 0.6 x 1.8 x 0.6，`position` 是**脚底中心**：站在方块顶面时
 *    `position.y` 恰好等于该方块顶面的 Y 坐标，判定与调试都直观。
 * 2. 眼睛高度 1.62 是 MC 的经典值：1.8 高的身体里眼睛略低于头顶，从 1 格高的
 *    缝隙里看得过去、又不会穿过 2 格高的墙看到外面。
 *
 * III. 可变引用
 *
 * `position` / `velocity` 返回的是**活动引用**，物理与控制器会就地修改它们。
 * 返回副本会让每个固定步产生额外分配，而位置每秒被读写上百次。调用方只读使用，
 * 需要修改时走 `setPosition` / `setVelocity`。
 *
 * @module player/Player
 */

import { bodyBounds, type AabbBounds, type CollisionBody } from '@/physics/AABB';
import { copyVec3, createVec3, type Vec3 } from '@/physics/Vec3';

/** 玩家碰撞箱宽度（格）。 */
export const PLAYER_WIDTH = 0.6;
/** 玩家碰撞箱高度（格）。 */
export const PLAYER_HEIGHT = 1.8;
/** 水平半宽，物理求解使用。 */
export const PLAYER_HALF_WIDTH = PLAYER_WIDTH / 2;
/** 眼睛相对脚底的高度（格）。 */
export const PLAYER_EYE_HEIGHT = 1.62;

/** 可序列化的玩家状态；存档与联机同步共用这个形状。 */
export interface PlayerSnapshot {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly velocity: { readonly x: number; readonly y: number; readonly z: number };
  readonly onGround: boolean;
}

/** 构造参数。 */
export interface PlayerOptions {
  /** 初始脚底位置，默认 `(0, 0, 0)`。 */
  readonly position?: Vec3;
}

export class Player {
  readonly #position: Vec3;
  readonly #velocity: Vec3;
  readonly #body: CollisionBody;

  #onGround = false;
  #sprinting = false;
  #sneaking = false;

  public constructor(options: PlayerOptions = {}) {
    this.#position = createVec3();
    if (options.position !== undefined) {
      copyVec3(this.#position, options.position);
    }
    this.#velocity = createVec3();

    // 碰撞体与位置共享同一个向量对象：物理求解只改 `position` 的内容，不需要在
    // 每步重新构造碰撞体。
    this.#body = {
      position: this.#position,
      halfWidth: PLAYER_HALF_WIDTH,
      height: PLAYER_HEIGHT,
    };
  }

  /** 脚底中心位置（活动引用，只读使用）。 */
  public get position(): Vec3 {
    return this.#position;
  }

  /** 速度（活动引用，只读使用）。 */
  public get velocity(): Vec3 {
    return this.#velocity;
  }

  /** 是否站在可支撑的方块上。 */
  public get onGround(): boolean {
    return this.#onGround;
  }

  public set onGround(value: boolean) {
    this.#onGround = value;
  }

  /** 是否正在疾跑；供 HUD 与视角 FOV 使用。 */
  public get sprinting(): boolean {
    return this.#sprinting;
  }

  public set sprinting(value: boolean) {
    this.#sprinting = value;
  }

  /** 是否正在潜行。 */
  public get sneaking(): boolean {
    return this.#sneaking;
  }

  public set sneaking(value: boolean) {
    this.#sneaking = value;
  }

  /** 交给 `physics/AABB` 的碰撞体视图。 */
  public get body(): CollisionBody {
    return this.#body;
  }

  /** 眼睛所在的世界 Y。 */
  public get eyeY(): number {
    return this.#position.y + PLAYER_EYE_HEIGHT;
  }

  /**
   * 眼睛位置。
   *
   * @param out - 可选的目标向量；不传时新建一个。
   */
  public eyePosition(out?: Vec3): Vec3 {
    const target = out ?? createVec3();
    target.x = this.#position.x;
    target.y = this.eyeY;
    target.z = this.#position.z;
    return target;
  }

  /** 当前 AABB（每帧/每步调用一次，允许分配）。 */
  public bounds(): AabbBounds {
    return bodyBounds(this.#body);
  }

  /** 就地设置脚底位置。 */
  public setPosition(x: number, y: number, z: number): void {
    this.#position.x = x;
    this.#position.y = y;
    this.#position.z = z;
  }

  /**
   * 传送到目标位置并清空速度。
   *
   * 传送后应当由调用方（或控制器）重新做一次碰撞自救，避免落点卡在方块里。
   */
  public teleport(position: Vec3): void {
    copyVec3(this.#position, position);
    this.#velocity.x = 0;
    this.#velocity.y = 0;
    this.#velocity.z = 0;
    this.#onGround = false;
  }

  /** 就地设置速度。 */
  public setVelocity(x: number, y: number, z: number): void {
    this.#velocity.x = x;
    this.#velocity.y = y;
    this.#velocity.z = z;
  }

  /** 复制一份当前状态，供存档或调试使用。 */
  public snapshot(): PlayerSnapshot {
    return {
      position: { x: this.#position.x, y: this.#position.y, z: this.#position.z },
      velocity: { x: this.#velocity.x, y: this.#velocity.y, z: this.#velocity.z },
      onGround: this.#onGround,
    };
  }

  /** 恢复快照。缺失的字段保持当前值，便于版本迁移。 */
  public restore(snapshot: PlayerSnapshot): void {
    this.#position.x = snapshot.position.x;
    this.#position.y = snapshot.position.y;
    this.#position.z = snapshot.position.z;
    this.#velocity.x = snapshot.velocity.x;
    this.#velocity.y = snapshot.velocity.y;
    this.#velocity.z = snapshot.velocity.z;
    this.#onGround = snapshot.onGround;
  }
}
