/**
 * 地形生成使用的标量工具。
 *
 * I. 为什么单独成模块而不是并进 `Noise.ts`
 *
 * 1. `Noise.ts` 负责"可复现的随机场"，这里的函数是纯代数的区间映射。两者被修改
 *    的动机完全不同：前者关乎存档兼容（改一点旧世界就变形），后者关乎地形形状调参。
 * 2. 这些函数在地形热循环里每个方块都会被调用，集中在一处便于确认它们不分配内存、
 *    不做隐式类型转换。
 *
 * @module terrain/math
 */

/**
 * 把数值夹到闭区间 `[min, max]`。
 *
 * @param value - 待夹取的值。
 * @param min - 下界。
 * @param max - 上界。
 * @returns 夹取后的值。
 */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 把数值夹到 `[0, 1]`。
 *
 * 单独提供而不是复用 {@link clamp}，是因为这个调用点太多，写成 `clamp(v, 0, 1)`
 * 会让"归一化"的意图淹没在数字里。
 *
 * @param value - 待夹取的值。
 */
export function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 线性插值。
 *
 * 刻意不夹取 `t`：调用方有时需要外推（例如把噪声值映射到超出端点的范围）。
 *
 * @param a - `t = 0` 时的值。
 * @param b - `t = 1` 时的值。
 * @param t - 插值参数。
 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * `3t^2 - 2t^3` 平滑曲线。
 *
 * 与 `smoothstep(a, b, x)` 分开，是因为在已经把参数归一化过的热循环里再算一次
 * 区间映射是纯粹的浪费。地形里的"权重淡出"几乎都走这条路径。
 *
 * @param t - 已归一化到 `[0, 1]` 的参数。
 */
export function smoothCurve(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

/**
 * 经典 smoothstep：在 `[edge0, edge1]` 之间把 `x` 平滑映射到 `[0, 1]`。
 *
 * I. 为什么允许 `edge0 > edge1`
 *
 * 1. 地形代码里"越平坦越像山地"这类反向映射很常见，写成 `smoothstep(0.65, 0.25, x)`
 *    比 `1 - smoothstep(0.25, 0.65, x)` 更难写错，前者是单调递减、后者是两段拼接。
 * 2. `edge0 === edge1` 时退化为阶跃，避免除零。
 *
 * @param edge0 - `x` 低于它时结果为 0（`edge0 > edge1` 时相反）。
 * @param edge1 - `x` 高于它时结果为 1（`edge0 > edge1` 时相反）。
 * @param x - 输入值。
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) {
    return x < edge0 ? 0 : 1;
  }
  return smoothCurve((x - edge0) / (edge1 - edge0));
}
