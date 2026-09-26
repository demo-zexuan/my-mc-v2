// @vitest-environment jsdom
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { BlockId } from '@/world/BlockRegistry';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, WORLD_MAX_Y } from '@/world/coords';
import { World } from '@/world/World';
import { ChunkMesher } from '@/rendering/ChunkMesher';
import { BlockAtlas } from '@/rendering/textures/BlockAtlas';
import { WorldRenderer } from '@/rendering/WorldRenderer';
import type { BiomeId, ChunkDataTarget, TerrainGenerator } from '@/terrain/types';

import { installCanvas2DStub } from '../../unit/rendering/canvasStub';

/**
 * 区块流式渲染的集成测试。
 *
 * I. 覆盖的真实路径
 *
 * 1. `World`（真实区块存储与脏标记）+ `BlockAtlas`（真实画布图集）+ `ChunkMesher`
 *    + `WorldRenderer` + `THREE.BufferGeometry` 的完整链路。
 * 2. 每帧预算、邻居就绪判定、跨区块面剔除、区块卸载、透明组分组。
 * 3. 贪心压缩比：用真实地形统计"剔除后存活面数"与"合并后矩形数"的比值。
 *
 * II. 为什么地形生成器是测试内的简单实现
 *
 * 真实地形生成器属于 `terrain/` 层，本用例要验证的是渲染链路，因此这里用一个确定性
 * 的正弦高度场：跨区块连续（不会在边界出现台阶），并且必然产生水与起伏。
 */

/** 与 `surfaceHeightAt` 共用，保证两处高度一致。 */
function surfaceHeight(wx: number, wz: number): number {
  return 64 + Math.round(Math.sin(wx * 0.15) * 2 + Math.cos(wz * 0.11) * 2);
}

function createTestGenerator(): TerrainGenerator {
  const options = {
    seaLevel: 63,
    baseHeight: 64,
    mountainAmplitude: 0,
    caves: false,
    ores: false,
    decorations: false,
  };

  return {
    seed: 1337,
    options,
    generate(cx: number, cz: number, target: ChunkDataTarget): void {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
          const height = surfaceHeight(cx * CHUNK_SIZE_X + lx, cz * CHUNK_SIZE_Z + lz);
          for (let y = 0; y <= height; y += 1) {
            const id = y === height ? BlockId.Grass : y > height - 3 ? BlockId.Dirt : BlockId.Stone;
            target.setBlock(lx, y, lz, id);
          }
          for (let y = height + 1; y <= options.seaLevel; y += 1) {
            target.setBlock(lx, y, lz, BlockId.Water);
          }
        }
      }
    },
    surfaceHeightAt(x: number, z: number): number {
      return Math.min(WORLD_MAX_Y, surfaceHeight(x, z) + 1);
    },
    biomeAt(): BiomeId {
      return 'plains';
    },
  };
}

/**
 * 读取几何体属性。
 *
 * `getAttribute` 在 @types/three 里的动态字符串重载返回 `any`，这里统一收窄，
 * 免得整个测试文件被 `no-unsafe-*` 规则刷屏。
 */
function attribute(geometry: THREE.BufferGeometry, name: string): THREE.BufferAttribute {
  return geometry.getAttribute(name) as THREE.BufferAttribute;
}

function createCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 2000);
  camera.position.set(8, 70, 8);
  camera.lookAt(8, 60, 30);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

/** 建一个 5x5 的已加载区块世界：内圈 3x3 的四个水平邻居都齐全。 */
function createWorld(): World {
  const world = new World({ seed: 1337, generator: createTestGenerator() });
  for (let cx = -2; cx <= 2; cx += 1) {
    for (let cz = -2; cz <= 2; cz += 1) {
      world.generateChunkNow(cx, cz);
    }
  }
  return world;
}

describe('区块流式渲染集成', () => {
  beforeAll(() => {
    installCanvas2DStub();
  });

  it('按帧预算把内圈区块建成网格', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const atlas = new BlockAtlas();
    const renderer = new WorldRenderer(scene, { atlas, rebuildBudget: 2 });
    const camera = createCamera();

    const perFrame: number[] = [];
    for (let frame = 0; frame < 20 && renderer.stats().chunks < 9; frame += 1) {
      renderer.update(world, camera);
      perFrame.push(renderer.stats().rebuilds);
    }

    // 3x3 内圈可建，其余 16 个区块因为邻居缺失被推迟。
    expect(renderer.stats().chunks).toBe(9);
    expect(renderer.stats().deferred).toBe(16);
    // 每帧都没有超过预算。
    expect(Math.max(...perFrame)).toBeLessThanOrEqual(2);
    // 9 个区块、每帧 2 个 → 至少 5 帧。
    expect(perFrame.length).toBeGreaterThanOrEqual(5);

    // 建完之后再跑一帧不应该有重建。
    renderer.update(world, camera);
    expect(renderer.stats().rebuilds).toBe(0);
    expect(renderer.group.children.length).toBeGreaterThan(0);

    renderer.dispose();
    atlas.dispose();
  });

  it('几何体属性齐全，tileRect 全部指向图集内的合法矩形', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const atlas = new BlockAtlas();
    const renderer = new WorldRenderer(scene, { atlas, rebuildBudget: 16 });
    const camera = createCamera();
    renderer.update(world, camera);

    // 收集图集里所有合法的 tile 矩形。float32 存储带舍入误差，因此用容差比较。
    const validRects: { u0: number; v0: number; u1: number; v1: number }[] = [];
    for (let id = 0; id < 22; id += 1) {
      for (const face of ['top', 'side', 'bottom'] as const) {
        validRects.push(atlas.tileUV(id as BlockId, face));
      }
    }
    const EPSILON = 1e-6;

    let checked = 0;
    for (const child of renderer.group.children) {
      if (!(child instanceof THREE.Mesh)) {
        continue;
      }
      const geometry = child.geometry as THREE.BufferGeometry;
      for (const name of ['position', 'normal', 'uv', 'tileRect']) {
        expect(attribute(geometry, name)).toBeDefined();
      }
      expect(geometry.getIndex()).not.toBeNull();

      const tileRects = attribute(geometry, 'tileRect');
      const uvs = attribute(geometry, 'uv');
      for (let i = 0; i < tileRects.count; i += 1) {
        const u0 = tileRects.getX(i);
        const v0 = tileRects.getY(i);
        const u1 = tileRects.getZ(i);
        const v1 = tileRects.getW(i);
        const matches = validRects.some(
          (rect) =>
            Math.abs(rect.u0 - u0) < EPSILON &&
            Math.abs(rect.v0 - v0) < EPSILON &&
            Math.abs(rect.u1 - u1) < EPSILON &&
            Math.abs(rect.v1 - v1) < EPSILON,
        );
        expect(matches).toBe(true);

        // 重复 UV 的跨度不会超过区块尺寸（合并的矩形最大 16x128）。
        expect(Math.abs(uvs.getX(i))).toBeLessThanOrEqual(CHUNK_SIZE_X);
        expect(Math.abs(uvs.getY(i))).toBeLessThanOrEqual(WORLD_MAX_Y);
        checked += 1;
      }
    }

    expect(checked).toBeGreaterThan(100);
    renderer.dispose();
    atlas.dispose();
  });

  it('真实地形的面剔除与贪心合并收益', () => {
    const world = createWorld();
    const atlas = new BlockAtlas();
    const mesher = new ChunkMesher(atlas);

    let unitFaces = 0;
    let quads = 0;
    let vertices = 0;
    let indices = 0;
    let blocks = 0;
    let transparentFaces = 0;

    for (let cx = -1; cx <= 1; cx += 1) {
      for (let cz = -1; cz <= 1; cz += 1) {
        const chunk = world.getChunk(cx, cz);
        expect(chunk).toBeDefined();
        if (chunk === undefined) {
          continue;
        }

        const data = mesher.mesh(chunk, world);
        unitFaces += data.stats.unitFaces;
        quads += data.stats.quads;
        vertices += data.stats.vertices;
        indices += data.opaque.indices.length + data.transparent.indices.length;
        transparentFaces += data.stats.transparent.unitFaces;
        for (const id of chunk.blocks) {
          if (id !== BlockId.Air) {
            blocks += 1;
          }
        }

        // 顶点数严格等于四边形数 * 4：没有退化成"一砖一面"。
        expect(data.stats.vertices).toBe(data.stats.quads * 4);
      }
    }

    // I. 逐方块输出会是 6 面/方块，剔除后存活的面数远小于它。
    expect(blocks).toBeGreaterThan(100_000);
    expect(unitFaces * 10).toBeLessThan(blocks * 6);
    // II. 合并后再压缩一个数量级的面积。
    expect(quads).toBeGreaterThan(0);
    expect(unitFaces / quads).toBeGreaterThan(3);
    // III. 水面必须进入透明组，否则半透明排序会出错。
    expect(transparentFaces).toBeGreaterThan(0);
    // IV. 顶点与索引的账目必须自洽。
    expect(vertices).toBe(quads * 4);
    expect(indices).toBe(quads * 6);

    atlas.dispose();
  });

  it('完全平坦的区块被合并成 1 个矩形（256:1）', () => {
    // 平坦世界的极端情况：整块 16x16 的顶面是一个矩形；四个侧面因为邻居同高被剔除，
    // 底面被世界底部的基岩剔除。
    const flat: TerrainGenerator = {
      seed: 7,
      options: {
        seaLevel: 63,
        baseHeight: 68,
        mountainAmplitude: 0,
        caves: false,
        ores: false,
        decorations: false,
      },
      // 平坦地形与坐标无关：参数保持接口签名即可。
      generate(_cx, _cz, target): void {
        for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
          for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
            for (let y = 0; y <= 68; y += 1) {
              const id = y === 68 ? BlockId.Grass : y > 65 ? BlockId.Dirt : BlockId.Stone;
              target.setBlock(lx, y, lz, id);
            }
          }
        }
      },
      surfaceHeightAt(): number {
        return 69;
      },
      biomeAt(): BiomeId {
        return 'plains';
      },
    };

    const world = new World({ seed: 7, generator: flat });
    for (let cx = -1; cx <= 1; cx += 1) {
      for (let cz = -1; cz <= 1; cz += 1) {
        world.generateChunkNow(cx, cz);
      }
    }

    const atlas = new BlockAtlas();
    const chunk = world.getChunk(0, 0);
    expect(chunk).toBeDefined();
    if (chunk === undefined) {
      return;
    }

    const data = new ChunkMesher(atlas).mesh(chunk, world);
    expect(data.stats.unitFaces).toBe(256);
    expect(data.stats.quads).toBe(1);
    expect(data.stats.vertices).toBe(4);
    expect(data.stats.triangles).toBe(2);

    atlas.dispose();
  });

  it('方块改动只重建受影响的区块', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const atlas = new BlockAtlas();
    const renderer = new WorldRenderer(scene, { atlas, rebuildBudget: 16 });
    const camera = createCamera();
    renderer.update(world, camera);
    const builtChunks = renderer.stats().chunks;
    expect(builtChunks).toBe(9);

    renderer.update(world, camera);
    expect(renderer.stats().rebuilds).toBe(0);

    // 在区块内部改一个方块：只应重建一个区块。
    expect(world.setBlock(8, 90, 8, BlockId.Lamp)).toBe(true);
    renderer.update(world, camera);
    expect(renderer.stats().rebuilds).toBe(1);

    // 在区块边界改方块：本区块与相邻区块都要重建（World 会标记两侧脏）。
    expect(world.setBlock(16, 90, 8, BlockId.Lamp)).toBe(true);
    renderer.update(world, camera);
    expect(renderer.stats().rebuilds).toBe(2);

    renderer.dispose();
    atlas.dispose();
  });

  it('区块卸载后网格被释放', () => {
    const world = createWorld();
    const scene = new THREE.Scene();
    const atlas = new BlockAtlas();
    const renderer = new WorldRenderer(scene, { atlas, rebuildBudget: 16 });
    const camera = createCamera();
    renderer.update(world, camera);
    expect(renderer.stats().chunks).toBe(9);

    const geometry = (renderer.group.children[0] as THREE.Mesh).geometry;
    let disposed = false;
    geometry.addEventListener('dispose', () => {
      disposed = true;
    });

    world.clear();
    renderer.update(world, camera);

    expect(disposed).toBe(true);
    expect(renderer.stats().chunks).toBe(0);
    expect(renderer.group.children).toHaveLength(0);

    renderer.dispose();
    atlas.dispose();
  });
});
