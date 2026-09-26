# 架构说明

本文档描述 My MC v2 的模块划分、依赖规则、**每个模块的真实契约**与关键设计决策。目标是让
多个开发者（或多个人 / Agent 会话）可以**并行修改不同模块而不互相破坏**。

> 契约一节中的签名全部取自 `src/` 当前代码，不是设计草案。修改接口必须同步更新消费方。

---

## I. 分层结构

```
                      ┌──────────────┐
                      │   main.ts    │  浏览器入口：挂载 + 全局错误兜底
                      └──────┬───────┘
                             │
                      ┌──────▼───────┐
                      │     app      │  生命周期装配（GameApp / WorldSession / GameState）
                      └──────┬───────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼────┐         ┌─────▼─────┐        ┌─────▼─────┐
   │   ui    │         │   debug   │        │  systems  │
   │ DOM HUD │         │  面板     │        │  player / │
   └────┬────┘         └─────┬─────┘        │  interact │
        │                    │              └─────┬─────┘
        └────────────────────┼────────────────────┘
                             │
   ┌─────────────┬───────────┼───────────┬─────────────┐
   │             │           │           │             │
┌──▼───┐   ┌─────▼────┐ ┌────▼────┐ ┌────▼────┐  ┌─────▼────┐
│world │   │ terrain  │ │ physics │ │inventory│  │  audio   │
└──┬───┘   └─────┬────┘ └────┬────┘ └────┬────┘  └─────┬────┘
   │             │           │           │             │
   └─────────────┴───────────┼───────────┴─────────────┘
                             │
                     ┌───────▼────────┐
                     │ rendering      │  渲染器 / 材质 / 纹理 / 光照
                     │ engine/core    │  固定步长循环、帧统计（不含游戏概念）
                     │ utils / config │  日志、错误、校验（无状态）
                     └────────────────┘
```

**依赖只能向下。** 违反此规则的 import 会被 `tests/unit/architecture.test.ts` 拒绝，该测试
实际强制以下四条：

| 规则                       | 内容                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| 每个文件都归属已知层       | `src/` 下第一级目录必须是白名单中的层，新顶层目录要同步改测试              |
| 无循环依赖                 | 运行时 import 构成的有向图必须无环（`import type` 与 `{ type X }` 不算边） |
| 下层不得反向依赖 UI / app  | `UI_AGNOSTIC_LAYERS`（17 个层）不得 import `ui`、`app`、`main`             |
| 生产代码不 import 测试代码 | `src/**` 不得引用 `tests/**`                                               |

> 为什么 `import type` 不算依赖边：`verbatimModuleSyntax` 保证类型导入被完全擦除，不可能
> 造成运行时初始化环；把它算成边只会逼出大量无意义的类型搬运。

---

## II. 关键设计决策

### 1. 数据与控制分离：Chunk 存 TypedArray，不存对象

区块尺寸为 **16 × 128 × 16**（`CHUNK_VOLUME = 32768`），方块数据存放在扁平 `Uint8Array` 中，
索引公式为本项目中唯一的 `indexInChunk(lx, y, lz) = lx + y * 256 + z * 16`。

- **为什么**：32 × 32 的加载范围有 3000 万+ 方块。用对象表示会产生同等数量的堆分配，GC
  停顿会直接表现为掉帧。
- **代价**：失去按方块附加任意字段的能力；稀疏信息（"被修改过的方块"）用区块内的
  `Map<number, BlockId>` 额外表达，也就是 `Chunk.getEdits()`。

坐标转换集中在 `world/coords.ts`，**所有**模块都必须通过它换算世界坐标 ↔ 区块坐标 ↔
区块内局部坐标，禁止各自手写位运算（负坐标下 `%` 与 `>>` 的语义不同，这是体素项目最经典的
一类 bug，见 `tests/unit/qa/coords-roundtrip.test.ts`）。

### 2. 渲染：面剔除 + 贪心合并，一个区块少数几个 Mesh

- **为什么**：一个方块一个 Mesh 的实现在 32 × 32 区块下需要数百万次 Draw Call。
- **做法**：只生成与空气/透明方块相邻的面（面剔除），再在同一平面上合并共面矩形
  （贪心合并），输出单个 `BufferGeometry`，按材质（不透明 / 透明）分包。
- **注意**：贪心合并以**面方向**为单位，因此不透明与透明方块必须分到不同 Mesh，否则透明
  排序会出错。
- **附带难点**：合并后的一个四边形横跨 N 个方块，UV 必须在图集内重复 N 次。做法是把
  "tile 局部重复坐标"与"图集内边界矩形"一起送进着色器，在片元里用 `fract()` 折回边界
  内；采样必须用 `textureGrad()`，否则 `fract()` 在整数边界的导数不连续会把 mip 级别选到
  最粗一级，表现为方块边界上的一条"邻居颜色"亮线（`patchAtlasUvShader`）。

### 3. 世界分块与流式加载

- Chunk 按需生成、超出渲染距离后卸载；**只有被修改过的区块**才写盘。
- 世界生成在 **Web Worker** 池中完成，主线程只做 `BufferGeometry` 上传。
- **为什么**：地形生成包含多层 FBM 噪声，主线程执行会造成可感知的卡顿。

### 4. 地形确定性优先于"更聪明的噪声"

自研噪声实现（`terrain/Noise.ts`）而非引入 `simplex-noise`：

- **为什么**：存档只保存种子与**被修改过的方块**，未修改区块在加载时重新生成。如果依赖
  库改变了噪声实现，玩家回到旧世界会发现地形变了。确定性属于存档格式的一部分。
- **推论**：`generate(cx, cz, target)` 必须是 `(seed, cx, cz)` 的纯函数，且生成器不得持有
  跨调用可变状态（多个 worker 会并发调用同一份代码）。

### 5. 固定时间步物理 + 渲染插值

`engine/core/GameLoop` 以固定 **1/60 秒**推进模拟，渲染时给出插值系数。

- **为什么**：AABB 逐轴推进的碰撞求解对 delta 敏感，变步长会让玩家在低帧率下穿墙。
- **保护**：单帧最多追赶有限步数，超出部分丢弃并计入 `droppedSeconds`，避免"死亡螺旋"。

### 6. UI 使用原生 DOM，而不是前端框架

- **为什么**：HUD 每帧只更新文本与少量类名，框架的 diff 与订阅机制在这个场景下是纯开销；
  更重要的是，框架会把游戏状态拖进响应式依赖图，让引擎模块无法脱离 DOM 测试。
- **约束**：`ui/` 只读上层传来的**快照数据**，不持有引擎对象的引用（`tests/unit/ui/boundaries.test.ts`
  静态检查这一点）。

### 7. 事件总线只承载"别人需要知道的事实"

`engine/events/EventBus` 的事件表是**冻结的**（`GameEventMap`，11 个事件）。它为粒子、音效、
提示、HUD 提供解耦点：破坏方块的系统只 emit `block:broken`，不需要知道谁在听。

- 已定义的事件：`block:broken`、`block:placed`、`mining:target-changed`、`mining:progress`、
  `item:collected`、`hotbar:selection-changed`、`ui:notice`、`player:chunk-changed`、
  `player:landed`、`time:tick`、`time:phase-changed`。
- **为什么冻结**：事件是跨模块的隐式接口，允许随手新增会让"谁依赖谁"变得不可审计。

---

## III. 模块契约（并行开发的边界）

> 下表与后续小节描述每个模块**对外可见**的最小面。带 `#` 前缀的是真正的私有字段，
> 外部无法访问；`readonly` 字段可以被读但不能替换。

### 1. `world/BlockRegistry.ts` — 方块属性表

```ts
export const BlockId = { Air: 0, Stone: 1, /* … */ Brick: 21 } as const;
export type BlockId = (typeof BlockId)[keyof typeof BlockId];

export const BLOCK_FLAG = {
  SOLID: 1 << 0,
  OPAQUE: 1 << 1,
  TRANSPARENT: 1 << 2,
  LIQUID: 1 << 3,
  BREAKABLE: 1 << 4,
  EMISSIVE: 1 << 5,
} as const;

export const BLOCK_FLAGS: Uint8Array; // 下标 = 方块 id，长度 256
export const BLOCK_HARDNESS: Float32Array; // 破坏耗时（秒）
export const BLOCK_DROP: Int16Array; // 掉落物 id，-1 表示"什么都不掉"
export const BLOCK_LIGHT_ATTENUATION: Float32Array;
export const BLOCK_TYPE_COUNT: number; // = BLOCK_DEFINITIONS.length

export function definitionOf(id: BlockId): BlockDefinition; // 未登记 id 抛 RangeError
export function isSolid(id: BlockId): boolean; // 另有 isOpaque / isTransparent /
// isLiquid / isBreakable / isEmissive
export function hardnessOf(id: BlockId): number;
export function dropOf(id: BlockId): BlockId | null;
export function lightAttenuationOf(id: BlockId): number;
export function texturesOf(id: BlockId): BlockTextures;
export function blockIdByName(name: string): BlockId | null;
export function allBlocks(): readonly BlockDefinition[];
```

**为什么这样设计**：网格构建每个区块要读几万次方块属性，查 `Uint8Array`/`Float32Array` 表比
走对象属性链快且零分配；`buildTables()` 在模块加载时强制 `definition.id === 数组下标`，从而
保证存档里裸存的 id 永远指向同一个方块。**id 不得重编号。**

### 2. `world/coords.ts` — 唯一的坐标换算入口

```ts
export const CHUNK_SIZE_X = 16,
  CHUNK_SIZE_Y = 128,
  CHUNK_SIZE_Z = 16;
export const CHUNK_AREA = 256,
  CHUNK_VOLUME = 32768;
export const WORLD_MIN_Y = 0,
  WORLD_MAX_Y = 127;

export function worldToChunkCoord(worldValue: number, chunkSize: number): number;
export function blockToChunk(x: number, z: number): ChunkCoord;
export function blockToLocal(x: number, z: number): { lx: number; lz: number };
export function indexInChunk(lx: number, y: number, lz: number): number;
export function coordsFromIndex(index: number): { lx: number; y: number; lz: number };
export function chunkKey(cx: number, cz: number): number; // 可逆
export function chunkKeyToCoord(key: number): ChunkCoord;
export function isInsideWorldHeight(y: number): boolean;
```

**为什么这样设计**：`chunkKey` 用一个 32 位整数表示区块坐标，这样 `Map<number, Chunk>` 不需要
为每个查询分配临时对象；把换算集中在一处，才能保证负坐标（`-1 → 区块 -1，局部 15`）在所有
模块中语义一致。

### 3. `world/Chunk.ts` — 一个区块的数据 + 脏标记

```ts
export interface BlockEdit {
  readonly index: number;
  readonly id: BlockId;
}

export class Chunk {
  static readonly SIZE_X = 16;
  static readonly SIZE_Y = 128;
  static readonly SIZE_Z = 16;
  static readonly VOLUME = 32768;

  readonly cx: number;
  readonly cz: number;
  readonly blocks: Uint8Array; // 长度必须为 CHUNK_VOLUME，否则构造时抛 RangeError
  readonly heightMap: Uint8Array; // 每列最高非空气方块 + 1

  get meshDirty(): boolean;
  get lightDirty(): boolean;
  get modified(): boolean; // 是否存在需要写盘的编辑
  get highestNonAir(): number; // 空区块为 -1
  get editCount(): number;

  getBlock(lx: number, y: number, lz: number): BlockId; // 越界返回 Air
  setBlock(lx: number, y: number, lz: number, id: BlockId, recordEdit = true): boolean;
  getHeight(lx: number, lz: number): number;
  markMeshDirty(): void;
  markMeshClean(): void;
  markLightClean(): void;
  recomputeHeightMap(): void;
  getEdits(): readonly BlockEdit[];
  applyEdits(edits: readonly BlockEdit[]): void;
}
```

**为什么这样设计**：`heightMap` 是缓存而不是派生结果——地形装饰、树木放置、出生点搜索和
"脚下是不是空的"检查都要用它，每次重扫 128 格会让区块生成慢一个量级；`recordEdit` 参数
让"地形生成写入"不产生编辑记录（生成结果是可复现的，不需要进存档），只有玩家修改才记录。

### 4. `world/World.ts` — 区块容器 + 方块读写

```ts
export class World {
  readonly seed: number;
  readonly generator: TerrainGenerator;

  get loadedChunkCount(): number;
  get chunks(): IterableIterator<Chunk>;
  getChunk(cx: number, cz: number): Chunk | undefined;
  hasChunk(cx: number, cz: number): boolean;
  isPending(cx: number, cz: number): boolean;

  beginGeneration(cx: number, cz: number): boolean; // 去重，已在队列/已加载返回 false
  cancelGeneration(cx: number, cz: number): void;
  adoptGeneratedChunk(cx: number, cz: number, blocks: Uint8Array): Chunk;
  generateChunkNow(cx: number, cz: number): Chunk; // 同步生成（worker 不可用时的降级路径）
  unloadChunk(cx: number, cz: number): Chunk | null;

  getBlock(x: number, y: number, z: number): BlockId; // 世界坐标，未加载返回 Air
  setBlock(x: number, y: number, z: number, id: BlockId, recordEdit = true): boolean;
  isSolidAt(x: number, y: number, z: number): boolean;
  surfaceHeightAt(x: number, z: number): number;
  chunkOf(x: number, z: number): { readonly cx: number; readonly cz: number };

  *editedChunks(): IterableIterator<Chunk>; // 只产出 modified === true 的区块
  trimToCapacity(protectedKeys?: ReadonlySet<number>): number;
  clear(): void;
  stats(): WorldStats; // 供调试面板，不含对象分配
}
```

**为什么这样设计**：`beginGeneration`/`adoptGeneratedChunk` 把"请求去重"和"写入"拆成两步，
是因为生成发生在 worker 里，主线程必须先在 `#pending` 里占位，否则玩家在每个区块边界来回走
会重复排队；`setBlock` 跨区块时标记邻居 `meshDirty`，否则边界上会留下一堵"幽灵墙"。

### 5. `world/ChunkStreamer.ts` — 按玩家位置流式加载

```ts
export class ChunkStreamer {
  get renderDistance(): number;
  get stats(): {
    queued: number;
    inFlight: number;
    loaded: number;
    dispatched: number;
    failed: number;
  };
  setRenderDistance(distance: number): void;
  update(playerX: number, playerZ: number): number; // 返回本帧派发数
  preload(playerX: number, playerZ: number, radius?: number): Promise<void>;
  setOnEditedChunkUnloaded(handler: (chunk: Chunk) => void): void;
  dispose(): void;
}
```

**为什么这样设计**：队列只在玩家**跨区块**时重算（`#centreCx/#centreCz` 守卫），因为在一个
区块内走几步不可能改变"哪些区块在范围内"，每帧重算会为每个区块分配一条队列记录；额外保留
`keepMargin` 圈已加载区块，避免玩家在边界来回走时"卸载又立刻重新请求"。

### 6. `terrain/TerrainGenerator.ts` — 确定性地形

```ts
export interface TerrainGenerator {
  readonly seed: number;
  readonly options: Required<TerrainOptions>;
  generate(cx: number, cz: number, target: ChunkDataTarget): void;
  surfaceHeightAt(x: number, z: number): number;
  biomeAt(x: number, z: number): BiomeId;
}
export type TerrainGeneratorFactory = (seed: number, options?: TerrainOptions) => TerrainGenerator;
export const createTerrainGenerator: TerrainGeneratorFactory;
export function resolveTerrainOptions(options?: TerrainOptions): Required<TerrainOptions>;
```

实际参数：海平面 62、基准高度 68；生物群系 `ocean | beach | plains | forest | hills |
mountains | snow`；矿脉按深度加权抽取（钻石 ≤ Y16、金 ≤ Y32、铁 ≤ Y64、煤 ≤ Y112）。
`terrain/Noise.ts` 提供 `SeededRandom`、`GradientNoise`、`fbm2/fbm3`、`ridged2`、
`domainWarp2`、`hashCoordinates`；`terrain/FlatTerrainGenerator.ts` 提供超平坦实现供测试与
基准使用。

**为什么这样设计**：每个用途（大陆度 / 侵蚀 / 山脊 / 洞穴 / 树 / 矿）从种子派生一个独立
子种子（`SEED_SLOT`），这样调某一个维度不会让其他维度整体漂移；树与矿用"确定性特征网格"
而不是随机撒点，才能保证跨区块时同一棵树不会被生成两次或被区块边界截断。

### 7. `rendering/ChunkMesher.ts` — 面剔除 + 贪心合并

```ts
export class ChunkMesher {
  constructor(lookup: TileLookup);
  mesh(chunk: Chunk, accessor: BlockAccessor): ChunkMeshData;
}
export interface ChunkMeshData {
  readonly opaque: ChunkMeshGroup; // positions / normals / uvs / tileRects / indices
  readonly transparent: ChunkMeshGroup;
  readonly stats: ChunkMeshStats; // quads / unitFaces / vertices / triangles
}
export function createChunkMapAccessor(chunks: ReadonlyMap<number, Chunk>): BlockAccessor;
```

**为什么这样设计**：输入是 `Chunk` + "跨区块访问器"，因为边界面的可见性取决于邻居区块；
输出是裸 typed array 而不是 `BufferGeometry`，这样同一份代码既能在主线程用，也能在 worker
里用（`BufferGeometry` 只能在有 GPU 上下文的一侧创建）。

### 8. `rendering/WorldRenderer.ts` — 区块 Mesh 生命周期

```ts
export class WorldRenderer {
  readonly group: THREE.Group;
  constructor(scene: THREE.Scene, options?: WorldRendererOptions); // rebuildBudget 默认 2
  stats(): { chunks: number; visible: number; quads: number; rebuilds: number; deferred: number };
  update(source: VoxelChunkSource, camera: THREE.Camera): void;
  dispose(): void;
}
export function createChunkMaterials(atlas, options?): ChunkMaterials;
export function patchAtlasUvShader(shader: ShaderPatchTarget): void;
```

**为什么这样设计**：只有 4 个水平邻居都加载完毕才建网格（`deferred` 计数），否则边界面会
被误判为可见而生成"假墙"；重建按每帧预算摊开，避免玩家跨区块时一帧内重建几十个区块造成
尖峰；透明（水、玻璃、树叶）单独成组渲染，让 Three.js 能做正确的混合排序。

### 9. `rendering/Sky.ts` — 天空与昼夜

```ts
export class DayNightCycle {
  dayLengthSeconds: number; // 默认 1200 秒 = 20 分钟一天
  get timeOfDay(): number; // 0..1，0 为日出
  get phase(): 'night' | 'dawn' | 'day' | 'dusk';
  get state(): SkyState; // 复用的对象，零分配采样
  get paused(): boolean;
  set paused(value: boolean);
  setTime(value: number): void;
  advance(deltaSeconds: number): void;
}
export class Sky {
  readonly cycle: DayNightCycle;
  constructor(scene: THREE.Scene, options?: SkyOptions);
  get state(): SkyState;
  update(deltaSeconds: number, follow?: THREE.Vector3): void;
  applyFog(fog: FogLike | null): void;
  syncEnvironment(rig: EnvironmentRig): void;
  dispose(): void;
}
```

`SkyState` 含 `timeOfDay / phase / zenithColor / horizonColor / fogColor / sunColor /
cloudColor / sunIntensity / moonIntensity / ambientIntensity / cloudOpacity / sunDirection /
moonDirection`。

**为什么这样设计**：`DayNightCycle` 与 `Sky` 分开，是因为"时间"是游戏状态（要存档、要驱动
音效与 HUD），而"天空/日月/云"是纯表现；把采样结果写进一个复用对象而不是每次新建，是为了
在每帧调用时保持零分配。

### 10. `input/InputManager.ts` — 键鼠与指针锁定

```ts
export const DEFAULT_BINDINGS: Readonly<Record<InputAction, readonly string[]>>;
export class InputManager {
  get pointerLocked(): boolean;
  get paused(): boolean;
  get enabled(): boolean;
  get hotbarSlot(): number;

  isDown(code: string): boolean;
  wasPressed(code: string): boolean;
  wasReleased(code: string): boolean;

  isActionDown(action: InputAction): boolean;
  wasActionPressed(action: InputAction): boolean;
  wasActionReleased(action: InputAction): boolean;

  moveIntent(): MoveIntent; // 暂停/失焦时返回冻结的中性对象
  consumeLookDelta(): LookDelta; // 读取并清零
  consumeWheelDelta(): number;
  consumeHotbarSlot(): number | null;

  setEnabled(enabled: boolean): void;
  setPaused(paused: boolean): void;
  requestPointerLock(): void;
  exitPointerLock(): void;
  setHotbarSlot(index: number): void;
  endStep(): void; // 每个固定步结束调用，清空 pressed/released
  dispose(): void;
}
```

**为什么这样设计**：分成"动作（语义）"与"键码（物理）"两层，玩法代码只认 `InputAction`，
改键位不需要动玩家代码；`endStep()` 把"刚按下/刚释放"的窗口限定在一个固定步内，多步追赶时
不会把一次按键当成多次触发。

### 11. `player/PlayerController.ts` — 第一人称移动

```ts
export const FIXED_TIME_STEP = 1 / 60;
export const MAX_STEP_SECONDS = 1 / 30;

export class PlayerController {
  get player(): Player;
  get cameraRig(): CameraRig;
  get tuning(): PlayerMovementTuning;
  get currentChunk(): { readonly cx: number; readonly cz: number };
  get onGround(): boolean;
  get horizontalSpeed(): number;

  setSettings(settings: PlayerSettings): void;
  eyePosition(out?: Vec3): Vec3;
  update(deltaSeconds: number): void;
  applyCamera(camera: RigCamera, interpolation = 1): void;
  teleport(position: Vec3): void;
}
export function idealJumpHeight(tuning?: PlayerMovementTuning): number;
```

默认手感（`DEFAULT_MOVEMENT_TUNING`）：步行 4.317、疾跑 5.612、潜行 1.3 格/秒；地面加速度
40、空中 8 格/秒²；重力 32；起跳初速度 8.8；坠落终速 78.4；土狼时间 0.1 秒；跳跃缓冲 0.15 秒。

**为什么这样设计**：这些数字是对标 Minecraft 的实测值——它们决定跳跃高度（约 1.27 格）与
手感，任何"顺手改一下"都会让玩家跳不上自己搭的一格台阶；土狼时间与跳跃缓冲是为了让操作
在低帧率下仍然"跟手"，这两个窗口只在固定步里推进，因此不受帧率影响。

### 12. `physics/AABB.ts` + `physics/VoxelRaycast.ts` — 碰撞与射线

```ts
export function moveBody(
  world: SolidWorld,
  body: CollisionBody,
  displacement: Vec3,
  options?: MoveOptions,
): MoveResult;
export function boundsOverlapSolid(world: SolidWorld, bounds: AabbBounds): boolean;
export function isInsideSolid(world: SolidWorld, body: CollisionBody): boolean;
export function resolveOverlap(world: SolidWorld, body: CollisionBody): Vec3 | null;
export function isOnGround(world: SolidWorld, body: CollisionBody): boolean;

export function raycastVoxels(
  source: VoxelBlockSource,
  origin: Vec3,
  direction: Vec3,
  maxDistance: number,
  options?: VoxelRaycastOptions,
): VoxelRaycastHit;
export function placementPosition(hit: VoxelRaycastHit): Vec3 | null;
```

`moveBody` 返回 `{ position, onGround, blockedX, blockedY, blockedZ, hitCeiling }`。

**为什么这样设计**：碰撞只依赖结构化的 `SolidWorld.isSolidAt`，物理层因此不需要 import
具体世界实现，单元测试可以传手写假世界；射线用 Amanatides & Woo DDA 逐体素步进，而不是用
`THREE.Raycaster` 对每个区块网格的三角形做求交——前者只访问沿线的方块，后者要把场景里所有
几何体都过一遍。
`DEFAULT_MAX_SUB_STEP_LENGTH = 0.4` 的取值同时满足"小于 1 格不穿薄墙"和"大于地面探测深度
才能落地"。

### 13. `inventory/Inventory.ts` — 背包与堆叠

```ts
export const MAX_STACK_SIZE = 64,
  HOTBAR_SLOTS = 9,
  BACKPACK_SLOTS = 27;
export class PlayerInventory implements Inventory {
  readonly size: number; // 36
  get selectedIndex(): number;
  getSlot(index: number): ItemStack | null;
  peek(index: number): ItemStack | null;
  selectedStack(): ItemStack | null;
  setSlot(index: number, stack: ItemStack | null): void;
  add(item: BlockId, count: number): number; // 返回**放不下**的数量
  consumeSelected(count?: number): ItemStack | null;
  select(index: number): void; // 环形回绕，滚轮可传任意整数
  moveSlot(from: number, to: number): void; // 同类自动合并
  splitSlot(from: number, to: number): void;
  dropSlot(index: number): ItemStack | null;
  findItem(item: BlockId): number;
  countItem(item: BlockId): number;
  isEmpty(): boolean;
  snapshot(): InventorySnapshot;
  restore(snapshot: InventorySnapshot): void;
  clear(): void;
}
```

**为什么这样设计**：`add()` 返回"放不下的数量"而不是布尔值，调用方据此决定是"把剩余部分
留在掉落物里"还是"提示背包已满"——把策略留在调用方，背包本身保持纯数据。

### 14. `interaction/*` — 挖掘、放置、选中

```ts
export class BlockSelector {
  constructor(bus: EventBus);
  get current(): InteractionHit | null;
  get hasTarget(): boolean;
  update(hit: InteractionHit | null): boolean; // 目标变化时 emit 'mining:target-changed'
  clear(): void;
}

export class MiningSystem {
  get progress(): number;
  get target(): InteractionHit | null;
  get isMining(): boolean;
  get speed(): number;
  setTarget(hit: InteractionHit | null): boolean; // 换目标/丢失目标会重置进度
  tick(deltaSeconds: number, mining: boolean): void; // emit 'mining:progress' / 'block:broken'
  cancel(): void;
  reset(): void;
  timeToBreak(block: BlockId): number;
}

export const DEFAULT_REACH = 5.0;
export class BlockInteraction {
  get maxDistance(): number;
  canPlace(hit: InteractionHit | null): PlacementResult;
  place(hit: InteractionHit | null): PlacementResult; // emit 'block:placed'
}
```

`BlockInteraction` 的拒绝原因集合（`PlacementRejection`）共 7 种：`no-target`、
`out-of-range`、`no-item`、`not-placeable`、`obstructed`、`intersects-player`（会把自己封住）、
`world-rejected`（区块未加载或超出世界高度）。

**为什么这样设计**：挖掘进度按"硬度累计"而不是"固定时长"，且**看向别处必须重置**——否则
玩家可以对着石头挖一半再转身挖泥土，泥土会继承石头的进度，破坏两类方块的手感差异。

### 15. `entities/DropSystem.ts` — 掉落物与拾取

```ts
export const DEFAULT_PICKUP_RADIUS = 1.5,
  DEFAULT_PICKUP_VERTICAL_TOLERANCE = 2.0;
export const DEFAULT_MAX_ENTITIES = 256,
  MERGE_RADIUS = 0.75,
  MAX_SUB_STEP = 1 / 30;

export class DropSystem {
  get entities(): readonly ItemEntity[];
  get count(): number;
  get pickupRadius(): number;
  spawnDrop(item: BlockId, count: number, position: Vec3Like): ItemEntity | null;
  update(deltaSeconds: number): void; // emit 'item:collected'
  clear(): void;
  dispose(): void;
}
```

`ItemEntity` 常量：`ITEM_HALF_SIZE = 0.125`、`ITEM_GRAVITY = 26`、`ITEM_HORIZONTAL_DRAG = 0.55`、
`PICKUP_DELAY = 0.5`（秒）、`ITEM_LIFETIME = 300`（秒）。

**为什么这样设计**：`PICKUP_DELAY` 防止"刚丢出去的东西立刻被自己捡回来"；`MERGE_RADIUS`
让同一位置的大量掉落物合并成一个实体，否则挖一片沙地会生成几十个实体并把帧率拖下去。

### 16. `particles/ParticleSystem.ts` — 池化粒子

```ts
export const DEFAULT_PARTICLE_CAPACITY = 512;
export const DEFAULT_BREAK_PARTICLES = 12,
  DEFAULT_PLACE_PARTICLES = 6;

export class ParticleSystem {
  get capacity(): number;
  get activeCount(): number;
  get spawnedTotal(): number;
  get object3d(): THREE.Object3D;
  get geometry(): THREE.BoxGeometry;
  get material(): THREE.MeshBasicMaterial;
  burst(position: Vec3Like, options: ParticleBurstOptions): number;
  emitBlockBreak(x, y, z, color): void;
  emitBlockPlaced(x, y, z, color): void;
  update(deltaSeconds: number): void;
  clear(): void;
  dispose(): void;
}
```

**为什么这样设计**：状态用 SoA（`Float32Array` × N）而不是对象数组，配一个空闲槽位栈，
容量固定 512 且**永不增长**——粒子的视觉收益远小于一次 GC 停顿，所以宁可在池满时丢弃
最旧的粒子。`object3d`/`geometry`/`material` 暴露出来只是为了让测试与调试面板能读句柄。

### 17. `audio/AudioManager.ts` + `audio/SoundBank.ts` — 程序化音效

```ts
export class AudioManager {
  get status(): 'uninitialized' | 'running' | 'suspended' | 'unavailable' | 'disposed';
  get isRunning(): boolean;
  get isUnavailable(): boolean;
  get volumes(): AudioVolumes;
  get masterGain(): number | null;
  get sfxGain(): number | null;
  get ambientGain(): number | null;

  unlock(): Promise<boolean>; // 必须由用户手势触发
  playSound(name: SoundName, options?: PlaySoundOptions): boolean;
  setListenerPose(pose: ListenerPose): void;
  applySettings(volumes: Partial<AudioVolumes>): void;
  setAmbientPlaying(playing: boolean): void;
  dispose(): Promise<void>;
}
```

音效名共 **21** 个：8 种材质 × {破坏, 脚步}（`stone/dirt/grass/sand/wood/glass/water/snow`）
加 `block.place`、`player.jump`、`player.land`、`ui.click`、`item.pickup`。

**为什么这样设计**：`AudioContext` 必须在**首次用户手势之后**创建，否则浏览器会把它挂起；
构造失败必须降级为静音而不是抛错——"没有声音"是可接受的降级，"游戏打不开"不是。
所有音效都用 oscillator + 噪声 buffer + 包络合成，不引入任何音频文件，因此没有额外的网络
请求与版权问题。

### 18. `save/*` — IndexedDB 存档

```ts
export const SAVE_SCHEMA_VERSION = 2; // 结构版本
export const FIRST_SUPPORTED_SCHEMA_VERSION = 1;
export const SAVE_DATABASE_NAME = 'my-mc-v2';
export const WORLD_STORE_NAME = 'worlds',
  CHUNK_STORE_NAME = 'chunks';

export class SaveManager {
  get pendingChanges(): number;
  get isDirty(): boolean;
  get isAutosaveRunning(): boolean;
  listWorlds(): Promise<readonly WorldSummary[]>;
  loadWorld(worldId: string): Promise<LoadedWorld>;
  saveWorld(input: SaveWorldInput): Promise<WorldSummary>;
  hasWorld(worldId: string): Promise<boolean>;
  deleteWorld(worldId: string): Promise<void>;
  noteChunkModified(count?: number): boolean;
  startAutosave(provider: () => SaveWorldInput | null): void;
  stopAutosave(): void;
  tickAutosave(): Promise<boolean>;
  autosaveNow(): Promise<boolean>;
  dispose(): void;
}
export const AUTOSAVE_DEFAULTS = { intervalMs: 20_000, changeThreshold: 64 };
```

**为什么这样设计**：

1. **只存被修改过的区块**（`Chunk.getEdits()`）。未修改的区块由种子重新生成，一个 32×32
   的世界因此只占几十 KB 而不是几百 MB。
2. **数据库版本与存档结构版本分开**。`SAVE_DATABASE_VERSION` 只在对象仓库变化时 +1，
   `schemaVersion` 表示文档结构：v1 用 `version` 字段，v2 改用 `schemaVersion` 并带逐级
   迁移链（`migrate()`），版本高于程序支持时抛 `AppError('SAVE_VERSION_UNSUPPORTED')`，
   结构损坏抛 `AppError('SAVE_CORRUPTED')`。
3. **存储层是窄接口**（`SaveStorage`），IndexedDB 实现与内存实现可互换，因此 90% 的存档
   逻辑能在 Node 里用毫秒级测试，不必依赖 `fake-indexeddb`。
4. **列表容错**：单个损坏的存档只 warn 并跳过，一个坏文件不应该让"世界列表"整个打不开。

### 19. `settings/SettingsStore.ts` — 设置持久化

```ts
export const SETTINGS_STORAGE_KEY = 'my-mc-v2:settings';
export class SettingsStore {
  get current(): GameSettings;
  get persistent(): boolean; // localStorage 是否可用
  update(patch: Partial<GameSettings>): GameSettings;
  reset(): GameSettings;
  subscribe(listener: SettingsListener): () => void;
  reload(): GameSettings;
}
export function normalizeSettings(value: unknown): GameSettings;
export function qualityProfileFor(settings: GameSettings): QualityProfile;
```

默认值：灵敏度 0.0022 rad/px、FOV 75、渲染距离 8 区块、音量 0.8/0.9/0.5、画质 `medium`、
阴影开、调试面板开、视角摇晃开、Y 轴不反转。范围由 `SETTINGS_LIMITS` 强制
（FOV 50–110、渲染距离 2–16）。

**为什么这样设计**：设置从 `localStorage` 读回来，玩家（或另一个标签页、或浏览器扩展）可以
改它，所以**读取时钳制而不是拒绝**：一个损坏的灵敏度不应该让游戏打不开。每个字段独立回退
到默认值，而不是整份重置。

### 20. `workers/WorkerPool.ts` — 地形生成线程池

```ts
export class WorkerPool implements ChunkGenerationSource {
  get inFlight(): number;
  get workerCount(): number;
  get usingFallback(): boolean;
  get queuedCount(): number;
  request({ cx, cz }: ChunkRequest): Promise<Uint8Array | null>;
  dispose(): void;
}
export function defaultWorkerCount(): number;
```

消息协议（`workers/protocol.ts`）：`init` → `ready`，`generate-chunk { requestId, cx, cz }` →
`chunk-generated { requestId, cx, cz, blocks }`（`blocks.buffer` 转移所有权）或
`chunk-failed`。

**为什么这样设计**：单个 worker 会把玩家跨区块时的一批请求串行化，主线程生成又会卡帧，所以
用一个小池子；池大小有上限，因为每个 worker 都要各自持有噪声排列表的一份拷贝。worker 不可
用时（加固浏览器、CSP 禁止 `blob:`/`worker-src`）**降级到主线程同步生成**并只告警一次——
一个会卡顿的游戏好过一个打不开的游戏。

### 21. `app/*` — 装配层

```ts
export class GameApp {
  constructor(root: HTMLElement, options?: GameAppOptions);
  get booted(): boolean;
  start(): Promise<void>;
  dispose(): void;
}

export class WorldSession {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly world: World;
  readonly inventory: PlayerInventory;
  constructor(options: WorldSessionOptions);
  start(): Promise<void>;
  fixedStep(deltaSeconds: number): void; // 只在 simulates 状态推进
  render(deltaSeconds: number, interpolation: number): void;
  applySettings(): void;
  buildSaveInput(): SaveWorldInput;
  stats(): { chunks; queued; inFlight; drops; particles; timeTicks };
  get inventoryOpen(): boolean;
  get paused(): boolean;
  toggleInventory(): void;
  togglePause(force?: boolean): void;
  setSettingsVisible(visible: boolean): void;
  dispose(): void;
}
export function seedToNumber(seed: number | string): number;
```

`GameStateMachine` 的状态：`boot | menu | world-loading | playing | paused | inventory |
settings | saving | error`，每个状态带 `{ interactive, pointerLocked, simulates, label }`。

**为什么这样设计**：`GameApp` 拥有跨世界的资源（渲染器、UI、音频、存档），`WorldSession` 拥有
属于**一个世界**的一切，进出世界只销毁后者。状态机把"输入是否生效 / 指针是否锁定 / 模拟是否
推进"集中定义，避免三层嵌套的 `if (inventoryOpen || paused || …)`。

### 22. 其余模块（简表）

| 模块                            | 契约要点                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `engine/core/GameLoop`          | `start/stop/advance(timestampMs)`、`metrics`；注入 `FrameScheduler` 以便测试                                  |
| `engine/core/FrameStats`        | `record(frameTimeMs)`、`snapshot()`、`reset()`；EMA 平滑 + 固定窗口环形缓冲，`record` 不分配内存              |
| `engine/events/EventBus`        | `on/once/emit/listenerCount/clear`；`emit` 对监听器快照迭代、隔离抛错的监听器、把派发中的反注册延迟到派发结束 |
| `rendering/capabilities`        | `detectGraphicsBackend(canvas)`；**必须传入一次性 canvas**，探测会销毁上下文                                  |
| `rendering/createRenderer`      | `createRenderer(canvas, options)` → `{ renderer, dispose }`；唯一创建 `WebGLRenderer` 的位置                  |
| `rendering/Environment`         | `createEnvironment(scene, options)` → `{ hemisphereLight, sunLight, dispose }`；昼夜系统操作它                |
| `rendering/textures/BlockAtlas` | `tileUV(blockId, face)` → `{u0,v0,u1,v1}`、`texture`、`dispose()`；tile 间留 padding 防渗色                   |
| `ui/BootOverlay`                | `showLoading/setProgress/showFatal/hide/dispose`；接管 `index.html` 的静态首屏                                |
| `ui/MainMenu`                   | `update(info)`、`setCanReturn(bool)`；种子只接受字母/数字/空格/`_`/`-`，最长 32                               |
| `ui/Hotbar` / `ui/Hud`          | `update(snapshot)`；HUD 行固定为 坐标/区块/群系/时间/朝向/帧率                                                |
| `ui/NoticeStack`                | `push(message, {kind})`；info/success/warning/error 对应 3200/3000/4200/6000 ms                               |
| `ui/InventoryScreen`            | 点击拾取/放下、Shift 点击快速移动、面板内 tooltip；`update(snapshot)`                                         |
| `debug/DebugOverlay`            | `set(key, value)`、`setNumber(key, value, suffix)`、`toggle()`；行键固定，未知键被忽略                        |
| `utils/errors`                  | `AppError`、`toAppError`；`code` 供恢复逻辑分支，`userMessage` 面向玩家                                       |
| `config/env`                    | `parseAppConfig(source)`、`appConfig`；三个 `VITE_*` 变量都有默认值，校验失败也降级不抛错                     |

---

## IV. 测试策略

| 层级     | 位置                              | 运行环境                 | 验证内容                                                     |
| -------- | --------------------------------- | ------------------------ | ------------------------------------------------------------ |
| 单元测试 | `tests/unit/**`                   | Node / jsdom             | 数学、噪声、区块索引、背包规则、碰撞、存档迁移、UI 组件      |
| 集成测试 | `tests/integration/**`            | jsdom                    | 模块协作：场景装配、区块流式渲染、天空与环境联动、世界流水线 |
| 架构测试 | `tests/unit/architecture.test.ts` | Node                     | 依赖方向、无循环、分层白名单、生产代码不引用测试             |
| E2E 测试 | `tests/e2e/**`                    | 真实 Chromium + 生产构建 | 启动、WebGL2 上下文、F3 面板、输入移动、暂停、进出世界       |
| 视觉测试 | `tests/e2e/visual.spec.ts`        | 同上                     | 解码 PNG 后断言像素分布：非黑屏、天空偏冷、UI 居中不被裁切   |

**为什么 E2E 跑生产构建而不是开发服务器**：只有生产产物会暴露 hash 资源名、代码分割与压缩
引入的问题。Playwright 的 `webServer` 因此指向 `vite preview`。

---

## V. 扩展新模块时的检查清单

1. 放进哪个顶层目录？需要新增层级吗（同步改 `architecture.test.ts` 的 `Layer` 与白名单）？
2. 它依赖谁、被谁依赖？是否引入循环？是否让一个非 UI 层 import 了 `ui`/`app`？
3. 它需要 `dispose()` 吗？谁调用？是否与某个 `create*` 成对？
4. 纯逻辑部分能否脱离 DOM/WebGL 测试？
5. 需要新的调试指标吗？加到 `GameApp` 的 `WORLD_ROWS` 行清单。
6. 需要新的存档字段吗？**提升 `SAVE_SCHEMA_VERSION` 并补一个 `MIGRATIONS[n]` 迁移函数**。
7. 需要新事件吗？先问"消费方能不能直接读快照"，只有真正跨模块的事实才进 `GameEventMap`。
