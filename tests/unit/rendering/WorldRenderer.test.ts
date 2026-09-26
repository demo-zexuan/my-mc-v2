import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { BlockId } from '@/world/BlockRegistry';
import { Chunk } from '@/world/Chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, chunkKey } from '@/world/coords';
import { createChunkMapAccessor } from '@/rendering/ChunkMesher';
import type { BlockAccessor } from '@/rendering/ChunkMesher';
import { WorldRenderer, patchAtlasUvShader } from '@/rendering/WorldRenderer';
import type { VoxelChunkSource } from '@/rendering/WorldRenderer';
import type { TileLookup } from '@/rendering/textures/BlockAtlas';

/**
 * 区块流式渲染的单测。
 *
 * I. 覆盖的行为
 *
 * 1. 邻居不全时不建网格（否则区块接缝会出现假墙）。
 * 2. 每帧重建数量受预算限制，且近处优先。
 * 3. 脏标记清除后不再重复重建；改方块会重新排队。
 * 4. 视锥剔除、透明排序、卸载释放。
 *
 * II. 为什么不需要 GL
 *
 * `WorldRenderer` 只操作场景图与几何体，这些对象在 Node 下都能构造。真正的绘制路径由
 * Playwright 端到端用例覆盖。
 */

const TEST_LOOKUP: TileLookup = {
  tileUV: (blockId, face) => {
    const slot = blockId * 3 + (face === 'top' ? 0 : face === 'side' ? 1 : 2);
    return { u0: slot / 128, v0: 0.5, u1: slot / 128 + 1 / 256, v1: 0.55 };
  },
};

/** 一个可控的假世界，语义与 `World` 的区块查询保持一致。 */
class FakeWorld implements VoxelChunkSource {
  public readonly map = new Map<number, Chunk>();
  readonly #accessor: BlockAccessor;

  public constructor() {
    this.#accessor = createChunkMapAccessor(this.map);
  }

  public get chunks(): IterableIterator<Chunk> {
    return this.map.values();
  }

  public getChunk(cx: number, cz: number): Chunk | undefined {
    return this.map.get(chunkKey(cx, cz));
  }

  public getBlock(x: number, y: number, z: number): number {
    return this.#accessor.getBlock(x, y, z);
  }

  /** 建一个区块，可选地往里面写方块。 */
  public add(cx: number, cz: number, block?: BlockId): Chunk {
    const chunk = new Chunk(cx, cz);
    if (block !== undefined && block !== BlockId.Air) {
      const height = 5;
      for (let x = 0; x < CHUNK_SIZE_X; x += 2) {
        for (let z = 0; z < CHUNK_SIZE_Z; z += 2) {
          chunk.setBlock(x, height, z, block, false);
        }
      }
    }
    this.map.set(chunkKey(cx, cz), chunk);
    return chunk;
  }

  /** 铺满 (2r+1)^2 的区块网格。 */
  public addGrid(radius: number, block?: BlockId): void {
    for (let cx = -radius; cx <= radius; cx += 1) {
      for (let cz = -radius; cz <= radius; cz += 1) {
        this.add(cx, cz, block);
      }
    }
  }
}

function createRenderer(
  scene: THREE.Scene,
  budget: number,
): { renderer: WorldRenderer; disposedMaterials: string[] } {
  const disposedMaterials: string[] = [];
  const opaque = new THREE.MeshBasicMaterial();
  const transparent = new THREE.MeshBasicMaterial();
  for (const [name, material] of [
    ['opaque', opaque],
    ['transparent', transparent],
  ] as const) {
    material.addEventListener('dispose', () => {
      disposedMaterials.push(name);
    });
  }

  const renderer = new WorldRenderer(scene, {
    rebuildBudget: budget,
    materials: { opaque, transparent },
    tileLookup: TEST_LOOKUP,
  });
  return { renderer, disposedMaterials };
}

function createCamera(position: THREE.Vector3, lookAt: THREE.Vector3): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 4000);
  camera.position.copy(position);
  camera.lookAt(lookAt);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return camera;
}

describe('WorldRenderer 区块调度', () => {
  it('邻居不全时不建网格，避免假墙', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.add(0, 0, BlockId.Stone);
    const { renderer } = createRenderer(scene, 2);
    const camera = createCamera(new THREE.Vector3(8, 20, 8), new THREE.Vector3(8, 0, 8));

    renderer.update(world, camera);

    expect(renderer.stats().chunks).toBe(0);
    expect(renderer.stats().deferred).toBe(1);
    renderer.dispose();
  });

  it('四邻齐全后才建网格', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    // 只放中心与左右邻居：上下的邻居缺失。
    world.add(0, 0, BlockId.Stone);
    world.add(-1, 0, BlockId.Stone);
    world.add(1, 0, BlockId.Stone);

    const { renderer } = createRenderer(scene, 4);
    const camera = createCamera(new THREE.Vector3(8, 30, 8), new THREE.Vector3(8, 0, 8));
    renderer.update(world, camera);
    expect(renderer.stats().chunks).toBe(0);

    world.add(0, -1, BlockId.Stone);
    world.add(0, 1, BlockId.Stone);
    renderer.update(world, camera);
    expect(renderer.stats().chunks).toBe(1);

    renderer.dispose();
  });

  it('每帧重建数量不超过预算，并优先重建离相机最近的区块', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.addGrid(2, BlockId.Stone);

    const { renderer } = createRenderer(scene, 2);
    // 相机站在 (32, 30, 32)，靠近区块 (2,2) 一侧。
    const camera = createCamera(new THREE.Vector3(38, 30, 38), new THREE.Vector3(38, 0, 38));

    renderer.update(world, camera);
    expect(renderer.stats().rebuilds).toBe(2);
    expect(renderer.stats().chunks).toBe(2);

    // 第一帧建出来的两片必须是离相机最近的：区块中心到相机的水平距离。
    const nearest = renderer.group.children
      .map((child) => Math.hypot(child.position.x + 8 - 38, child.position.z + 8 - 38))
      .sort((a, b) => a - b);
    expect(nearest[0]).toBeLessThan(nearest[1] ?? Number.POSITIVE_INFINITY);

    // 3x3 的内圈共 9 个区块可建，预算 2 → 还需要 4 帧。
    for (let frame = 0; frame < 4; frame += 1) {
      renderer.update(world, camera);
    }
    expect(renderer.stats().chunks).toBe(9);
    expect(renderer.stats().deferred).toBe(16);

    renderer.dispose();
  });

  it('建好的区块不会重复重建，改方块后重新排队', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.addGrid(1, BlockId.Stone);
    const { renderer } = createRenderer(scene, 8);
    const camera = createCamera(new THREE.Vector3(8, 30, 8), new THREE.Vector3(8, 0, 8));

    renderer.update(world, camera);
    expect(renderer.stats().chunks).toBe(1);
    expect(renderer.stats().rebuilds).toBe(1);

    renderer.update(world, camera);
    expect(renderer.stats().rebuilds).toBe(0);

    world.getChunk(0, 0)?.setBlock(3, 20, 3, BlockId.Water, false);
    renderer.update(world, camera);
    expect(renderer.stats().rebuilds).toBe(1);

    renderer.dispose();
  });

  it('预算至少为 1，非法值不会让渲染停摆', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.addGrid(1, BlockId.Stone);
    const { renderer } = createRenderer(scene, 0);
    const camera = createCamera(new THREE.Vector3(8, 30, 8), new THREE.Vector3(8, 0, 8));

    renderer.update(world, camera);
    expect(renderer.stats().rebuilds).toBe(1);

    renderer.dispose();
  });
});

describe('WorldRenderer 可见性', () => {
  it('视锥之外的区块被隐藏', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.addGrid(1, BlockId.Stone);
    const { renderer } = createRenderer(scene, 8);

    const toward = createCamera(new THREE.Vector3(8, 30, 8), new THREE.Vector3(8, 0, 8));
    renderer.update(world, toward);
    expect(renderer.stats().visible).toBe(1);

    // 相机挪到很远的地方并背对区块：包围盒不在视锥内。
    const away = createCamera(new THREE.Vector3(900, 30, 900), new THREE.Vector3(1800, 30, 1800));
    renderer.update(world, away);
    expect(renderer.stats().chunks).toBe(1);
    expect(renderer.stats().visible).toBe(0);
    expect(renderer.group.children.every((child) => !child.visible)).toBe(true);

    renderer.dispose();
  });

  it('空的区块包围盒退化成薄片但仍然合法', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.addGrid(1);
    const { renderer } = createRenderer(scene, 8);
    const camera = createCamera(new THREE.Vector3(8, 30, 8), new THREE.Vector3(8, 0, 8));

    renderer.update(world, camera);
    // 空区块没有几何体，但统计里依然算一个已处理的区块。
    expect(renderer.stats().chunks).toBe(1);
    expect(renderer.group.children).toHaveLength(0);
    expect(renderer.stats().quads).toBe(0);

    renderer.dispose();
  });

  it('透明组按由远及近分配 renderOrder', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.addGrid(3, BlockId.Water);

    const { renderer } = createRenderer(scene, 64);
    const camera = createCamera(new THREE.Vector3(200, 40, 0), new THREE.Vector3(0, 40, 0));
    renderer.update(world, camera);

    const transparentMeshes = renderer.group.children.filter((child) =>
      child.name.endsWith(':transparent'),
    );
    expect(transparentMeshes.length).toBeGreaterThan(1);

    const withDistance = transparentMeshes.map((child) => ({
      order: child.renderOrder,
      distance: Math.hypot(
        child.position.x + 8 - camera.position.x,
        child.position.z + 8 - camera.position.z,
      ),
    }));

    for (const entry of withDistance) {
      for (const other of withDistance) {
        if (other.distance > entry.distance) {
          // 更远的区块必须先画（renderOrder 更小），否则远处的水面会盖住近处的。
          expect(other.order).toBeLessThan(entry.order);
        }
      }
    }

    // 每个可见透明区块拿到一个互不相同的序号，正好覆盖 0..n-1。
    const orders = withDistance.map((entry) => entry.order).sort((a, b) => a - b);
    expect(orders).toEqual(withDistance.map((_, index) => index));

    renderer.dispose();
  });
});

describe('WorldRenderer 资源生命周期', () => {
  it('区块卸载后释放几何体并从场景移除', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.addGrid(1, BlockId.Stone);
    const { renderer } = createRenderer(scene, 8);
    const camera = createCamera(new THREE.Vector3(8, 30, 8), new THREE.Vector3(8, 0, 8));
    renderer.update(world, camera);

    const mesh = renderer.group.children[0];
    expect(mesh).toBeInstanceOf(THREE.Mesh);
    let geometryDisposed = false;
    if (mesh instanceof THREE.Mesh) {
      const geometry = mesh.geometry as THREE.BufferGeometry;
      geometry.addEventListener('dispose', () => {
        geometryDisposed = true;
      });
    }

    world.map.delete(chunkKey(0, 0));
    renderer.update(world, camera);

    expect(geometryDisposed).toBe(true);
    expect(renderer.stats().chunks).toBe(0);
    expect(renderer.group.children).toHaveLength(0);

    renderer.dispose();
  });

  it('dispose 清空场景并保留注入的材质', () => {
    const scene = new THREE.Scene();
    const world = new FakeWorld();
    world.addGrid(1, BlockId.Stone);
    const { renderer, disposedMaterials } = createRenderer(scene, 8);
    const camera = createCamera(new THREE.Vector3(8, 30, 8), new THREE.Vector3(8, 0, 8));
    renderer.update(world, camera);
    expect(renderer.group.children.length).toBeGreaterThan(0);

    const geometry = (renderer.group.children[0] as THREE.Mesh).geometry;
    let geometryDisposed = false;
    geometry.addEventListener('dispose', () => {
      geometryDisposed = true;
    });

    renderer.dispose();

    expect(geometryDisposed).toBe(true);
    expect(scene.children).toHaveLength(0);
    // 注入的材质由调用方负责释放。
    expect(disposedMaterials).toEqual([]);
  });
});

describe('WorldRenderer 图集 UV 着色器补丁', () => {
  it('声明 tileRect 属性与 varying 并替换 map_fragment', () => {
    const shader = {
      vertexShader: '#include <common>\n#include <uv_vertex>\nvoid main() {}',
      fragmentShader: '#include <common>\n#include <map_fragment>\nvoid main() {}',
    };

    patchAtlasUvShader(shader);

    expect(shader.vertexShader).toContain('attribute vec4 tileRect;');
    expect(shader.vertexShader).toContain('vTileRect = tileRect;');
    expect(shader.fragmentShader).toContain('varying vec4 vTileRect;');
    expect(shader.fragmentShader).toContain('atlasUv');
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
  });

  it('用 textureGrad + 折叠前的解析导数选 mip，避免接缝取到最粗一级', () => {
    const shader = {
      vertexShader: '#include <common>\n#include <uv_vertex>',
      fragmentShader: '#include <common>\n#include <map_fragment>',
    };

    patchAtlasUvShader(shader);

    // fract() 会让折叠后的 uv 在每条方块边界上不连续；若硬件据此求导，
    // 缝上会选到"整张图集的平均色"，即水面横纹 / 沙地点阵的根因。
    expect(shader.fragmentShader).toContain('textureGrad(');
    expect(shader.fragmentShader).toContain('dFdx( vMapUv ) * atlasTileSize');
    expect(shader.fragmentShader).toContain('dFdy( vMapUv ) * atlasTileSize');
    expect(shader.fragmentShader).not.toContain('texture2D( map, atlasUv )');
  });
});
