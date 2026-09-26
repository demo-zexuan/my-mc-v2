/**
 * AABB 与体素世界的碰撞求解。
 *
 * I. 为什么是"逐轴推进"而不是连续碰撞检测（CCD）
 *
 * 1. 体素世界由单位立方体组成，AABB 与体素的相交判定退化成整数范围扫描；把三轴
 *    解耦后每次只需在一条轴上求最近的阻挡平面，实现简单且不存在斜向穿透。
 * 2. 逐轴求解天然带来"贴墙滑行"：X 被挡住时 Z 仍然推进，玩家沿墙滑动而不是被
 *    卡死。CCD 需要额外计算接触法线与切向速度，在这个场景下没有任何收益。
 * 3. 代价是单步位移过大时会跳过薄墙（起点与目标点之间的方块不参与判定）。
 *    求解器因此按 `maxSubStepLength`（默认 0.4 格）切分位移：任何半宽 >= 0.1 的
 *    实体都不可能一步跨过 1 格厚的墙。
 *
 * II. 顺序：Y → X → Z
 *
 * 1. 先解 Y 轴，可以在地面接触建立之后再推进水平位置。反过来做（先 X/Z 再 Y）
 *    时，玩家从台阶边缘走出会先被台阶侧面挡住、再落到旁边，表现为"被台阶边缘
 *    挂住"。
 * 2. X 在 Z 之前只是约定：两者是对称的，但固定顺序保证了同样的输入必然得到同样
 *    的结果（确定性），这对单元测试与录像回放都重要。
 *
 * III. "卡在方块里"的自救
 *
 * 出生点落在方块内部、传送点被地形覆盖、或者世界数据被外部修改，都会让玩家以
 * 重叠状态开始这一步。逐轴推进无法处理这种初始重叠（推进方向不确定），因此求解
 * 前先做一次**最小平移向量**（MTV）推出：在所有重叠体素上枚举六个方向的穿透深度，
 * 取最小者。同深度时优先向上推——把玩家顶到地面上比塞进地下更符合预期。
 *
 * IV. 浮点与"刚好贴面"
 *
 * 站在方块顶面上时，脚底坐标恰好等于方块的最大 Y。若用闭区间判定重叠，玩家会
 * 永远与脚下的方块"重叠"，于是每步都被推出一次，表现为持续抖动。所有体素范围
 * 扫描因此统一向内收缩 `SURFACE_EPSILON`，把"贴面"与"重叠"区分开。
 *
 * @module physics/AABB
 */

import { createVec3, type Vec3 } from './Vec3';

/** 世界坐标系中的轴对齐包围盒。 */
export interface AabbBounds {
  /** 最小角（包含）。 */
  readonly min: Vec3;
  /** 最大角（包含）。 */
  readonly max: Vec3;
}

/**
 * 碰撞求解所需的最小世界查询接口。
 *
 * `World` 的 `isSolidAt(x, y, z)` 结构化满足这个接口，物理层因此不需要 import
 * 具体世界实现，单元测试可以传入手写的假世界。
 */
export interface SolidWorld {
  isSolidAt(x: number, y: number, z: number): boolean;
}

/**
 * 碰撞体。
 *
 * I. 坐标约定
 *
 * 1. `position` 是**脚底中心**（方块游戏惯例）：AABB 在 Y 轴上从 `position.y` 延伸
 *    到 `position.y + height`，而不是以几何中心描述。这样做的好处是"站在地面上"
 *    与"眼睛高度"都只是一次加法，不需要每次减去半高。
 * 2. `position` 是只读引用，但其分量可以被求解器就地修改；调用方若需要保留旧值
 *    必须自己复制。
 */
export interface CollisionBody {
  /** 脚底中心位置。 */
  readonly position: Vec3;
  /** 水平半宽（0.6 宽的玩家为 0.3）。 */
  readonly halfWidth: number;
  /** 总高度（玩家为 1.8）。 */
  readonly height: number;
}

/** 一步碰撞求解的结果。 */
export interface MoveResult {
  /** 修正后的脚底位置（新对象，不影响传入的碰撞体）。 */
  readonly position: Vec3;
  /** 脚下是否有支撑；被 Y 轴阻挡或地面探测命中都为 true。 */
  readonly onGround: boolean;
  /** X 轴推进被阻挡（撞墙）。 */
  readonly blockedX: boolean;
  /** Y 轴推进被阻挡（落地或撞头）。 */
  readonly blockedY: boolean;
  /** Z 轴推进被阻挡（撞墙）。 */
  readonly blockedZ: boolean;
  /** Y 轴正方向被阻挡（撞到天花板），用于把向上的速度清零。 */
  readonly hitCeiling: boolean;
}

/** 求解选项。 */
export interface MoveOptions {
  /** 单段位移上限，越小越精确但越慢；默认 {@link DEFAULT_MAX_SUB_STEP_LENGTH}。 */
  readonly maxSubStepLength?: number;
  /** 是否在推进前做"卡进方块"的自救推出，默认 true。 */
  readonly resolveStuck?: boolean;
}

/**
 * 单段位移的默认上限。
 *
 * 0.4 的取值来自两个约束：(1) 必须小于 1 格，否则可能跨过薄墙；(2) 必须大于
 * `groundProbeDepth`，否则玩家在落地的那一步探测不到地面。玩家坠落终速 78.4 格/秒
 * 在 1/60 秒里移动 1.31 格，因此最多切分成 4 段。
 */
export const DEFAULT_MAX_SUB_STEP_LENGTH = 0.4;

/** 表面容差：小于该值的重叠视为"贴面"，不算穿透。 */
const SURFACE_EPSILON = 1e-4;

/** 地面探测深度：脚底向下探这么深，用于"速度为 0 但仍站在地上"的判定。 */
const GROUND_PROBE_DEPTH = 1e-3;

/** 自救推出的最大迭代次数：超过说明数据异常，继续推只会原地打转。 */
const MAX_UNSTICK_ITERATIONS = 8;

/**
 * 子步长度的允许区间。
 *
 * 上限必须小于 1 格：只有"每段位移 < 1 格"才能保证求解器不会跨过一整格方块
 * （子步只检测目标位置的包围盒，中间状态依赖这个不等式成立）。下限用于防止
 * 调用方传入极小值导致单步被切成上万段。
 */
const MIN_SUB_STEP_LENGTH = 0.02;
const MAX_SUB_STEP_LENGTH = 0.9;

/** 坐标轴标识。 */
type Axis = 'x' | 'y' | 'z';

/** 求解过程中就地维护的包围盒，避免每个子步重新分配对象。 */
interface MutableBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** 单个方向的推出方案。 */
interface PushOut {
  readonly axis: Axis;
  readonly amount: number;
}

// ---------------------------------------------------------------------------
// 坐标访问与包围盒同步
// ---------------------------------------------------------------------------

function readAxis(vector: Vec3, axis: Axis): number {
  if (axis === 'x') return vector.x;
  if (axis === 'y') return vector.y;
  return vector.z;
}

function writeAxis(vector: Vec3, axis: Axis, value: number): void {
  if (axis === 'x') {
    vector.x = value;
  } else if (axis === 'y') {
    vector.y = value;
  } else {
    vector.z = value;
  }
}

/** 依据脚底位置与尺寸刷新包围盒；半宽同时用于 X 与 Z，玩家因此是方柱体。 */
function syncBounds(
  bounds: MutableBounds,
  position: Vec3,
  halfWidth: number,
  height: number,
): void {
  bounds.minX = position.x - halfWidth;
  bounds.maxX = position.x + halfWidth;
  bounds.minY = position.y;
  bounds.maxY = position.y + height;
  bounds.minZ = position.z - halfWidth;
  bounds.maxZ = position.z + halfWidth;
}

/**
 * 由包围盒求覆盖的整数体素范围。
 *
 * I. 为什么向内收缩 epsilon
 *
 * 1. 玩家站在方块顶面时 `minY` 恰好等于该方块的最大 Y。若使用闭区间，这个方块会
 *    被反复判定为重叠，玩家每一步都被向上推出，表现为抖动。
 * 2. 收缩量必须远小于一个子步的位移（0.4 格），否则真正刚压进方块的瞬间会被漏掉。
 */
function voxelLo(min: number): number {
  return Math.floor(min + SURFACE_EPSILON);
}

function voxelHi(max: number): number {
  return Math.floor(max - SURFACE_EPSILON);
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/**
 * 沿指定轴由近到远扫描包围盒覆盖的体素，返回第一个实体方块的坐标。
 *
 * @param world - 方块查询来源。
 * @param bounds - 当前包围盒。
 * @param axis - 扫描轴。
 * @param step - `+1` 表示先看靠近正方向的一侧，`-1` 表示相反。
 * @returns 阻挡平面坐标（体素整数坐标），没有阻挡时返回 `null`。
 */
function findNearestBlockingPlane(
  world: SolidWorld,
  bounds: MutableBounds,
  axis: Axis,
  step: number,
): number | null {
  const loX = voxelLo(bounds.minX);
  const hiX = voxelHi(bounds.maxX);
  const loY = voxelLo(bounds.minY);
  const hiY = voxelHi(bounds.maxY);
  const loZ = voxelLo(bounds.minZ);
  const hiZ = voxelHi(bounds.maxZ);

  // I. 三个轴各写一遍循环：动态轴无法在保持内层循环连续访问的同时让 JIT 满意，
  //    而且这里的分支每步只判定一次，不在内层。
  if (axis === 'x') {
    for (let x = step > 0 ? loX : hiX; step > 0 ? x <= hiX : x >= loX; x += step) {
      for (let y = loY; y <= hiY; y += 1) {
        for (let z = loZ; z <= hiZ; z += 1) {
          if (world.isSolidAt(x, y, z)) {
            return x;
          }
        }
      }
    }
    return null;
  }

  if (axis === 'y') {
    for (let y = step > 0 ? loY : hiY; step > 0 ? y <= hiY : y >= loY; y += step) {
      for (let x = loX; x <= hiX; x += 1) {
        for (let z = loZ; z <= hiZ; z += 1) {
          if (world.isSolidAt(x, y, z)) {
            return y;
          }
        }
      }
    }
    return null;
  }

  for (let z = step > 0 ? loZ : hiZ; step > 0 ? z <= hiZ : z >= loZ; z += step) {
    for (let x = loX; x <= hiX; x += 1) {
      for (let y = loY; y <= hiY; y += 1) {
        if (world.isSolidAt(x, y, z)) {
          return z;
        }
      }
    }
  }
  return null;
}

/**
 * 包围盒是否与任意实体方块重叠。
 *
 * @param world - 方块查询来源。
 * @param bounds - 待检测的包围盒。
 */
function overlapsAnySolid(world: SolidWorld, bounds: MutableBounds): boolean {
  return findNearestBlockingPlane(world, bounds, 'x', 1) !== null;
}

/**
 * 地面探测：把包围盒整体下移一个极小量，看是否压到方块。
 *
 * 这一步是必要的：玩家站在地面上时 Y 速度被清零，位移为 0，仅靠"推进被阻挡"
 * 无法判断是否仍然着地，会出现"站着突然被认为浮空"从而无法跳跃的问题。
 *
 * @param world - 方块查询来源。
 * @param position - 脚底位置。
 * @param halfWidth - 水平半宽。
 * @param height - 总高度。
 */
function probeGround(
  world: SolidWorld,
  position: Vec3,
  halfWidth: number,
  height: number,
): boolean {
  const minY = position.y - GROUND_PROBE_DEPTH;
  const bounds: MutableBounds = {
    minX: position.x - halfWidth,
    maxX: position.x + halfWidth,
    minY,
    maxY: minY + height,
    minZ: position.z - halfWidth,
    maxZ: position.z + halfWidth,
  };
  return overlapsAnySolid(world, bounds);
}

// ---------------------------------------------------------------------------
// 单轴推进
// ---------------------------------------------------------------------------

/**
 * 在单条轴上推进碰撞体，遇到实体方块时贴回最近的阻挡平面。
 *
 * @param world - 方块查询来源。
 * @param bounds - 复用的包围盒，函数内会同步到最新位置。
 * @param position - 就地修改的脚底位置。
 * @param axis - 推进轴。
 * @param delta - 该轴的位移量。
 * @param halfWidth - 水平半宽。
 * @param height - 总高度。
 * @returns 是否被阻挡。
 */
function sweepAxis(
  world: SolidWorld,
  bounds: MutableBounds,
  position: Vec3,
  axis: Axis,
  delta: number,
  halfWidth: number,
  height: number,
): boolean {
  if (delta === 0) {
    return false;
  }

  // I. 先推进到目标点，再扫描目标包围盒覆盖的体素。
  writeAxis(position, axis, readAxis(position, axis) + delta);
  syncBounds(bounds, position, halfWidth, height);

  const blocking = findNearestBlockingPlane(world, bounds, axis, delta > 0 ? 1 : -1);
  if (blocking === null) {
    return false;
  }

  // II. 贴回阻挡平面。
  // 1. Y 轴上 `position` 就是包围盒的最小侧（脚底），所以向下运动时直接落在
  //    `blocking + 1`（方块顶面），向上运动时最大侧贴到 `blocking`。
  // 2. X / Z 轴上 `position` 是中心，需要在两个方向上各让出半个宽度。
  // 3. 贴回后位置恰好落在整数边界上，因此下一步的推进量会先被"吃掉"一小段，
  //    而不是每步都产生新的重叠——这正是"落地不抖动"的来源。
  if (axis === 'y') {
    writeAxis(position, 'y', delta > 0 ? blocking - height : blocking + 1);
  } else {
    writeAxis(position, axis, delta > 0 ? blocking - halfWidth : blocking + 1 + halfWidth);
  }
  syncBounds(bounds, position, halfWidth, height);
  return true;
}

// ---------------------------------------------------------------------------
// 自救推出
// ---------------------------------------------------------------------------

/**
 * 求出把包围盒推出所有重叠方块的最小平移向量。
 *
 * I. 候选顺序即优先级
 *
 * 每个重叠体素给出六个候选方向（+Y、-Y、+X、-X、+Z、-Z）。取穿透深度最小者；
 * 深度相同时保留先出现的候选，于是"向上推"优先于其余五个方向。把玩家顶到地面
 * 上比塞进地下更符合直觉，也更不容易把玩家推进未加载区块。
 */
function findMinimumPush(
  world: SolidWorld,
  position: Vec3,
  halfWidth: number,
  height: number,
): PushOut | null {
  const minX = position.x - halfWidth;
  const maxX = position.x + halfWidth;
  const minY = position.y;
  const maxY = position.y + height;
  const minZ = position.z - halfWidth;
  const maxZ = position.z + halfWidth;

  let best: PushOut | null = null;
  let bestMagnitude = Number.POSITIVE_INFINITY;

  const consider = (axis: Axis, amount: number): void => {
    const magnitude = Math.abs(amount);
    if (magnitude > SURFACE_EPSILON && magnitude < bestMagnitude - SURFACE_EPSILON) {
      bestMagnitude = magnitude;
      best = { axis, amount };
    }
  };

  for (let x = voxelLo(minX); x <= voxelHi(maxX); x += 1) {
    for (let y = voxelLo(minY); y <= voxelHi(maxY); y += 1) {
      for (let z = voxelLo(minZ); z <= voxelHi(maxZ); z += 1) {
        if (!world.isSolidAt(x, y, z)) {
          continue;
        }
        consider('y', y + 1 - minY);
        consider('y', y - maxY);
        consider('x', x + 1 - minX);
        consider('x', x - maxX);
        consider('z', z + 1 - minZ);
        consider('z', z - maxZ);
      }
    }
  }

  return best;
}

/** 就地自救推出；返回是否发生了移动。 */
function resolveOverlapInto(
  world: SolidWorld,
  position: Vec3,
  halfWidth: number,
  height: number,
): boolean {
  let moved = false;
  for (let iteration = 0; iteration < MAX_UNSTICK_ITERATIONS; iteration += 1) {
    const push = findMinimumPush(world, position, halfWidth, height);
    if (push === null) {
      break;
    }
    writeAxis(position, push.axis, readAxis(position, push.axis) + push.amount);
    moved = true;
  }
  return moved;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 由碰撞体求包围盒。
 *
 * 返回新对象（含两个新向量），因此只适合每步调用一次；求解器内部走的是无分配的
 * 数值路径。
 *
 * @param body - 碰撞体。
 */
export function bodyBounds(body: CollisionBody): AabbBounds {
  return {
    min: createVec3(
      body.position.x - body.halfWidth,
      body.position.y,
      body.position.z - body.halfWidth,
    ),
    max: createVec3(
      body.position.x + body.halfWidth,
      body.position.y + body.height,
      body.position.z + body.halfWidth,
    ),
  };
}

/**
 * 判断包围盒是否与指定体素相交。
 *
 * 用于交互层拒绝"会把玩家封在方块里"的放置请求。
 *
 * @param bounds - 包围盒。
 * @param x - 体素 X。
 * @param y - 体素 Y。
 * @param z - 体素 Z。
 */
export function boundsIntersectBlock(bounds: AabbBounds, x: number, y: number, z: number): boolean {
  return (
    bounds.max.x - x > SURFACE_EPSILON &&
    x + 1 - bounds.min.x > SURFACE_EPSILON &&
    bounds.max.y - y > SURFACE_EPSILON &&
    y + 1 - bounds.min.y > SURFACE_EPSILON &&
    bounds.max.z - z > SURFACE_EPSILON &&
    z + 1 - bounds.min.z > SURFACE_EPSILON
  );
}

/**
 * 判断包围盒当前是否与任意实体方块重叠（即是否卡在方块里）。
 *
 * @param world - 方块查询来源。
 * @param bounds - 包围盒。
 */
export function boundsOverlapSolid(world: SolidWorld, bounds: AabbBounds): boolean {
  const mutable: MutableBounds = {
    minX: bounds.min.x,
    maxX: bounds.max.x,
    minY: bounds.min.y,
    maxY: bounds.max.y,
    minZ: bounds.min.z,
    maxZ: bounds.max.z,
  };
  return overlapsAnySolid(world, mutable);
}

/**
 * 判断碰撞体是否卡在方块里。
 *
 * @param world - 方块查询来源。
 * @param body - 碰撞体。
 */
export function isInsideSolid(world: SolidWorld, body: CollisionBody): boolean {
  return boundsOverlapSolid(world, bodyBounds(body));
}

/**
 * 把卡在方块里的碰撞体沿最小穿透轴推出。
 *
 * I. 使用场景
 *
 * 1. 出生点或传送目标点恰好落在方块内部时，主动推出比让玩家卡死更友好。
 * 2. 独立导出以便测试与调试工具直接验证推出方向。
 *
 * @param world - 方块查询来源。
 * @param body - 碰撞体。
 * @returns 推出后的位置；本来就没有重叠时返回 `null`。
 */
export function resolveOverlap(world: SolidWorld, body: CollisionBody): Vec3 | null {
  const position = createVec3(body.position.x, body.position.y, body.position.z);
  const moved = resolveOverlapInto(world, position, body.halfWidth, body.height);
  return moved ? position : null;
}

/**
 * 带碰撞的位移求解。
 *
 * I. 处理流程
 *
 * 1. 复制输入位置，**不修改**传入的碰撞体（调用方决定何时接受新位置）。
 * 2. 自救推出：消除初始重叠。
 * 3. 把位移按 `maxSubStepLength` 切分成若干子步；每个子步按 Y → X → Z 推进，
 *    每轴推进后立即贴回阻挡平面，因此下一个轴看到的是修正后的包围盒。
 * 4. 汇总 `onGround`：本步向下推进被阻挡，或者地面探测命中。
 *
 * @param world - 方块查询来源。
 * @param body - 碰撞体（不会被修改）。
 * @param displacement - 本步位移（已包含 delta 时间）。
 * @param options - 可选的求解参数。
 */
export function moveBody(
  world: SolidWorld,
  body: CollisionBody,
  displacement: Vec3,
  options: MoveOptions = {},
): MoveResult {
  const halfWidth = body.halfWidth;
  const height = body.height;
  const position = createVec3(body.position.x, body.position.y, body.position.z);
  const bounds: MutableBounds = {
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
    minZ: 0,
    maxZ: 0,
  };

  // I. 自救：先解除初始重叠，否则后续的逐轴推进是在"错误前提"上求解。
  if (options.resolveStuck !== false) {
    resolveOverlapInto(world, position, halfWidth, height);
  }
  syncBounds(bounds, position, halfWidth, height);

  // II. 位移切分。
  // 1. 子步长度会被夹到 `[0.02, 0.9]`：上限是防穿墙的前提（每段位移必须小于
  //    1 格），下限是防止调用方传入极小值把一步切成上万段。
  const requested = options.maxSubStepLength ?? DEFAULT_MAX_SUB_STEP_LENGTH;
  const maxSubStep = Number.isFinite(requested)
    ? Math.min(MAX_SUB_STEP_LENGTH, Math.max(MIN_SUB_STEP_LENGTH, requested))
    : DEFAULT_MAX_SUB_STEP_LENGTH;
  const distance = Math.max(
    Math.abs(displacement.x),
    Math.abs(displacement.y),
    Math.abs(displacement.z),
  );
  const steps = Math.max(1, Math.ceil(distance / maxSubStep));
  const stepX = displacement.x / steps;
  const stepY = displacement.y / steps;
  const stepZ = displacement.z / steps;

  let blockedX = false;
  let blockedY = false;
  let blockedZ = false;
  let hitCeiling = false;
  let hitGround = false;

  for (let index = 0; index < steps; index += 1) {
    // 1. Y 轴先行：先建立地面接触，再做水平推进，避免被台阶边缘挂住。
    if (stepY !== 0 && sweepAxis(world, bounds, position, 'y', stepY, halfWidth, height)) {
      blockedY = true;
      if (stepY > 0) {
        hitCeiling = true;
      } else {
        hitGround = true;
      }
    }
    // 2. X 轴。
    if (stepX !== 0 && sweepAxis(world, bounds, position, 'x', stepX, halfWidth, height)) {
      blockedX = true;
    }
    // 3. Z 轴。
    if (stepZ !== 0 && sweepAxis(world, bounds, position, 'z', stepZ, halfWidth, height)) {
      blockedZ = true;
    }
  }

  // III. 着地判定：本步下方被阻挡，或地面探测命中。
  //     竖直速度被清零后位移为 0，必须依赖探测，否则玩家会"站在地上但浮空"。
  const onGround = hitGround || probeGround(world, position, halfWidth, height);

  return { position, onGround, blockedX, blockedY, blockedZ, hitCeiling };
}

/**
 * 判断碰撞体下方是否紧贴地面。
 *
 * 供外部（例如出生点搜索）复用与 `moveBody` 完全一致的判定口径。
 *
 * @param world - 方块查询来源。
 * @param body - 碰撞体。
 */
export function isOnGround(world: SolidWorld, body: CollisionBody): boolean {
  return probeGround(world, body.position, body.halfWidth, body.height);
}
