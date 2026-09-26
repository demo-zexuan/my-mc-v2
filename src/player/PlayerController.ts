/**
 * 第一人称玩家控制器。
 *
 * I. 与固定时间步的关系
 *
 * 1. 控制器只接受"这一步的时间长度"，且必须由 `GameLoop.onFixedStep` 以常数
 *    `1/60` 提供。AABB 逐轴求解对 delta 敏感：变步长会让同一次移动在不同帧率下
 *    进入不同的子步顺序，低帧率时出现穿墙。
 * 2. `update` 内部仍会对传入值做一次上限夹紧（{@link MAX_STEP_SECONDS}），因为
 *    标签页恢复、断点调试等场景可能传入异常值。夹紧只是安全网，不改变"物理由
 *    固定步驱动"这一契约。
 *
 * II. 一帧内的推进顺序
 *
 * 1. 视角：读取并清零鼠标位移，交给 `CameraRig`。UI 打开或暂停时输入层返回 0，
 *    因此不需要在这里判断暂停。
 * 2. 计时器：跳跃缓冲与土狼时间。两者必须在本步的输入之后、跳跃判定之前更新。
 * 3. 水平速度：由意图得到目标速度，再以有限加速度逼近；地面加速度远大于空中，
 *    形成"地面响应快、空中控制弱"的手感。
 * 4. 竖直速度：重力 → 跳跃覆盖。顺序很关键：起跳的第一步若被重力"吃掉" 0.53
 *    格/秒，离散积分的顶点会从 1.28 格降到 1.14 格，而 1 格台阶的安全余量也
 *    随之变薄。
 * 5. 位移与碰撞：`moveBody` 返回修正后的位置与着地标志，随后按轴清零被阻挡的
 *    速度分量（否则贴墙时速度会不断累积，离开墙面瞬间"弹射"）。
 * 6. 事件：落地距离、跨区块。跨区块用于驱动区块流式加载，必须每个固定步检查，
 *    否则高速移动时会漏掉中间的区块。
 *
 * III. 手感参数（默认值）
 *
 * | 参数 | 取值 | 说明 |
 * | --- | --- | --- |
 * | 步行速度 | 4.317 格/秒 | MC 一致 |
 * | 疾跑速度 | 5.612 格/秒 | 需要同时按住前进与疾跑 |
 * | 潜行速度 | 1.30 格/秒 | |
 * | 地面加速度 | 40 格/秒² | 约 0.11 秒到达步行速度 |
 * | 空中加速度 | 8 格/秒² | 约为地面的 1/5，空中难以急转 |
 * | 重力 | 32 格/秒² | MC 一致 |
 * | 起跳速度 | 8.8 格/秒 | 实测顶点约 1.28 格（见下），可越过 1 格台阶 |
 * | 坠落终速 | 78.4 格/秒 | 限制单步位移，避免一次穿过多个方块 |
 * | 土狼时间 | 0.10 秒 | 离开边缘后仍可起跳的窗口 |
 * | 跳跃缓冲 | 0.15 秒 | 落地前按下的跳跃会在落地瞬间执行 |
 *
 * @module player/PlayerController
 */

import type { EventBus } from '@/engine/events/EventBus';
import type { InputManager, MoveIntent } from '@/input/InputManager';
import { moveBody, type MoveResult } from '@/physics/AABB';
import {
  clamp01,
  clampNumber,
  copyVec3,
  createVec3,
  horizontalLengthOf,
  lerpVec3,
  moveTowardsHorizontal,
  type Vec3,
} from '@/physics/Vec3';
import type { GameSettings } from '@/settings/types';

import { CameraRig, type RigCamera } from './CameraRig';
import { Player } from './Player';

/** 控制器要求的固定时间步（秒），与 `GameLoop` 默认值一致。 */
export const FIXED_TIME_STEP = 1 / 60;

/** 单步时间上限：超过该值的时间被视为异常并夹紧，避免一次求解跨过多个方块。 */
export const MAX_STEP_SECONDS = 1 / 30;

/** 玩家控制器需要的最小世界接口；`World` 结构化满足。 */
export interface PlayerWorld {
  isSolidAt(x: number, y: number, z: number): boolean;
  chunkOf(x: number, z: number): { readonly cx: number; readonly cz: number };
}

/**
 * 控制器消费的输入接口。
 *
 * 从 `InputManager` 上取子集而不是自定义形状，好处是接口漂移会在编译期被发现；
 * 单元测试可以实现同样三个方法而完全不接触 DOM。
 */
export type PlayerInputSource = Pick<
  InputManager,
  'moveIntent' | 'consumeLookDelta' | 'wasActionPressed'
>;

/** 视角相关设置子集。 */
export type PlayerSettings = Pick<
  GameSettings,
  'mouseSensitivity' | 'fov' | 'invertY' | 'viewBobbing'
>;

/** 可调手感参数。 */
export interface PlayerMovementTuning {
  /** 步行速度（格/秒）。 */
  readonly walkSpeed: number;
  /** 疾跑速度（格/秒）。 */
  readonly sprintSpeed: number;
  /** 潜行速度（格/秒）。 */
  readonly sneakSpeed: number;
  /** 地面水平加速度（格/秒²）。 */
  readonly groundAcceleration: number;
  /** 空中水平加速度（格/秒²）。 */
  readonly airAcceleration: number;
  /** 重力加速度（格/秒²）。 */
  readonly gravity: number;
  /** 起跳初速度（格/秒）。 */
  readonly jumpVelocity: number;
  /** 坠落终速（格/秒）。 */
  readonly maxFallSpeed: number;
  /** 土狼时间（秒）。 */
  readonly coyoteTime: number;
  /** 跳跃缓冲窗口（秒）。 */
  readonly jumpBufferTime: number;
}

/** 默认手感参数，见模块注释中的表格。 */
export const DEFAULT_MOVEMENT_TUNING: PlayerMovementTuning = {
  walkSpeed: 4.317,
  sprintSpeed: 5.612,
  sneakSpeed: 1.3,
  groundAcceleration: 40,
  airAcceleration: 8,
  gravity: 32,
  jumpVelocity: 8.8,
  maxFallSpeed: 78.4,
  coyoteTime: 0.1,
  jumpBufferTime: 0.15,
};

/** 无输入时的中性意图。 */
const NEUTRAL_MOVE_INTENT: MoveIntent = Object.freeze({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  sneak: false,
});

/** 复用同一个零位移向量：`moveBody` 只读取它，不会修改。 */
const NO_DISPLACEMENT: Vec3 = createVec3(0, 0, 0);

/** 构造参数。 */
export interface PlayerControllerOptions {
  /** 世界查询（碰撞与区块坐标）。 */
  readonly world: PlayerWorld;
  /** 输入来源；不传表示"没有输入"，用于测试或过场。 */
  readonly input?: PlayerInputSource | null;
  /** 事件总线；不传则不发布事件。 */
  readonly events?: EventBus | null;
  /** 外部构造的玩家状态；不传则内部新建。 */
  readonly player?: Player;
  /** 外部构造的相机机架；不传则内部新建。 */
  readonly cameraRig?: CameraRig;
  /** 初始视角设置。 */
  readonly settings?: PlayerSettings | null;
  /** 覆盖默认手感参数。 */
  readonly tuning?: Partial<PlayerMovementTuning>;
  /** 出生位置（脚底中心）；会覆盖 `player` 的当前位置。 */
  readonly spawn?: Vec3;
}

export class PlayerController {
  readonly #world: PlayerWorld;
  readonly #input: PlayerInputSource | null;
  readonly #events: EventBus | null;
  readonly #player: Player;
  readonly #rig: CameraRig;
  readonly #tuning: PlayerMovementTuning;

  readonly #displacement: Vec3 = createVec3();
  readonly #eye: Vec3 = createVec3();
  readonly #previousEye: Vec3 = createVec3();
  readonly #interpolatedEye: Vec3 = createVec3();

  #coyoteTimer = 0;
  #jumpBufferTimer = 0;
  #fallPeakY = 0;
  #wishX = 0;
  #wishZ = 0;
  #chunkCx: number;
  #chunkCz: number;

  public constructor(options: PlayerControllerOptions) {
    this.#world = options.world;
    this.#input = options.input ?? null;
    this.#events = options.events ?? null;
    this.#tuning = { ...DEFAULT_MOVEMENT_TUNING, ...options.tuning };
    this.#player = options.player ?? new Player();
    this.#rig = options.cameraRig ?? new CameraRig();

    if (options.spawn !== undefined) {
      this.#player.setPosition(options.spawn.x, options.spawn.y, options.spawn.z);
    }
    if (options.settings !== undefined && options.settings !== null) {
      this.setSettings(options.settings);
    }

    // I. 出生点校正。
    // 1. 与 `teleport` 使用同一条路径：解除与地形的重叠，并立刻建立着地状态。
    // 2. 不做这一步时，玩家在第一步会被当成"在空中"：水平加速度按空中值（很小）
    //    计算，紧接着按下的跳跃也会因为"不着地、土狼时间为 0"而失效——表现为
    //    "进入世界后第一下跳不起来"。
    const settled = moveBody(this.#world, this.#player.body, NO_DISPLACEMENT);
    this.#player.setPosition(settled.position.x, settled.position.y, settled.position.z);
    this.#player.onGround = settled.onGround;
    this.#coyoteTimer = settled.onGround ? this.#tuning.coyoteTime : 0;

    this.#player.eyePosition(this.#eye);
    copyVec3(this.#previousEye, this.#eye);
    this.#fallPeakY = this.#player.position.y;

    const chunk = this.#world.chunkOf(this.#player.position.x, this.#player.position.z);
    this.#chunkCx = chunk.cx;
    this.#chunkCz = chunk.cz;
  }

  // -------------------------------------------------------------------------
  // 访问器
  // -------------------------------------------------------------------------

  /** 玩家状态。 */
  public get player(): Player {
    return this.#player;
  }

  /** 相机机架（yaw / pitch / FOV / 摇晃）。 */
  public get cameraRig(): CameraRig {
    return this.#rig;
  }

  /** 当前使用的手感参数（只读快照）。 */
  public get tuning(): PlayerMovementTuning {
    return this.#tuning;
  }

  /** 玩家所在的区块坐标。 */
  public get currentChunk(): { readonly cx: number; readonly cz: number } {
    return { cx: this.#chunkCx, cz: this.#chunkCz };
  }

  /** 是否站在地面上。 */
  public get onGround(): boolean {
    return this.#player.onGround;
  }

  /** 当前水平速度（格/秒）。 */
  public get horizontalSpeed(): number {
    return horizontalLengthOf(this.#player.velocity);
  }

  // -------------------------------------------------------------------------
  // 配置
  // -------------------------------------------------------------------------

  /** 应用视角相关设置（灵敏度和 FOV 即时生效）。 */
  public setSettings(settings: PlayerSettings): void {
    this.#rig.setSensitivity(settings.mouseSensitivity);
    this.#rig.setFov(settings.fov);
    this.#rig.setInvertY(settings.invertY);
    this.#rig.setViewBobbing(settings.viewBobbing);
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /**
   * 当前眼睛位置（不含走路摇晃）。
   *
   * 交互层用它作为射线起点；摇晃是纯视觉效果，不应影响选中判定。
   *
   * @param out - 可选目标向量。
   */
  public eyePosition(out?: Vec3): Vec3 {
    return this.#player.eyePosition(out);
  }

  // -------------------------------------------------------------------------
  // 固定步推进
  // -------------------------------------------------------------------------

  /**
   * 推进一个固定步。
   *
   * @param deltaSeconds - 固定步长，必须由 `GameLoop.onFixedStep` 传入。
   */
  public update(deltaSeconds: number): void {
    const player = this.#player;
    const input = this.#input;

    // I. 视角：先消费鼠标位移，即使本步时间被夹紧为 0 也不应该丢输入。
    if (input !== null) {
      const look = input.consumeLookDelta();
      if (look.dx !== 0 || look.dy !== 0) {
        this.#rig.applyLook(look.dx, look.dy);
      }
    }

    const dt = clampNumber(Number.isFinite(deltaSeconds) ? deltaSeconds : 0, 0, MAX_STEP_SECONDS);
    if (dt <= 0) {
      return;
    }

    const intent = input?.moveIntent() ?? NEUTRAL_MOVE_INTENT;
    const jumpPressed = input?.wasActionPressed('jump') ?? false;
    const wasOnGround = player.onGround;

    // II. 计时器。
    // 1. 跳跃缓冲：把"刚按下"扩展成一个时间窗口，落地前后极短时间内的按下都算数。
    // 2. 一直按住 Space 时同样保持缓冲有效，于是落地瞬间会立即再次起跳（连跳），
    //    与 MC 的手感一致；只按一下则只会跳一次。
    // 3. 土狼时间：离开地面后仍保留一小段可起跳窗口，走出边缘的瞬间不会"跳不起来"。
    const jumpRequested = jumpPressed || intent.jump;
    this.#jumpBufferTimer = jumpRequested
      ? this.#tuning.jumpBufferTime
      : Math.max(0, this.#jumpBufferTimer - dt);
    this.#coyoteTimer = player.onGround
      ? this.#tuning.coyoteTime
      : Math.max(0, this.#coyoteTimer - dt);

    // III. 水平速度。
    const sprinting = intent.sprint && intent.forward && !intent.sneak;
    const sneaking = intent.sneak;
    const targetSpeed = sneaking
      ? this.#tuning.sneakSpeed
      : sprinting
        ? this.#tuning.sprintSpeed
        : this.#tuning.walkSpeed;
    this.#computeWish(intent.forward, intent.back, intent.left, intent.right);

    const acceleration =
      (player.onGround ? this.#tuning.groundAcceleration : this.#tuning.airAcceleration) * dt;
    moveTowardsHorizontal(
      player.velocity,
      player.velocity,
      this.#wishX * targetSpeed,
      this.#wishZ * targetSpeed,
      acceleration,
    );

    // IV. 竖直速度：重力 → 跳跃覆盖。
    if (player.onGround && player.velocity.y < 0) {
      player.velocity.y = 0;
    }
    player.velocity.y = Math.max(
      -this.#tuning.maxFallSpeed,
      player.velocity.y - this.#tuning.gravity * dt,
    );

    if (this.#jumpBufferTimer > 0 && (player.onGround || this.#coyoteTimer > 0)) {
      player.velocity.y = this.#tuning.jumpVelocity;
      this.#jumpBufferTimer = 0;
      this.#coyoteTimer = 0;
    }

    // V. 位移与碰撞求解。
    // 1. 记录上一步的眼睛位置，供渲染帧插值使用。
    copyVec3(this.#previousEye, this.#eye);

    const velocity = player.velocity;
    this.#displacement.x = velocity.x * dt;
    this.#displacement.y = velocity.y * dt;
    this.#displacement.z = velocity.z * dt;

    const result: MoveResult = moveBody(this.#world, player.body, this.#displacement);
    player.setPosition(result.position.x, result.position.y, result.position.z);
    player.onGround = result.onGround;

    // 2. 按轴清零被阻挡的速度分量：不清零时贴墙滑行的速度会持续累积，
    //    离开墙面的一瞬间出现"弹射"。
    if (result.blockedX) {
      velocity.x = 0;
    }
    if (result.blockedZ) {
      velocity.z = 0;
    }
    if (result.hitCeiling && velocity.y > 0) {
      velocity.y = 0;
    }
    if (player.onGround && velocity.y < 0) {
      velocity.y = 0;
    }

    // VI. 落地事件与坠落峰值。
    if (player.onGround) {
      if (!wasOnGround) {
        this.#events?.emit('player:landed', {
          distance: Math.max(0, this.#fallPeakY - player.position.y),
        });
      }
      this.#fallPeakY = player.position.y;
    } else {
      this.#fallPeakY = Math.max(this.#fallPeakY, player.position.y);
    }

    // VII. 跨区块事件：驱动区块流式加载。
    const chunk = this.#world.chunkOf(player.position.x, player.position.z);
    if (chunk.cx !== this.#chunkCx || chunk.cz !== this.#chunkCz) {
      this.#chunkCx = chunk.cx;
      this.#chunkCz = chunk.cz;
      this.#events?.emit('player:chunk-changed', { cx: chunk.cx, cz: chunk.cz });
    }

    // VIII. 状态标记与走路摇晃。
    player.sprinting = sprinting;
    player.sneaking = sneaking;
    this.#rig.updateView(dt, horizontalLengthOf(velocity), player.onGround);

    player.eyePosition(this.#eye);
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  /**
   * 把视角写入相机。
   *
   * @param camera - 目标相机（`THREE.PerspectiveCamera` 结构化满足）。
   * @param interpolation - `GameLoop` 提供的插值系数：物理是离散的，渲染帧用它在
   *        上一步与当前步的眼睛位置之间平滑过渡，因此高刷屏不会看到台阶式移动。
   */
  public applyCamera(camera: RigCamera, interpolation = 1): void {
    lerpVec3(this.#interpolatedEye, this.#previousEye, this.#eye, clamp01(interpolation));
    this.#rig.applyTo(camera, this.#interpolatedEye);
  }

  // -------------------------------------------------------------------------
  // 传送
  // -------------------------------------------------------------------------

  /**
   * 传送玩家并解除可能的重叠。
   *
   * @param position - 目标脚底位置。
   */
  public teleport(position: Vec3): void {
    const player = this.#player;
    player.teleport(position);

    // 与固定步一致地做一次自救：落点被地形填满时把玩家推到最近的空位，
    // 否则玩家会以重叠状态开始下一步。
    const result = moveBody(this.#world, player.body, NO_DISPLACEMENT);
    player.setPosition(result.position.x, result.position.y, result.position.z);
    player.onGround = result.onGround;

    this.#fallPeakY = player.position.y;
    this.#coyoteTimer = player.onGround ? this.#tuning.coyoteTime : 0;
    this.#jumpBufferTimer = 0;

    player.eyePosition(this.#eye);
    copyVec3(this.#previousEye, this.#eye);

    const chunk = this.#world.chunkOf(player.position.x, player.position.z);
    if (chunk.cx !== this.#chunkCx || chunk.cz !== this.#chunkCz) {
      this.#chunkCx = chunk.cx;
      this.#chunkCz = chunk.cz;
      this.#events?.emit('player:chunk-changed', { cx: chunk.cx, cz: chunk.cz });
    }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  /**
   * 计算水平期望方向（单位向量，写入 `#wishX` / `#wishZ`）。
   *
   * I. 与视角的关系
   *
   * 1. 期望方向取相机的水平前方与右方。忽略俯仰，因此抬头/低头不会让人变慢。
   * 2. 同时按下两个相反方向时 `f` 或 `r` 为 0，向量自然抵消。
   * 3. 斜向输入的长度为 `sqrt(2)`，必须归一化，否则斜着走比直着走快 41%。
   */
  #computeWish(forward: boolean, back: boolean, left: boolean, right: boolean): void {
    const forwardAmount = (forward ? 1 : 0) - (back ? 1 : 0);
    const rightAmount = (right ? 1 : 0) - (left ? 1 : 0);

    if (forwardAmount === 0 && rightAmount === 0) {
      this.#wishX = 0;
      this.#wishZ = 0;
      return;
    }

    const sinYaw = Math.sin(this.#rig.yaw);
    const cosYaw = Math.cos(this.#rig.yaw);
    // 前方 = (-sin(yaw), 0, -cos(yaw))，右方 = (cos(yaw), 0, -sin(yaw))。
    let x = -sinYaw * forwardAmount + cosYaw * rightAmount;
    let z = -cosYaw * forwardAmount - sinYaw * rightAmount;

    const length = Math.sqrt(x * x + z * z);
    if (length > 1) {
      x /= length;
      z /= length;
    }
    this.#wishX = x;
    this.#wishZ = z;
  }
}

/**
 * 连续模型下的跳跃高度参考值（格）：`v² / 2g`。
 *
 * I. 与实测值的差异
 *
 * 1. 默认参数下该值为 1.21 格。
 * 2. 求解器把跳跃速度写在重力之后的第一步，因此实际离散轨迹的顶点约为
 *    1.28 格（比连续模型高约 `jumpVelocity * dt / 2`）。测试断言的是实测区间，
 *    这个函数只用于文档与上界推导。
 *
 * @param tuning - 手感参数，默认 {@link DEFAULT_MOVEMENT_TUNING}。
 */
export function idealJumpHeight(tuning: PlayerMovementTuning = DEFAULT_MOVEMENT_TUNING): number {
  return (tuning.jumpVelocity * tuning.jumpVelocity) / (2 * tuning.gravity);
}
