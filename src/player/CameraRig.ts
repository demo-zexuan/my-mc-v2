/**
 * 第一人称相机机架：视角角度、FOV 与走路摇晃。
 *
 * I. 职责边界
 *
 * 1. 机架只持有**角度**（yaw / pitch）与视觉参数，不持有位置：眼睛位置来自
 *    `Player`，由 `PlayerController` 在渲染时传进来。位置与朝向分离之后，视角
 *    摇晃这种纯视觉的偏移就不会污染物理状态。
 * 2. 机架不 import Three.js：它只要求传入的对象满足 {@link RigCamera} 结构，
 *    而 `THREE.PerspectiveCamera` 天然满足。好处是视角数学可以在纯 Node 环境
 *    下单元测试，也避免把物理/玩家层绑死在渲染库的版本上。
 *
 * II. 为什么用 `YXZ` 欧拉顺序
 *
 * 1. FPS 相机的正确语义是"先绕世界 Y 轴偏航，再绕相机自身 X 轴俯仰"。`YXZ`
 *    正是这个顺序；若用默认的 `XYZ`，俯仰会变成绕世界 X 轴旋转，抬头到一定程度
 *    视角会开始侧倾（万向节问题）。
 * 2. 滚转（roll）恒为 0，避免任何形式的画面倾斜。
 *
 * III. 走路摇晃为什么独立于物理
 *
 * 1. 摇晃是"相机在眼睛位置上做正弦偏移"，幅度 5 厘米量级，绝不参与碰撞；一旦
 *    写进玩家位置，贴墙时会被挤出方块，或者落地时因为相机在方块内部而闪黑。
 * 2. 相位按**走过的距离**推进而不是按时间推进：这样不同速度下步频自然变化，
 *    停下时相位冻结，不会出现"站着原地抖"。
 *
 * @module player/CameraRig
 */

import { clamp01, clampNumber, createVec3, type Vec3 } from '@/physics/Vec3';

/** 俯仰上限（±89°）：留 1° 余量，避免视线与世界上方向共线导致叉乘退化。 */
export const MAX_PITCH = (89 * Math.PI) / 180;

/** FOV 的安全范围；设置项的合法区间是 50..110，这里放宽到投影矩阵不会退化的边界。 */
export const MIN_FOV = 10;
export const MAX_FOV = 170;

/** 摇晃参考速度：达到该水平速度时摇晃达到满幅。 */
const BOB_REFERENCE_SPEED = 4.317;
/** 每走 3 格完成一个完整摇晃周期（上下各两次）。 */
const BOB_RADIANS_PER_BLOCK = (Math.PI * 2) / 3;
/** 垂直摇晃幅度（格）。 */
const BOB_VERTICAL_AMPLITUDE = 0.05;
/** 侧向摇晃幅度（格）。 */
const BOB_LATERAL_AMPLITUDE = 0.03;
/** 幅度淡入淡出速度（每秒），保证起步/停下不会突然开始或停止摇晃。 */
const BOB_FADE_PER_SECOND = 6;

/**
 * 机架所需的相机视图。
 *
 * `THREE.PerspectiveCamera` 结构化满足它：`position.set`、`rotation.set`、
 * `rotation.order`、`fov` 与 `updateProjectionMatrix()`。
 */
export interface RigCamera {
  readonly position: { set(x: number, y: number, z: number): void };
  readonly rotation: { order: string; set(x: number, y: number, z: number): void };
  fov: number;
  updateProjectionMatrix(): void;
}

/** 构造参数。 */
export interface CameraRigOptions {
  /** 初始偏航角（弧度），默认 0（面向 -Z）。 */
  readonly yaw?: number;
  /** 初始俯仰角（弧度），默认 0；会被限制到 ±{@link MAX_PITCH}。 */
  readonly pitch?: number;
  /** 鼠标灵敏度，弧度/像素；默认 0.0022（与 `DEFAULT_SETTINGS` 一致）。 */
  readonly sensitivity?: number;
  /** 垂直视野角度；默认 75。 */
  readonly fov?: number;
  /** 是否反转 Y 轴；默认 false。 */
  readonly invertY?: boolean;
  /** 是否启用走路摇晃；默认 true。 */
  readonly viewBobbing?: boolean;
}

export class CameraRig {
  #yaw: number;
  #pitch: number;
  #sensitivity: number;
  #fov: number;
  #invertY: boolean;
  #viewBobbing: boolean;

  #bobPhase = 0;
  #bobAmount = 0;
  readonly #bobOffset: Vec3 = createVec3();

  /** 记录已经写进相机的 FOV，避免每帧都重建投影矩阵。 */
  #appliedFov: number | null = null;

  public constructor(options: CameraRigOptions = {}) {
    this.#yaw = wrapAngle(options.yaw ?? 0);
    this.#pitch = clampNumber(options.pitch ?? 0, -MAX_PITCH, MAX_PITCH);
    this.#sensitivity = options.sensitivity ?? 0.0022;
    this.#fov = clampNumber(options.fov ?? 75, MIN_FOV, MAX_FOV);
    this.#invertY = options.invertY ?? false;
    this.#viewBobbing = options.viewBobbing ?? true;
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  /** 偏航角（弧度），始终位于 `(-π, π]`。 */
  public get yaw(): number {
    return this.#yaw;
  }

  /** 俯仰角（弧度），限制在 ±{@link MAX_PITCH}；正值为抬头。 */
  public get pitch(): number {
    return this.#pitch;
  }

  /** 当前垂直视野角度。 */
  public get fov(): number {
    return this.#fov;
  }

  /** 当前走路摇晃造成的相机偏移（格）。 */
  public get bobOffset(): Vec3 {
    return this.#bobOffset;
  }

  /** 摇晃幅度 `0 .. 1`，供调试与测试观察淡入淡出。 */
  public get bobAmount(): number {
    return this.#bobAmount;
  }

  // -------------------------------------------------------------------------
  // 设置
  // -------------------------------------------------------------------------

  /** 设置鼠标灵敏度（弧度/像素）。 */
  public setSensitivity(sensitivity: number): void {
    if (Number.isFinite(sensitivity) && sensitivity >= 0) {
      this.#sensitivity = sensitivity;
    }
  }

  /** 设置垂直视野角度，超出安全范围会被夹紧。 */
  public setFov(fov: number): void {
    if (Number.isFinite(fov)) {
      this.#fov = clampNumber(fov, MIN_FOV, MAX_FOV);
    }
  }

  /** 设置 Y 轴反转。 */
  public setInvertY(invertY: boolean): void {
    this.#invertY = invertY;
  }

  /** 设置是否启用走路摇晃；关闭时立即归零偏移。 */
  public setViewBobbing(enabled: boolean): void {
    this.#viewBobbing = enabled;
    if (!enabled) {
      this.#bobAmount = 0;
      this.#bobOffset.x = 0;
      this.#bobOffset.y = 0;
      this.#bobOffset.z = 0;
    }
  }

  /** 直接设置朝向（读档、传送、调试用）。 */
  public setPose(yaw: number, pitch: number): void {
    this.#yaw = wrapAngle(yaw);
    this.#pitch = clampNumber(pitch, -MAX_PITCH, MAX_PITCH);
  }

  // -------------------------------------------------------------------------
  // 视角
  // -------------------------------------------------------------------------

  /**
   * 应用鼠标位移。
   *
   * I. 符号约定
   *
   * 1. 鼠标右移（`dx > 0`）应当向右转，而在 `YXZ` 约定下向右转等价于 yaw 减小。
   * 2. 屏幕坐标 Y 向下为正，所以"鼠标上移"是 `dy < 0`；默认（不反转）应当抬头，
   *    即 pitch 增大，因此取 `-dy`。开启 Y 轴反转时符号取反。
   *
   * @param dxPixels - 水平位移（像素）。
   * @param dyPixels - 垂直位移（像素）。
   */
  public applyLook(dxPixels: number, dyPixels: number): void {
    if (!Number.isFinite(dxPixels) || !Number.isFinite(dyPixels)) {
      return;
    }
    this.#yaw = wrapAngle(this.#yaw - dxPixels * this.#sensitivity);

    const pitchDelta = this.#invertY ? dyPixels : -dyPixels;
    this.#pitch = clampNumber(this.#pitch + pitchDelta * this.#sensitivity, -MAX_PITCH, MAX_PITCH);
  }

  /** 单位视线方向（含俯仰），写入 `out`。 */
  public lookDirection(out: Vec3): Vec3 {
    const cosPitch = Math.cos(this.#pitch);
    out.x = -Math.sin(this.#yaw) * cosPitch;
    out.y = Math.sin(this.#pitch);
    out.z = -Math.cos(this.#yaw) * cosPitch;
    return out;
  }

  /** 水平前方（忽略俯仰），单位向量，写入 `out`。 */
  public horizontalForward(out: Vec3): Vec3 {
    out.x = -Math.sin(this.#yaw);
    out.y = 0;
    out.z = -Math.cos(this.#yaw);
    return out;
  }

  /** 水平右方，单位向量，写入 `out`。 */
  public horizontalRight(out: Vec3): Vec3 {
    out.x = Math.cos(this.#yaw);
    out.y = 0;
    out.z = -Math.sin(this.#yaw);
    return out;
  }

  // -------------------------------------------------------------------------
  // 走路摇晃
  // -------------------------------------------------------------------------

  /**
   * 推进摇晃相位。
   *
   * @param deltaSeconds - 固定步长。
   * @param horizontalSpeed - 当前水平速度（格/秒）。
   * @param onGround - 是否在地面上；空中不摇晃，落地瞬间更干净。
   */
  public updateView(deltaSeconds: number, horizontalSpeed: number, onGround: boolean): void {
    if (!this.#viewBobbing) {
      return;
    }

    // I. 幅度：由速度决定，并按有限速率淡入淡出，避免起步/停下时突变。
    const target = onGround ? clamp01(horizontalSpeed / BOB_REFERENCE_SPEED) : 0;
    const maxChange = BOB_FADE_PER_SECOND * Math.max(0, deltaSeconds);
    const difference = target - this.#bobAmount;
    if (Math.abs(difference) <= maxChange) {
      this.#bobAmount = target;
    } else {
      this.#bobAmount += Math.sign(difference) * maxChange;
    }
    this.#bobAmount = clamp01(this.#bobAmount);

    // II. 相位按走过的距离推进：速度越快步频越高，停下时相位冻结。
    if (horizontalSpeed > 1e-3) {
      this.#bobPhase += horizontalSpeed * Math.max(0, deltaSeconds) * BOB_RADIANS_PER_BLOCK;
      if (this.#bobPhase > Math.PI * 2) {
        this.#bobPhase -= Math.PI * 2;
      }
    }

    // III. 偏移：垂直分量每个步态周期两次，侧向分量沿相机右方。
    const vertical = Math.sin(this.#bobPhase * 2) * BOB_VERTICAL_AMPLITUDE * this.#bobAmount;
    const lateral = Math.cos(this.#bobPhase) * BOB_LATERAL_AMPLITUDE * this.#bobAmount;
    const rightX = Math.cos(this.#yaw);
    const rightZ = -Math.sin(this.#yaw);

    this.#bobOffset.x = rightX * lateral;
    this.#bobOffset.y = vertical;
    this.#bobOffset.z = rightZ * lateral;
  }

  // -------------------------------------------------------------------------
  // 应用到相机
  // -------------------------------------------------------------------------

  /**
   * 把朝向、FOV 与摇晃写入相机。
   *
   * @param camera - 目标相机（`THREE.PerspectiveCamera` 结构化满足）。
   * @param eyePosition - 眼睛位置（已包含渲染插值），摇晃会叠加在其上。
   */
  public applyTo(camera: RigCamera, eyePosition: Vec3): void {
    camera.rotation.order = 'YXZ';
    camera.rotation.set(this.#pitch, this.#yaw, 0);

    camera.position.set(
      eyePosition.x + this.#bobOffset.x,
      eyePosition.y + this.#bobOffset.y,
      eyePosition.z + this.#bobOffset.z,
    );

    // 只有 FOV 真的变化时才重建投影矩阵：`updateProjectionMatrix` 涉及三角函数
    // 与矩阵求逆，每帧无谓调用是纯浪费。
    if (camera.fov !== this.#fov) {
      camera.fov = this.#fov;
      camera.updateProjectionMatrix();
      this.#appliedFov = this.#fov;
    } else {
      this.#appliedFov = camera.fov;
    }
  }

  /** 上一次写进相机的 FOV；为 `null` 表示还没写过。 */
  public get appliedFov(): number | null {
    return this.#appliedFov;
  }
}

/**
 * 把角度包装到 `(-π, π]`。
 *
 * 不包装的话，长时间转圈会让 yaw 增长到 10^6 量级，浮点精度下降会让转向变得
 * 一顿一顿；存档里也会写入难读的数字。
 *
 * @param angle - 任意弧度值。
 */
function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) {
    return 0;
  }
  const twoPi = Math.PI * 2;
  let wrapped = angle % twoPi;
  if (wrapped <= -Math.PI) {
    wrapped += twoPi;
  } else if (wrapped > Math.PI) {
    wrapped -= twoPi;
  }
  return wrapped;
}
