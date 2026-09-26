/**
 * 区块网格构建：面剔除 + 贪心合并（greedy meshing）。
 *
 * I. 为什么必须贪心合并
 *
 * 1. 一个 16x128x16 的区块最多有 32768 个方块。逐方块生成 6 个面会产生 196k 个四边形，
 *    即使全部通过面剔除，一个平面地形区块仍然有上万面：顶点带宽、draw call 数量与
 *    JS 侧的对象数量都会失控。
 * 2. 贪心合并把同一平面、同一方块、同一朝向的相邻单位面合并成一个矩形。实测中
 *    16x16 的平面在合并前后是 512 个单位面 → 2 个矩形（上下表面各一），压缩比 256:1；
 *    连同四个侧壁一共 6 个矩形。
 * 3. 合并以**面方向**为单位：+X/-X/+Y/-Y/+Z/-Z 各自独立扫描，因为不同方向的法线、
 *    贴图 tile 与绕序都不同。
 *
 * II. 为什么输出两组（不透明 / 透明）
 *
 * 1. 水、玻璃、树叶必须走半透明渲染队列，并且需要按距离从远到近绘制；不透明组则
 *    依赖深度缓冲，顺序无关。两者混在一个几何体里会导致水面把后面的地形抹掉。
 * 2. 两组各自是完整的 typed array（position/normal/uv/tileRect/index），调用方直接
 *    构造两个 BufferGeometry，而不是"一个方块一个 Mesh"。
 *
 * III. 为什么边界邻居要走世界坐标访问器
 *
 * 1. 区块边缘的那一层面的可见性取决于**相邻区块**的方块。如果只看本区块的数据，
 *    区块接缝处会多出一面"假墙"（内部面被当成外表面）。
 * 2. 因此切片越界时通过传入的 `BlockAccessor` 以世界坐标查询；区块内部则直接读
 *    扁平数组，避免热路径上做坐标换算。
 * 3. 访问器只用于两层切片（每轴 2 层），其余 16 层是零分支的数组拷贝。
 *
 * IV. 关于 UV
 *
 * 1. 贪心合并后一个四边形可能横跨 N 个方块，贴图必须重复 N 次，否则一张 16x16 的
 *    石头贴图会被拉伸到整个 16x16 的平面上。
 * 2. 图集不能开 `RepeatWrapping`（会绕到别的 tile 上去），所以 `uv` 输出的是
 *    "tile 局部重复坐标"（0..宽、0..高），另外用 `tileRect` 属性携带该 tile 在图集中的
 *    内边界矩形，由材质在片元着色器里做 `rect.xy + fract(uv) * (rect.zw - rect.xy)`。
 *    这样既保住了合并带来的压缩，也保住了逐方块重复的贴图。
 *
 * V. 顶点坐标为什么是区块局部坐标
 *
 * float32 在世界坐标 ±100 万处的最小分辨率只有 0.0625 格，会让远处的面出现缝隙。
 * 顶点写在区块局部空间（0..16 / 0..128），再由 Mesh 的 position 承担世界偏移。
 *
 * @module rendering/ChunkMesher
 */

import { BlockId, BLOCK_TYPE_COUNT, isOpaque, isTransparent } from '@/world/BlockRegistry';
import type { Chunk } from '@/world/Chunk';
import {
  CHUNK_SIZE_X,
  CHUNK_SIZE_Y,
  CHUNK_SIZE_Z,
  blockToLocal,
  chunkKey,
  indexInChunk,
  worldToChunkCoord,
} from '@/world/coords';

import type { BlockFace, TileLookup } from './textures/BlockAtlas';

/**
 * 世界坐标方块访问器。
 *
 * 返回原始数值（0..255）而不是 `BlockId`，这样 `Uint8Array` 存储与 worker 传输的
 * 数据可以直接喂进来；越界 id 会被网格构建器按空气处理。
 */
export interface BlockAccessor {
  getBlock(x: number, y: number, z: number): number;
}

/** 一组的几何数据；长度为零表示该组没有可见面。 */
export interface ChunkMeshGroup {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** tile 局部重复坐标：一个方块宽/高对应 1.0。 */
  readonly uvs: Float32Array;
  /** 每个顶点的图集内边界矩形 `(u0, v0, u1, v1)`；材质据此把 uv 映射进图集。 */
  readonly tileRects: Float32Array;
  readonly indices: Uint32Array;
}

export interface MeshGroupStats {
  /** 合并后的矩形数量。 */
  readonly quads: number;
  /** 合并前的单位面数量（= 通过剔除后存活的面数）。 */
  readonly unitFaces: number;
  readonly vertices: number;
  readonly triangles: number;
}

export interface ChunkMeshStats {
  readonly quads: number;
  readonly unitFaces: number;
  readonly vertices: number;
  readonly triangles: number;
  readonly opaque: MeshGroupStats;
  readonly transparent: MeshGroupStats;
}

export interface ChunkMeshData {
  readonly opaque: ChunkMeshGroup;
  readonly transparent: ChunkMeshGroup;
  readonly stats: ChunkMeshStats;
}

/** 一次扫描轴：`d` 是面法线轴，`u`/`v` 是平面内的两个轴。 */
interface SweepAxis {
  readonly d: 0 | 1 | 2;
  readonly u: 0 | 1 | 2;
  readonly v: 0 | 1 | 2;
  readonly sizeD: number;
  readonly sizeU: number;
  readonly sizeV: number;
}

/**
 * 三个扫描轴。
 *
 * `u = (d + 1) % 3`、`v = (d + 2) % 3` 的循环顺序与右手定则一致：
 * 按 `(u0,v0) -> (u0+w,v0) -> (u0+w,v0+h) -> (u0,v0+h)` 排列的四边形，法线恰好是 +d。
 */
const AXES: readonly SweepAxis[] = [
  { d: 0, u: 1, v: 2, sizeD: CHUNK_SIZE_X, sizeU: CHUNK_SIZE_Y, sizeV: CHUNK_SIZE_Z },
  { d: 1, u: 2, v: 0, sizeD: CHUNK_SIZE_Y, sizeU: CHUNK_SIZE_Z, sizeV: CHUNK_SIZE_X },
  { d: 2, u: 0, v: 1, sizeD: CHUNK_SIZE_Z, sizeU: CHUNK_SIZE_X, sizeV: CHUNK_SIZE_Y },
];

/** 扁平区块数组的分量步进：`index = x * 1 + y * 256 + z * 16`。 */
const STRIDES: readonly number[] = [1, CHUNK_SIZE_X * CHUNK_SIZE_Z, CHUNK_SIZE_X];

/** 最大的平面切片单元数（`CHUNK_SIZE_Y * CHUNK_SIZE_Z`）。 */
const MAX_CELLS = CHUNK_SIZE_Y * CHUNK_SIZE_Z;

/** 四边形四个角在 (u, v) 平面上的单位偏移；+d 与 -d 的绕序相反。 */
const QUAD_U_POS: readonly number[] = [0, 1, 1, 0];
const QUAD_V_POS: readonly number[] = [0, 0, 1, 1];
const QUAD_U_NEG: readonly number[] = [0, 0, 1, 1];
const QUAD_V_NEG: readonly number[] = [0, 1, 1, 0];

/** 顶点分量临时缓冲；单线程热路径复用，避免每个角分配数组。 */
const SCRATCH_COMPONENT: number[] = [0, 0, 0];

const INITIAL_VERTEX_CAPACITY = 2048;

/**
 * 可增长的顶点缓冲。
 *
 * 内部数组跨区块重建复用（容量只增不减），只有在 `finish()` 时才 slice 出精确长度的
 * 副本交给 BufferGeometry —— 那一次分配是必须的，因为几何体要长期持有这些数组。
 */
class MeshBuffer {
  #positions = new Float32Array(INITIAL_VERTEX_CAPACITY * 3);
  #normals = new Float32Array(INITIAL_VERTEX_CAPACITY * 3);
  #uvs = new Float32Array(INITIAL_VERTEX_CAPACITY * 2);
  #tileRects = new Float32Array(INITIAL_VERTEX_CAPACITY * 4);
  #indices = new Uint32Array(INITIAL_VERTEX_CAPACITY * 6);

  #vertexCount = 0;
  #indexCount = 0;
  #quadCount = 0;
  #unitFaces = 0;

  public reset(): void {
    this.#vertexCount = 0;
    this.#indexCount = 0;
    this.#quadCount = 0;
    this.#unitFaces = 0;
  }

  public get vertexCount(): number {
    return this.#vertexCount;
  }

  /** 追加一个顶点，返回它的序号。 */
  public addVertex(
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    rect: { readonly u0: number; readonly v0: number; readonly u1: number; readonly v1: number },
  ): number {
    const index = this.#vertexCount;
    this.#ensureVertexCapacity(index + 1);

    const p = index * 3;
    this.#positions[p] = px;
    this.#positions[p + 1] = py;
    this.#positions[p + 2] = pz;
    this.#normals[p] = nx;
    this.#normals[p + 1] = ny;
    this.#normals[p + 2] = nz;

    const t = index * 2;
    this.#uvs[t] = u;
    this.#uvs[t + 1] = v;

    const r = index * 4;
    this.#tileRects[r] = rect.u0;
    this.#tileRects[r + 1] = rect.v0;
    this.#tileRects[r + 2] = rect.u1;
    this.#tileRects[r + 3] = rect.v1;

    this.#vertexCount = index + 1;
    return index;
  }

  public addIndex(index: number): void {
    this.#ensureIndexCapacity(this.#indexCount + 1);
    this.#indices[this.#indexCount] = index;
    this.#indexCount += 1;
  }

  /** 记录一个矩形的统计信息（`width * height` 是它覆盖的单位面数）。 */
  public addQuadStats(width: number, height: number): void {
    this.#quadCount += 1;
    this.#unitFaces += width * height;
  }

  /** 取出精确长度的数组副本。 */
  public finish(): ChunkMeshGroup {
    return {
      positions: this.#positions.slice(0, this.#vertexCount * 3),
      normals: this.#normals.slice(0, this.#vertexCount * 3),
      uvs: this.#uvs.slice(0, this.#vertexCount * 2),
      tileRects: this.#tileRects.slice(0, this.#vertexCount * 4),
      indices: this.#indices.slice(0, this.#indexCount),
    };
  }

  public stats(): MeshGroupStats {
    return {
      quads: this.#quadCount,
      unitFaces: this.#unitFaces,
      vertices: this.#vertexCount,
      triangles: this.#indexCount / 3,
    };
  }

  #ensureVertexCapacity(required: number): void {
    if (required <= this.#positions.length / 3) {
      return;
    }
    let capacity = Math.max(INITIAL_VERTEX_CAPACITY, this.#positions.length / 3);
    while (capacity < required) {
      capacity *= 2;
    }
    const positions = new Float32Array(capacity * 3);
    positions.set(this.#positions);
    this.#positions = positions;

    const normals = new Float32Array(capacity * 3);
    normals.set(this.#normals);
    this.#normals = normals;

    const uvs = new Float32Array(capacity * 2);
    uvs.set(this.#uvs);
    this.#uvs = uvs;

    const tileRects = new Float32Array(capacity * 4);
    tileRects.set(this.#tileRects);
    this.#tileRects = tileRects;
  }

  #ensureIndexCapacity(required: number): void {
    if (required <= this.#indices.length) {
      return;
    }
    let capacity = Math.max(INITIAL_VERTEX_CAPACITY * 6, this.#indices.length);
    while (capacity < required) {
      capacity *= 2;
    }
    const indices = new Uint32Array(capacity);
    indices.set(this.#indices);
    this.#indices = indices;
  }
}

/** 邻居是否完全遮住本面。 */
function hidesFace(ownId: BlockId, neighbourId: BlockId): boolean {
  if (isOpaque(neighbourId)) {
    return true;
  }
  // 同种透明方块之间的内部面（水水之间、玻璃玻璃之间）必须剔除，否则透明组的
  // 三角形数量会翻好几倍，排序开销也随之翻倍。
  return ownId === neighbourId && isTransparent(ownId);
}

/** 一行 `width` 个单元是否都等于 `value`，供贪心合并沿 v 轴扩展。 */
function rowMatches(mask: Int32Array, start: number, width: number, value: number): boolean {
  for (let i = 0; i < width; i += 1) {
    if (mask[start + i] !== value) {
      return false;
    }
  }
  return true;
}

export class ChunkMesher {
  readonly #lookup: TileLookup;

  /** 相邻两层切片的方块 id。 */
  readonly #sliceA = new Uint8Array(MAX_CELLS);
  readonly #sliceB = new Uint8Array(MAX_CELLS);
  /** 朝 +d 与朝 -d 的候选面；0 表示没有面，其余存方块 id。 */
  readonly #maskPos = new Int32Array(MAX_CELLS);
  readonly #maskNeg = new Int32Array(MAX_CELLS);

  readonly #opaque = new MeshBuffer();
  readonly #transparent = new MeshBuffer();

  public constructor(lookup: TileLookup) {
    this.#lookup = lookup;
  }

  /**
   * 构建一个区块的网格数据。
   *
   * @param chunk - 区块数据（只读使用，不会修改方块）。
   * @param accessor - 世界坐标方块访问器，用于跨区块边界的面剔除。
   * @returns 不透明组、透明组与统计信息。
   */
  public mesh(chunk: Chunk, accessor: BlockAccessor): ChunkMeshData {
    this.#opaque.reset();
    this.#transparent.reset();

    // 世界坐标原点：只有越界切片才需要它做坐标换算。
    const originX = chunk.cx * CHUNK_SIZE_X;
    const originZ = chunk.cz * CHUNK_SIZE_Z;

    for (const axis of AXES) {
      this.#sweepAxis(chunk, accessor, axis, originX, originZ);
    }

    return {
      opaque: this.#opaque.finish(),
      transparent: this.#transparent.finish(),
      stats: {
        quads: this.#opaque.stats().quads + this.#transparent.stats().quads,
        unitFaces: this.#opaque.stats().unitFaces + this.#transparent.stats().unitFaces,
        vertices: this.#opaque.stats().vertices + this.#transparent.stats().vertices,
        triangles: this.#opaque.stats().triangles + this.#transparent.stats().triangles,
        opaque: this.#opaque.stats(),
        transparent: this.#transparent.stats(),
      },
    };
  }

  /**
   * 沿一个轴扫描所有平面。
   *
   * I. 平面编号 p 的含义
   *
   * 1. 平面 p 位于局部坐标 p 与 p+1 之间；`p = -1` 与 `p = sizeD - 1` 是区块的两个边界面。
   * 2. 平面上的面分两种：位于切片 p 的方块朝 +d 的面，以及位于切片 p+1 的方块朝 -d 的面。
   * 3. 只有"拥有该方块"的区块才输出它：p 落在区块内才输出 +d 面，p+1 落在区块内才输出
   *    -d 面。否则相邻区块会重复输出同一个世界平面上的面。
   *
   * II. 为什么按最高非空气方块裁剪扫描范围
   *
   * 1. 世界高度是 128 格，地表通常到不了 90；`highestNonAir` 以上全是空气，不可能产生
   *    任何面（面必须属于一个非空气方块）。把三个轴的扫描范围裁到它，可以省下 30%-50%
   *    的空转，而且不改变任何输出。
   * 2. 邻居更高也不会漏面：那一侧的面归邻居区块输出。
   */
  #sweepAxis(
    chunk: Chunk,
    accessor: BlockAccessor,
    axis: SweepAxis,
    originX: number,
    originZ: number,
  ): void {
    // top 是"最高的非空气方块 + 1"，空区块为 0。
    const top = Math.max(0, Math.min(CHUNK_SIZE_Y, chunk.highestNonAir + 1));
    if (top <= 0) {
      return;
    }

    // Y 轴在哪个分量上出现，就把那一个分量裁到 top。
    const sizeD = axis.d === 1 ? Math.min(axis.sizeD, top) : axis.sizeD;
    const sizeU = axis.u === 1 ? Math.min(axis.sizeU, top) : axis.sizeU;
    const sizeV = axis.v === 1 ? Math.min(axis.sizeV, top) : axis.sizeV;

    for (let p = -1; p < sizeD; p += 1) {
      // 两层切片始终都要读：p = -1 时 A 在邻居区块里，但正是它决定 B 的 -d 面是否可见。
      this.#fillSlice(this.#sliceA, axis, p, sizeU, sizeV, chunk, accessor, originX, originZ);
      this.#fillSlice(this.#sliceB, axis, p + 1, sizeU, sizeV, chunk, accessor, originX, originZ);

      const ownsPositive = p >= 0;
      const ownsNegative = p + 1 < axis.sizeD;

      // 1. 构建掩码：只做剔除判定，不合并。
      for (let iv = 0; iv < sizeV; iv += 1) {
        for (let iu = 0; iu < sizeU; iu += 1) {
          const k = iv * sizeU + iu;
          const idA = this.#sliceA[k] ?? 0;
          const idB = this.#sliceB[k] ?? 0;
          this.#maskPos[k] =
            ownsPositive && idA !== BlockId.Air && !hidesFace(idA as BlockId, idB as BlockId)
              ? idA
              : 0;
          this.#maskNeg[k] =
            ownsNegative && idB !== BlockId.Air && !hidesFace(idB as BlockId, idA as BlockId)
              ? idB
              : 0;
        }
      }

      // 2. 两个方向分别贪心合并。planeD 是面所在的世界平面（局部坐标）。
      if (ownsPositive) {
        this.#emitMask(this.#maskPos, true, axis, p + 1, sizeU, sizeV);
      }
      if (ownsNegative) {
        this.#emitMask(this.#maskNeg, false, axis, p + 1, sizeU, sizeV);
      }
    }
  }

  /**
   * 把一层切片读进缓冲。
   *
   * 快路径（切片在区块内）直接按步进读扁平数组，没有任何分支；慢路径只在每轴两层
   * 边界切片上触发，改走世界坐标访问器，从而正确处理跨区块的面剔除。
   */
  #fillSlice(
    target: Uint8Array,
    axis: SweepAxis,
    localD: number,
    sizeU: number,
    sizeV: number,
    chunk: Chunk,
    accessor: BlockAccessor,
    originX: number,
    originZ: number,
  ): void {
    const strideD = STRIDES[axis.d] ?? 1;
    const strideU = STRIDES[axis.u] ?? 1;
    const strideV = STRIDES[axis.v] ?? 1;

    if (localD >= 0 && localD < axis.sizeD) {
      const base = localD * strideD;
      for (let iv = 0; iv < sizeV; iv += 1) {
        const source = base + iv * strideV;
        const destination = iv * sizeU;
        for (let iu = 0; iu < sizeU; iu += 1) {
          target[destination + iu] = chunk.blocks[source + iu * strideU] ?? 0;
        }
      }
      return;
    }

    const component = SCRATCH_COMPONENT;
    component[axis.d] = localD;
    for (let iv = 0; iv < sizeV; iv += 1) {
      component[axis.v] = iv;
      for (let iu = 0; iu < sizeU; iu += 1) {
        component[axis.u] = iu;
        const raw = accessor.getBlock(
          originX + (component[0] ?? 0),
          component[1] ?? 0,
          originZ + (component[2] ?? 0),
        );
        // 越界 id（存档损坏或版本升级）按空气处理：宁可少画一面，也不要抛异常。
        target[iv * sizeU + iu] = raw > 0 && raw < BLOCK_TYPE_COUNT ? raw : 0;
      }
    }
  }

  /**
   * 对一个方向的掩码做贪心合并。
   *
   * 算法：逐格扫描，遇到第一个未消费的单元就沿 u 轴扩展出最大宽度，再沿 v 轴扩展
   * 高度（要求整行逐格相同），然后把矩形内的单元清零，保证每个单元只输出一次。
   */
  #emitMask(
    mask: Int32Array,
    positive: boolean,
    axis: SweepAxis,
    planeD: number,
    sizeU: number,
    sizeV: number,
  ): void {
    for (let iv = 0; iv < sizeV; iv += 1) {
      for (let iu = 0; iu < sizeU; iu += 1) {
        const k = iv * sizeU + iu;
        const value = mask[k] ?? 0;
        if (value === 0) {
          continue;
        }

        // 1. 沿 u 轴扩展宽度。
        let width = 1;
        while (iu + width < sizeU && mask[k + width] === value) {
          width += 1;
        }

        // 2. 沿 v 轴扩展高度。
        let height = 1;
        while (iv + height < sizeV && rowMatches(mask, k + height * sizeU, width, value)) {
          height += 1;
        }

        // 3. 消费矩形内的所有单元。
        for (let dy = 0; dy < height; dy += 1) {
          const rowStart = k + dy * sizeU;
          for (let dx = 0; dx < width; dx += 1) {
            mask[rowStart + dx] = 0;
          }
        }

        // 4. 输出四边形。
        const blockId = value as BlockId;
        const buffer = isTransparent(blockId) ? this.#transparent : this.#opaque;
        this.#emitQuad(buffer, blockId, positive, axis, planeD, iu, iv, width, height);
      }
    }
  }

  /**
   * 输出一个矩形对应的四边形。
   *
   * 顶点顺序按 `(u0,v0) -> (u0+w,v0) -> (u0+w,v0+h) -> (u0,v0+h)` 排列时法线为 +d；
   * 朝 -d 的面把顺序整体反过来，从而保证两组面的绕序都是逆时针（正面朝外）。
   */
  #emitQuad(
    buffer: MeshBuffer,
    blockId: BlockId,
    positive: boolean,
    axis: SweepAxis,
    planeD: number,
    u0: number,
    v0: number,
    width: number,
    height: number,
  ): void {
    const face: BlockFace = axis.d === 1 ? (positive ? 'top' : 'bottom') : 'side';
    const rect = this.#lookup.tileUV(blockId, face);

    const sign = positive ? 1 : -1;
    const nx = axis.d === 0 ? sign : 0;
    const ny = axis.d === 1 ? sign : 0;
    const nz = axis.d === 2 ? sign : 0;

    const component = SCRATCH_COMPONENT;
    component[axis.d] = planeD;

    const base = buffer.vertexCount;
    for (let corner = 0; corner < 4; corner += 1) {
      const du = (positive ? (QUAD_U_POS[corner] ?? 0) : (QUAD_U_NEG[corner] ?? 0)) * width;
      const dv = (positive ? (QUAD_V_POS[corner] ?? 0) : (QUAD_V_NEG[corner] ?? 0)) * height;
      component[axis.u] = u0 + du;
      component[axis.v] = v0 + dv;

      // uv 是 tile 局部重复坐标：一格 = 1.0，四边形越宽重复次数越多。
      buffer.addVertex(
        component[0] ?? 0,
        component[1] ?? 0,
        component[2] ?? 0,
        nx,
        ny,
        nz,
        du,
        dv,
        rect,
      );
    }

    buffer.addIndex(base);
    buffer.addIndex(base + 1);
    buffer.addIndex(base + 2);
    buffer.addIndex(base);
    buffer.addIndex(base + 2);
    buffer.addIndex(base + 3);
    buffer.addQuadStats(width, height);
  }
}

/**
 * 用一组区块构造世界坐标访问器。
 *
 * 语义与 `World.getBlock` 保持一致，供单测与集成测试使用：
 *
 * 1. 区块未加载 → 空气。
 * 2. `y < 0` → 基岩（因此世界最底层的底面会被自动剔除，玩家也不会从底部掉出去）。
 * 3. `y > 127` → 空气。
 *
 * @param chunks - 以 {@link chunkKey} 为键的区块表。
 */
export function createChunkMapAccessor(chunks: ReadonlyMap<number, Chunk>): BlockAccessor {
  return {
    getBlock: (x: number, y: number, z: number): number => {
      const cx = worldToChunkCoord(x, CHUNK_SIZE_X);
      const cz = worldToChunkCoord(z, CHUNK_SIZE_Z);
      const chunk = chunks.get(chunkKey(cx, cz));
      if (chunk === undefined) {
        return BlockId.Air;
      }
      if (y < 0) {
        return BlockId.Bedrock;
      }
      if (y >= CHUNK_SIZE_Y) {
        return BlockId.Air;
      }
      const { lx, lz } = blockToLocal(x, z);
      return chunk.blocks[indexInChunk(lx, y, lz)] ?? BlockId.Air;
    },
  };
}
