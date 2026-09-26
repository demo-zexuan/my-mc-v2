/**
 * 三维向量与运动学小工具。
 *
 * I. 为什么不直接使用 `THREE.Vector3`
 *
 * 1. 物理层每个固定步（60 次/秒）都要处理位置、速度、位移三个向量，而需要的
 *    运算只有加法、缩放、取长度和"以有限加速度逼近目标值"四种。`Vector3`
 *    的方法大多返回新对象或经过 getter/setter，对这些热路径是纯开销。
 * 2. 不依赖 Three.js 意味着 `src/physics/**` 与 `src/player/**` 的单元测试可以
 *    在纯 Node 环境下运行，既不需要 GL 上下文也不需要 jsdom。物理正确性不应该
 *    因为"跑不起来渲染器"而无法验证。
 *
 * II. 可变约定
 *
 * 向量字段刻意是**可变**的：调用方通过 `out` 参数复用同一个对象，热路径不分配
 * 内存。只读语义由持有方保证（例如 `CollisionBody.position` 是 readonly 引用，
 * 但引用指向的向量本身可以被物理求解器就地推进）。
 *
 * III. 命名约定
 *
 * 所有函数都是纯函数（除了写入 `out`），且**从不假设**向量之间不共享引用；
 * 需要就地修改时调用方必须显式传入同一个对象（`normalizeVec3(v, v)` 是合法的）。
 *
 * @module physics/Vec3
 */

/** 世界坐标系中的三维向量。 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 创建一个向量。
 *
 * @param x - X 分量，默认 0。
 * @param y - Y 分量，默认 0。
 * @param z - Z 分量，默认 0。
 */
export function createVec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

/**
 * 复制向量分量。
 *
 * @param out - 写入目标，可以与 `source` 是同一个对象。
 * @param source - 读取来源。
 */
export function copyVec3(out: Vec3, source: Vec3): Vec3 {
  out.x = source.x;
  out.y = source.y;
  out.z = source.z;
  return out;
}

/**
 * 覆盖向量分量。
 *
 * @param out - 写入目标。
 * @param x - X 分量。
 * @param y - Y 分量。
 * @param z - Z 分量。
 */
export function setVec3(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * 线性插值：`out = base + delta * scale`。
 *
 * 用于把"本帧位移"叠加到位置，以及渲染插值。
 *
 * @param out - 写入目标。
 * @param base - 起点。
 * @param delta - 增量。
 * @param scale - 增量缩放系数。
 */
export function addScaledVec3(out: Vec3, base: Vec3, delta: Vec3, scale: number): Vec3 {
  out.x = base.x + delta.x * scale;
  out.y = base.y + delta.y * scale;
  out.z = base.z + delta.z * scale;
  return out;
}

/**
 * 逐分量线性插值，用于渲染帧在两个固定步之间平滑过渡。
 *
 * @param out - 写入目标。
 * @param from - `alpha = 0` 时的取值。
 * @param to - `alpha = 1` 时的取值。
 * @param alpha - 插值系数，通常取 `GameLoop` 提供的 `interpolation`。
 */
export function lerpVec3(out: Vec3, from: Vec3, to: Vec3, alpha: number): Vec3 {
  out.x = from.x + (to.x - from.x) * alpha;
  out.y = from.y + (to.y - from.y) * alpha;
  out.z = from.z + (to.z - from.z) * alpha;
  return out;
}

/** 向量长度的平方，用于只需比较大小的场合（避免开方）。 */
export function lengthSquaredOf(v: Vec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

/** 向量长度。 */
export function lengthOf(v: Vec3): number {
  return Math.sqrt(lengthSquaredOf(v));
}

/** 水平速度：忽略 Y 分量。相机摇晃与"是否在走路"都关心这个值。 */
export function horizontalLengthOf(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.z * v.z);
}

/**
 * 归一化。
 *
 * I. 零向量约定
 *
 * 1. 长度不足一个极小值时直接写入 `(0, 0, 0)` 并返回，而不是产生 `NaN`。
 *    归一化零向量在数学上无定义，一旦把 `NaN` 写进速度，物理求解会立刻发散且
 *    很难定位来源，因此这里选择静默退化。
 *
 * @param out - 写入目标，可以与 `v` 是同一个对象。
 * @param v - 输入向量。
 */
export function normalizeVec3(out: Vec3, v: Vec3): Vec3 {
  const length = lengthOf(v);
  if (length < 1e-8) {
    return setVec3(out, 0, 0, 0);
  }
  out.x = v.x / length;
  out.y = v.y / length;
  out.z = v.z / length;
  return out;
}

/**
 * 以有限步长把向量逼近目标值。
 *
 * I. 为什么沿"差向量"而不是逐分量限制
 *
 * 1. 逐分量限制会让对角方向的加速度变成 `sqrt(2)` 倍，斜着走比直着走快。
 * 2. 沿差向量限制时，位移总量被 `maxDelta` 封顶，方向与目标一致，因此加速与
 *    减速都是各向同性的。
 *
 * @param out - 写入目标，可以与 `current` 是同一个对象。
 * @param current - 当前值。
 * @param target - 目标值。
 * @param maxDelta - 本次允许的最大变化量（`<= 0` 表示不动）。
 */
export function moveTowardsVec3(out: Vec3, current: Vec3, target: Vec3, maxDelta: number): Vec3 {
  const dx = target.x - current.x;
  const dy = target.y - current.y;
  const dz = target.z - current.z;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  if (distance <= maxDelta || distance < 1e-8) {
    return copyVec3(out, target);
  }
  if (maxDelta <= 0) {
    return copyVec3(out, current);
  }

  const scale = maxDelta / distance;
  out.x = current.x + dx * scale;
  out.y = current.y + dy * scale;
  out.z = current.z + dz * scale;
  return out;
}

/**
 * 水平面内以有限步长逼近目标速度。
 *
 * 单独提供这个函数是因为玩家控制器只对 XZ 施加摩擦力与加速度，Y 分量由重力与
 * 跳跃接管，两种运动必须互相独立。
 *
 * @param out - 写入目标，可以与 `current` 是同一个对象。
 * @param current - 当前速度（只读取 X/Z）。
 * @param targetX - 目标 X 速度。
 * @param targetZ - 目标 Z 速度。
 * @param maxDelta - 本次允许的最大变化量。
 */
export function moveTowardsHorizontal(
  out: Vec3,
  current: Vec3,
  targetX: number,
  targetZ: number,
  maxDelta: number,
): Vec3 {
  const dx = targetX - current.x;
  const dz = targetZ - current.z;
  const distance = Math.sqrt(dx * dx + dz * dz);

  if (distance <= maxDelta || distance < 1e-8) {
    out.x = targetX;
    out.z = targetZ;
    return out;
  }
  if (maxDelta <= 0) {
    out.x = current.x;
    out.z = current.z;
    return out;
  }

  const scale = maxDelta / distance;
  out.x = current.x + dx * scale;
  out.z = current.z + dz * scale;
  return out;
}

/**
 * 把数值限制到闭区间 `[min, max]`。
 *
 * @param value - 输入值。
 * @param min - 下界。
 * @param max - 上界。
 */
export function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** 把数值限制到 `[0, 1]`。 */
export function clamp01(value: number): number {
  return clampNumber(value, 0, 1);
}
