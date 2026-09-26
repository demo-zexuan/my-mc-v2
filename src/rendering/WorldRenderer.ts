/**
 * 区块流式渲染：网格生命周期、每帧预算、视锥剔除与透明排序。
 *
 * I. 职责边界
 *
 * 1. 监听 `World` 的区块集合，把"脏"区块转成网格；区块被卸载时释放几何体。
 * 2. 每帧最多重建 `rebuildBudget` 个区块（默认 2）。一次把几十个区块全部重建会让
 *    帧时间出现几百毫秒的尖峰，玩家看到的就是"走路一顿一顿"。
 * 3. 视锥剔除与透明排序都在这里做，`World` 与 `ChunkMesher` 都不需要认识相机。
 *
 * II. 为什么必须等四个水平邻居都加载完才建网格
 *
 * 1. 区块边缘的面是否可见取决于邻居的方块。邻居还没加载时按空气处理，边界会被当成
 *    外表面，于是出现"整整齐齐一堵墙"的假墙。
 * 2. 因此区块只有在 (cx±1, cz) 与 (cx, cz±1) 都存在时才允许建网格；否则保留旧网格
 *    并记入 `deferred`，等邻居到齐后自然会被重建。
 * 3. `ChunkMesher` 依然通过世界坐标访问器读邻居，所以"邻居已加载"只是调度前提，
 *    真正决定面是否生成的是邻居的真实方块。
 *
 * III. 为什么要重建整个 BufferGeometry 而不是原地换 attribute
 *
 * 1. Three.js 只在 `geometry.dispose()` 时释放属性对应的 GL buffer；单纯替换
 *    `geometry.attributes.x` 会让旧 buffer 永远留在显存里（WebGLAttributes 用
 *    WeakMap 缓存，属性对象被 GC 并不会触发 deleteBuffer）。
 * 2. 区块重建本来就要重新上传全部顶点，所以"dispose 旧几何体 + 新建"不会带来额外
 *    的上传量，却彻底避免了显存泄漏。
 *
 * @module rendering/WorldRenderer
 */

import * as THREE from 'three';

import type { Chunk } from '@/world/Chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z, chunkKey } from '@/world/coords';

import { ChunkMesher } from './ChunkMesher';
import type { BlockAccessor, ChunkMeshGroup } from './ChunkMesher';
import { BlockAtlas } from './textures/BlockAtlas';
import type { TileLookup } from './textures/BlockAtlas';

/** 网格构建所需的最小世界接口；`World` 天然满足它。 */
export interface VoxelChunkSource extends BlockAccessor {
  readonly chunks: IterableIterator<Chunk>;
  getChunk(cx: number, cz: number): Chunk | undefined;
}

/** 不透明组与透明组各自的材质。 */
export interface ChunkMaterials {
  readonly opaque: THREE.Material;
  readonly transparent: THREE.Material;
}

export interface ChunkMaterialOptions {
  /** 是否接收平行光与半球光；默认 true。 */
  readonly lit?: boolean;
}

export interface WorldRendererOptions {
  /** 每帧最多重建的区块数。默认 2。 */
  readonly rebuildBudget?: number;
  /** 区块材质使用的图集；缺省时按默认参数新建一张（需要 DOM canvas）。 */
  readonly atlas?: BlockAtlas;
  /** 直接注入材质（测试用，避免触碰 canvas / GPU）。 */
  readonly materials?: ChunkMaterials;
  /** tile UV 查询表；缺省时使用 `atlas`。测试可注入假的 UV 表。 */
  readonly tileLookup?: TileLookup;
  /** 区块是否投射阴影；默认 true，仅不透明组生效。 */
  readonly castShadow?: boolean;
  /** 区块是否接收阴影；默认 true。 */
  readonly receiveShadow?: boolean;
}

export interface WorldRendererStats {
  /** 已建立网格的区块数。 */
  readonly chunks: number;
  /** 通过视锥剔除、当前可见的区块数。 */
  readonly visible: number;
  /** 当前存在的矩形面总数（不透明 + 透明）。 */
  readonly quads: number;
  /** 本帧实际重建的区块数。 */
  readonly rebuilds: number;
  /** 因邻居缺失而推迟重建的区块数。 */
  readonly deferred: number;
}

/** 顶点着色器补丁：声明逐顶点的图集矩形属性。 */
const TILE_RECT_ATTRIBUTE = 'attribute vec4 tileRect;';
const TILE_RECT_VARYING = 'varying vec4 vTileRect;';

/**
 * 片元着色器补丁：把"tile 局部重复坐标"折回图集内边界矩形。
 *
 * I. 为什么在着色器里做，而不是在 CPU 上把 UV 展开
 *
 * 1. 贪心合并后一个四边形横跨 N 个方块，UV 必须在图集内重复 N 次。
 * 2. 在 CPU 上把 UV 直接写成图集坐标会跨越到邻居 tile（图集不能开 RepeatWrapping）；
 *    而按格拆成 N 个四边形就等于放弃合并。
 * 3. `fract` 后的 UV 落在 `tileRect` 内，padding 永远参与不到采样，接缝不会渗色。
 *
 * II. 为什么采样必须用 `textureGrad` 而不是 `texture2D`（真实缺陷的根因）
 *
 * 1. `fract()` 在每个整数 UV 边界上不连续。若把 `atlasUv` 交给 `texture2D`，硬件会对
 *    **折叠后**的坐标做屏幕空间求导：在缝上 `dFdx/dFdy` 趋于无穷，mip 级别被选到最粗的
 *    一级；而最粗的一级已经把整张图集平均成一个颜色（石块 + 沙子 + 草地的混合色）。
 * 2. 表现就是：每个方块边界上出现一条 1 像素宽的"邻居颜色"亮线。水面是整片大矩形，
 *    于是海上出现密集横纹；沙地出现规则的点阵/虚线；远处 mip 越粗越明显——这正是
 *    "水面横向条纹"的真实成因，与共面深度冲突（z-fighting）无关。
 * 3. 用折叠前的 uv 求导就能得到处处连续的解析导数：`atlasUv` 相对 `vMapUv` 的缩放
 *    恰好是 tile 在 UV 空间中的尺寸（`tileRect.zw - tileRect.xy`），所以
 *    `dFdx(atlasUv) === dFdx(vMapUv) * tileSize`，mip 级别从此正确。
 * 4. Three.js r163 起所有内建材质都会被编译成 GLSL 3.00（见 `WebGLProgram` 的
 *    `#version 300 es` 转换），`textureGrad` / `dFdx` 都是核心函数，无需扩展。
 */
const MAP_FRAGMENT_PATCH = /* glsl */ `#ifdef USE_MAP

	vec2 atlasTileSize = vTileRect.zw - vTileRect.xy;
	vec2 atlasUv = vTileRect.xy + fract( vMapUv ) * atlasTileSize;
	vec4 sampledDiffuseColor = textureGrad(
		map,
		atlasUv,
		dFdx( vMapUv ) * atlasTileSize,
		dFdy( vMapUv ) * atlasTileSize
	);
	diffuseColor *= sampledDiffuseColor;

#endif
`;

/** `onBeforeCompile` 能拿到的最小着色器视图，便于单测直接断言补丁结果。 */
export interface ShaderPatchTarget {
  vertexShader: string;
  fragmentShader: string;
}

/**
 * 给标准材质注入 `tileRect` 属性与图集 UV 折叠。
 *
 * 之所以修改内建材质而不是自己写 ShaderMaterial：区块需要接收平行光、半球光与阴影，
 * 重新实现一遍 PBR/Lambert 光照只会让阴影与雾效出现细微偏差。
 *
 * @param shader - Three.js 传入的着色器参数对象（就地修改）。
 */
export function patchAtlasUvShader(shader: ShaderPatchTarget): void {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${TILE_RECT_ATTRIBUTE}\n${TILE_RECT_VARYING}`)
    .replace('#include <uv_vertex>', `#include <uv_vertex>\n\tvTileRect = tileRect;`);

  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${TILE_RECT_VARYING}`)
    .replace('#include <map_fragment>', MAP_FRAGMENT_PATCH);
}

/**
 * 依据图集创建区块材质。
 *
 * 1. 不透明组：单面渲染，写入深度，投射阴影。
 * 2. 透明组：双面渲染（水下能看到水面）、不写深度（由排序保证结果）、`alphaTest`
 *    丢弃树叶镂空像素，且不投射阴影——水面投影会把整片水域变成黑块。
 */
export function createChunkMaterials(
  atlas: BlockAtlas,
  options: ChunkMaterialOptions = {},
): ChunkMaterials {
  const lit = options.lit ?? true;

  const opaque = new THREE.MeshLambertMaterial({
    map: atlas.texture,
    side: THREE.FrontSide,
    fog: lit,
  });
  opaque.name = 'chunk:opaque';

  const transparent = new THREE.MeshLambertMaterial({
    map: atlas.texture,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    alphaTest: 0.02,
    fog: lit,
  });
  transparent.name = 'chunk:transparent';

  for (const material of [opaque, transparent]) {
    material.onBeforeCompile = (shader): void => {
      patchAtlasUvShader(shader);
    };
    // 注入过的着色器必须与普通 Lambert 分开缓存，否则会命中错误程序。
    material.customProgramCacheKey = (): string => 'chunk-atlas-uv';
  }

  return { opaque, transparent };
}

interface ChunkRecord {
  readonly cx: number;
  readonly cz: number;
  readonly bounds: THREE.Box3;
  opaque: THREE.Mesh | null;
  transparent: THREE.Mesh | null;
  quads: number;
  vertices: number;
}

const DEFAULT_REBUILD_BUDGET = 2;

export class WorldRenderer {
  /** 所有区块 Mesh 的父节点；调用方把它放进场景即可。 */
  public readonly group: THREE.Group;

  readonly #records = new Map<number, ChunkRecord>();
  readonly #mesher: ChunkMesher;

  readonly #materials: ChunkMaterials;
  /** 材质是否由本类创建（注入的材质不由本类释放）。 */
  readonly #ownsMaterials: boolean;
  #atlas: BlockAtlas | null = null;

  readonly #rebuildBudget: number;
  readonly #castShadow: boolean;
  readonly #receiveShadow: boolean;

  // --- 每帧复用的 scratch，避免在 update 里分配大数组 ---
  readonly #frustum = new THREE.Frustum();
  readonly #projectionView = new THREE.Matrix4();
  readonly #eye = new THREE.Vector3();
  readonly #dirty: Chunk[] = [];
  readonly #visibleTransparent: ChunkRecord[] = [];
  readonly #compareNearFirst: (a: Chunk, b: Chunk) => number;
  readonly #compareFarFirst: (a: ChunkRecord, b: ChunkRecord) => number;

  #rebuildsThisFrame = 0;
  #deferred = 0;

  public constructor(scene: THREE.Scene, options: WorldRendererOptions = {}) {
    this.#rebuildBudget = Math.max(1, Math.floor(options.rebuildBudget ?? DEFAULT_REBUILD_BUDGET));
    this.#castShadow = options.castShadow ?? true;
    this.#receiveShadow = options.receiveShadow ?? true;

    if (options.materials !== undefined) {
      this.#materials = options.materials;
      this.#ownsMaterials = false;
      this.#atlas = options.atlas ?? null;
    } else {
      const atlas = options.atlas ?? new BlockAtlas();
      this.#atlas = atlas;
      this.#materials = createChunkMaterials(atlas);
      this.#ownsMaterials = true;
    }

    const lookup = options.tileLookup ?? this.#atlas;
    if (lookup === null) {
      throw new Error('WorldRenderer requires either an atlas or a tileLookup.');
    }
    this.#mesher = new ChunkMesher(lookup);

    this.group = new THREE.Group();
    this.group.name = 'world-chunks';
    scene.add(this.group);

    // 比较器只创建一次：每帧排序时读取当前相机位置，避免逐帧生成闭包。
    const distanceSquared = (cx: number, cz: number): number => {
      const dx = cx * CHUNK_SIZE_X + CHUNK_SIZE_X / 2 - this.#eye.x;
      const dz = cz * CHUNK_SIZE_Z + CHUNK_SIZE_Z / 2 - this.#eye.z;
      return dx * dx + dz * dz;
    };
    this.#compareNearFirst = (a, b): number =>
      distanceSquared(a.cx, a.cz) - distanceSquared(b.cx, b.cz);
    this.#compareFarFirst = (a, b): number =>
      distanceSquared(b.cx, b.cz) - distanceSquared(a.cx, a.cz);
  }

  /** 当前统计信息；调试面板与测试都读它。 */
  public stats(): WorldRendererStats {
    let visible = 0;
    let quads = 0;
    for (const record of this.#records.values()) {
      if (record.opaque?.visible === true || record.transparent?.visible === true) {
        visible += 1;
      }
      quads += record.quads;
    }
    return {
      chunks: this.#records.size,
      visible,
      quads,
      rebuilds: this.#rebuildsThisFrame,
      deferred: this.#deferred,
    };
  }

  /**
   * 推进一帧：卸载过期的网格、按预算重建脏区块、更新可见性与透明排序。
   *
   * @param source - 世界数据源（通常是 `World`）。
   * @param camera - 用于视锥剔除与透明排序的相机。
   */
  public update(source: VoxelChunkSource, camera: THREE.Camera): void {
    // 相机矩阵必须先刷新：投影矩阵与 matrixWorldInverse 决定了剔除结果。
    camera.updateMatrixWorld();
    this.#eye.setFromMatrixPosition(camera.matrixWorld);

    this.#releaseUnloaded(source);

    // I. 收集需要重建的区块。
    // 1. 没有网格的区块要建，`meshDirty` 的区块要重建。
    // 2. 邻居不全的区块推迟，避免出现假墙。
    const dirty = this.#dirty;
    dirty.length = 0;
    this.#deferred = 0;
    for (const chunk of source.chunks) {
      const record = this.#records.get(chunkKey(chunk.cx, chunk.cz));
      if (record !== undefined && !chunk.meshDirty) {
        continue;
      }
      if (!this.#neighboursReady(source, chunk.cx, chunk.cz)) {
        this.#deferred += 1;
        continue;
      }
      dirty.push(chunk);
    }

    // II. 近处优先：玩家脚下的地形先成型，远山可以晚几帧。
    if (dirty.length > 1) {
      dirty.sort(this.#compareNearFirst);
    }

    const budget = Math.min(this.#rebuildBudget, dirty.length);
    for (let i = 0; i < budget; i += 1) {
      const chunk = dirty[i];
      if (chunk !== undefined) {
        this.#rebuild(chunk, source);
      }
    }
    this.#rebuildsThisFrame = budget;

    // III. 视锥剔除 + 透明排序。
    this.#updateVisibility(camera);
  }

  /** 释放所有几何体与自建材质，并把父节点移出场景。 */
  public dispose(): void {
    for (const record of this.#records.values()) {
      this.#disposeRecord(record);
    }
    this.#records.clear();
    this.group.removeFromParent();
    this.group.clear();

    if (this.#ownsMaterials) {
      this.#materials.opaque.dispose();
      this.#materials.transparent.dispose();
      this.#atlas?.dispose();
    }
    this.#atlas = null;
  }

  /**
   * 重建一个区块的网格。
   *
   * 统计信息与包围盒一起更新：包围盒只依赖区块坐标与最高非空气方块，不需要遍历顶点。
   */
  #rebuild(chunk: Chunk, source: VoxelChunkSource): void {
    const key = chunkKey(chunk.cx, chunk.cz);
    const data = this.#mesher.mesh(chunk, source);

    let record = this.#records.get(key);
    if (record === undefined) {
      record = {
        cx: chunk.cx,
        cz: chunk.cz,
        bounds: new THREE.Box3(),
        opaque: null,
        transparent: null,
        quads: 0,
        vertices: 0,
      };
      this.#records.set(key, record);
    }

    this.#applyGroup(record, 'opaque', data.opaque);
    this.#applyGroup(record, 'transparent', data.transparent);

    const originX = chunk.cx * CHUNK_SIZE_X;
    const originZ = chunk.cz * CHUNK_SIZE_Z;
    // 空区块的包围盒退化成一层薄片，仍然是一个合法的 AABB，视锥剔除会把它筛掉。
    const top = Math.min(CHUNK_SIZE_Y, Math.max(1, chunk.highestNonAir + 1));
    record.bounds.min.set(originX, 0, originZ);
    record.bounds.max.set(originX + CHUNK_SIZE_X, top, originZ + CHUNK_SIZE_Z);
    record.quads = data.stats.quads;
    record.vertices = data.stats.vertices;

    // 只有真正建完网格才清脏标记：中途抛错或邻居丢失都不会丢掉重建机会。
    chunk.markMeshClean();
  }

  /** 用一个组的 typed array 替换对应的 Mesh（空组则移除 Mesh）。 */
  #applyGroup(record: ChunkRecord, which: 'opaque' | 'transparent', group: ChunkMeshGroup): void {
    const existing = which === 'opaque' ? record.opaque : record.transparent;

    if (group.indices.length === 0) {
      if (existing !== null) {
        existing.removeFromParent();
        existing.geometry.dispose();
        if (which === 'opaque') {
          record.opaque = null;
        } else {
          record.transparent = null;
        }
      }
      return;
    }

    const originX = record.cx * CHUNK_SIZE_X;
    const originZ = record.cz * CHUNK_SIZE_Z;

    let mesh = existing;
    if (mesh === null) {
      mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.#materials[which]);
      mesh.name = `chunk:${record.cx},${record.cz}:${which}`;
      mesh.position.set(originX, 0, originZ);
      // 视锥剔除由本类用区块包围盒统一完成，关闭 Three.js 自身的包围球剔除，
      // 免得它为了几千个顶点再算一遍包围球。
      mesh.frustumCulled = false;
      mesh.castShadow = which === 'opaque' && this.#castShadow;
      mesh.receiveShadow = this.#receiveShadow;
      if (which === 'transparent') {
        mesh.renderOrder = 1;
      }
      this.group.add(mesh);
      if (which === 'opaque') {
        record.opaque = mesh;
      } else {
        record.transparent = mesh;
      }
    } else {
      // 见模块头 III：旧几何体必须先 dispose 才能释放属性对应的 GL buffer。
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BufferGeometry();
    }

    const geometry = mesh.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(group.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(group.normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(group.uvs, 2));
    geometry.setAttribute('tileRect', new THREE.BufferAttribute(group.tileRects, 4));
    geometry.setIndex(new THREE.BufferAttribute(group.indices, 1));
  }

  /** 释放已经被 `World` 卸载的区块。 */
  #releaseUnloaded(source: VoxelChunkSource): void {
    for (const [key, record] of this.#records) {
      if (source.getChunk(record.cx, record.cz) !== undefined) {
        continue;
      }
      this.#disposeRecord(record);
      this.#records.delete(key);
    }
  }

  #disposeRecord(record: ChunkRecord): void {
    for (const mesh of [record.opaque, record.transparent]) {
      if (mesh === null) {
        continue;
      }
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    record.opaque = null;
    record.transparent = null;
  }

  /** 四个水平邻居是否都已加载。 */
  #neighboursReady(source: VoxelChunkSource, cx: number, cz: number): boolean {
    return (
      source.getChunk(cx - 1, cz) !== undefined &&
      source.getChunk(cx + 1, cz) !== undefined &&
      source.getChunk(cx, cz - 1) !== undefined &&
      source.getChunk(cx, cz + 1) !== undefined
    );
  }

  /**
   * 用区块包围盒做视锥剔除，并把透明组按"由远及近"排序。
   *
   * 排序用 `renderOrder`：Three.js 对透明物体的默认排序依据是物体原点的深度，而区块
   * 原点是它的最小角，离相机最近的角并不代表整块网格的距离，因此用区块中心的距离
   * 覆盖它更接近画家算法想要的结果。
   */
  #updateVisibility(camera: THREE.Camera): void {
    this.#projectionView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.#frustum.setFromProjectionMatrix(this.#projectionView);

    const transparent = this.#visibleTransparent;
    transparent.length = 0;

    for (const record of this.#records.values()) {
      const visible = this.#frustum.intersectsBox(record.bounds);
      if (record.opaque !== null) {
        record.opaque.visible = visible;
      }
      if (record.transparent !== null) {
        record.transparent.visible = visible;
        if (visible) {
          transparent.push(record);
        }
      }
    }

    if (transparent.length > 1) {
      transparent.sort(this.#compareFarFirst);
    }
    for (let i = 0; i < transparent.length; i += 1) {
      const mesh = transparent[i]?.transparent;
      if (mesh !== null && mesh !== undefined) {
        mesh.renderOrder = i;
      }
    }
  }
}
