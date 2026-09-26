/**
 * 地上的掉落物。
 *
 * I. 为什么掉落物不用完整的 AABB 物理
 *
 * 掉落物只有 0.25 个方块大小、没有玩家输入、也不需要"贴着墙滑行"的手感。
 * 用玩家那套逐轴扫掠碰撞会引入一个每帧几十次的循环，而收益是零：
 * 掉落物只需要「下落 → 落到地面 → 被捡走」。因此这里用一条极简规则：
 * 脚所在体素是实体就把它抬到该体素上方。它同时覆盖了两种情况——
 * 正常落地，以及被卡在方块里时向上自救。
 *
 * II. 为什么拾取有延迟
 *
 * 破坏方块时掉落物就生成在玩家脚下不到 1 格的位置。没有延迟的话，
 * 玩家永远看不到掉落物被"吸"进背包的那一下，也会让"丢出去再捡回来"变成不可能。
 * 0.5 秒是"能看见它弹一下"的最短时间。
 *
 * III. 为什么位置与速度是可变的（与 ItemStack 的只读风格相反）
 *
 * `ItemStack` 只读是为了杜绝 UI 持有被清空的引用；掉落物的坐标则每帧都要积分，
 * 每次都新建对象等于每帧给 GC 制造垃圾。这里的可变对象是**私有状态**，
 * 以 `readonly position: MutableVec3` 的形式暴露（引用不可换，字段可变）。
 *
 * @module entities/ItemEntity
 */

import type { MutableVec3, Vec3Like } from '@/interaction/types';
import { MAX_STACK_SIZE } from '@/inventory/types';
import type { BlockId } from '@/world/BlockRegistry';

/** 只读的实体世界查询；`World` 在结构上满足它。 */
export interface SolidQuery {
  isSolidAt(x: number, y: number, z: number): boolean;
}

/** 掉落物半边长（方块）。0.25 见方的立方体。 */
export const ITEM_HALF_SIZE = 0.125;

/** 重力加速度（方块/秒²）。比玩家略大，掉落物落地更干脆。 */
export const ITEM_GRAVITY = 26;

/** 水平速度每秒保留比例，用于让掉落物滑行一段后停下。 */
export const ITEM_HORIZONTAL_DRAG = 0.55;

/** 生成后多久才允许被拾取（秒）。 */
export const PICKUP_DELAY = 0.5;

/** 掉落物最长存活时间（秒）；到期自动消失，避免世界里堆积。 */
export const ITEM_LIFETIME = 300;

/** 掉落物被判为"掉出世界"的高度。 */
const VOID_Y = -64;

/** 自救时最多向上抬升的方块数，防止一次异常 dt 引发长循环。 */
const MAX_PUSH_UP = 8;

/** 落地判定的向下偏移：让"恰好站在顶面"被识别为落地而不是悬空。 */
const GROUND_EPSILON = 1e-3;

/** 构造掉落物所需的数据。 */
export interface ItemEntityInit {
  /** 唯一 id（由 DropSystem 分配，用于渲染扰动相位）。 */
  readonly id: number;
  /** 物品 id。 */
  readonly item: BlockId;
  /** 数量，`1 .. MAX_STACK_SIZE`。 */
  readonly count: number;
  /** 初始位置（实体中心）。 */
  readonly position: Vec3Like;
  /** 初始速度，默认 0。 */
  readonly velocity?: Vec3Like;
}

export class ItemEntity {
  public readonly id: number;
  public readonly item: BlockId;

  /** 剩余数量；被部分拾取时减少。 */
  public count: number;
  /** 实体中心位置。 */
  public readonly position: MutableVec3;
  /** 速度（方块/秒）。 */
  public readonly velocity: MutableVec3;

  /** 已存活秒数。 */
  public age = 0;
  /** 是否站在实体方块上。 */
  public onGround = false;
  /** 是否仍然存在；`false` 后由 DropSystem 移除。 */
  public alive = true;

  public constructor(init: ItemEntityInit) {
    this.id = init.id;
    this.item = init.item;
    this.count = clampCount(init.count);
    this.position = { x: init.position.x, y: init.position.y, z: init.position.z };
    this.velocity = {
      x: finiteOr(init.velocity?.x, 0),
      y: finiteOr(init.velocity?.y, 0),
      z: finiteOr(init.velocity?.z, 0),
    };
  }

  /** 是否已经过了拾取延迟。 */
  public canBePickedUp(): boolean {
    return this.alive && this.age >= PICKUP_DELAY;
  }

  /** 到某点的平方距离；比较半径时避免开方。 */
  public distanceSquaredTo(point: Vec3Like): number {
    const dx = point.x - this.position.x;
    const dy = point.y - this.position.y;
    const dz = point.z - this.position.z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** 渲染用的自转角度（弧度）。 */
  public spinAngle(): number {
    return this.age * 1.8;
  }

  /** 渲染用的上下浮动偏移；按 id 错开相位，避免同批掉落物整齐划一。 */
  public bobOffset(): number {
    return Math.sin(this.age * 2.4 + this.id * 0.7) * 0.06;
  }

  /** 能否与另一个掉落物合并（同类且不超过堆叠上限）。 */
  public canMergeWith(other: ItemEntity): boolean {
    return (
      this !== other &&
      this.alive &&
      other.alive &&
      this.item === other.item &&
      this.count + other.count <= MAX_STACK_SIZE
    );
  }

  /** 吸收另一个掉落物；被吸收者立即失效。 */
  public absorb(other: ItemEntity): void {
    if (!this.canMergeWith(other)) {
      return;
    }
    this.count += other.count;
    other.count = 0;
    other.alive = false;
  }

  /**
   * 推进一帧物理。
   *
   * @param deltaSeconds - 距上一帧的秒数；非正或非有限值视为 0。
   * @param world - 只读的世界实体查询。
   */
  public update(deltaSeconds: number, world: SolidQuery): void {
    if (!this.alive) {
      return;
    }
    const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;

    this.age += dt;
    if (this.age >= ITEM_LIFETIME) {
      this.alive = false;
      return;
    }

    // I. 竖直方向：重力 + 积分 + 落地/自救。
    this.velocity.y -= ITEM_GRAVITY * dt;
    // 限制下落速度，避免大 dt 时一帧穿过多个方块。
    if (this.velocity.y < -30) {
      this.velocity.y = -30;
    }
    this.position.y += this.velocity.y * dt;
    this.#resolveVertical(world);

    // II. 水平方向：阻尼 + 逐轴阻挡。
    const damping = Math.pow(ITEM_HORIZONTAL_DRAG, dt);
    this.velocity.x *= damping;
    this.velocity.z *= damping;
    this.#moveHorizontal(world, dt);

    // III. 掉出世界。
    if (this.position.y < VOID_Y) {
      this.alive = false;
    }
  }

  #resolveVertical(world: SolidQuery): void {
    const bx = Math.floor(this.position.x);
    const bz = Math.floor(this.position.z);
    // 向下偏一点再取整：恰好贴在方块顶面时应当判定为"落到它上面"。
    let voxelY = Math.floor(this.position.y - ITEM_HALF_SIZE - GROUND_EPSILON);

    let pushed = 0;
    while (pushed < MAX_PUSH_UP && world.isSolidAt(bx, voxelY, bz)) {
      voxelY += 1;
      pushed += 1;
    }

    if (pushed > 0) {
      // 让底部贴在第一个非实体体素的底面上。
      this.position.y = voxelY + ITEM_HALF_SIZE;
      this.velocity.y = 0;
      this.onGround = true;
      return;
    }
    this.onGround = false;
  }

  #moveHorizontal(world: SolidQuery, dt: number): void {
    const bodyY = Math.floor(this.position.y);

    const nextX = this.position.x + this.velocity.x * dt;
    if (world.isSolidAt(Math.floor(nextX), bodyY, Math.floor(this.position.z))) {
      this.velocity.x = 0;
    } else {
      this.position.x = nextX;
    }

    const nextZ = this.position.z + this.velocity.z * dt;
    if (world.isSolidAt(Math.floor(this.position.x), bodyY, Math.floor(nextZ))) {
      this.velocity.z = 0;
    } else {
      this.position.z = nextZ;
    }
  }
}

/**
 * 把任意输入收敛为合法的堆叠数量。
 *
 * `Math.min` / `Math.max` 遇到 NaN 会原样返回 NaN，NaN 一旦混进 `count`
 * 就会让"背包是否装得下"的判断全部失真（NaN 与任何数比较都是 false）。
 */
function clampCount(value: number): number {
  const count = Math.floor(value);
  if (!Number.isFinite(count)) {
    return 1;
  }
  return Math.min(MAX_STACK_SIZE, Math.max(1, count));
}

/** 非有限速度一律视为 0，避免 NaN 通过积分扩散到坐标。 */
function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}
