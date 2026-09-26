import { describe, expect, it } from 'vitest';

import { BlockId } from '@/world/BlockRegistry';
import { Chunk } from '@/world/Chunk';
import { chunkKey } from '@/world/coords';
import {
  ChunkMesher,
  createChunkMapAccessor,
  type BlockAccessor,
  type ChunkMeshGroup,
} from '@/rendering/ChunkMesher';
import type { BlockFace, TileLookup } from '@/rendering/textures/BlockAtlas';

/**
 * 贪心合并的确定性单测。
 *
 * I. 为什么这些用例全部用"已知排列 → 期望面数/顶点数"的形式
 *
 * 贪心合并是纯函数式的算法：输入固定，输出的矩形数量、顶点数与法线分布就完全确定。
 * 断言具体数字能一次抓住三类回归：合并过度（跨方块合并）、合并不足（回到一砖一面）、
 * 绕序或法线方向写反。
 *
 * II. 测试辅助
 *
 * 实现保证每个四边形连续输出 4 个顶点、6 个索引，因此 `quadsOf` 可以按 6 个索引一组
 * 还原出四边形，用来按法线方向统计面数。
 */

/** 让假 UV 表的每个 slot 唯一：`u0` 直接编码 (id, face)。 */
const FACE_ORDER: Readonly<Record<BlockFace, number>> = { top: 1, side: 2, bottom: 3 };

const TEST_LOOKUP: TileLookup = {
  tileUV: (blockId, face) => {
    const slot = blockId * 3 + FACE_ORDER[face];
    return { u0: slot / 100, v0: 0.25, u1: slot / 100 + 0.01, v1: 0.26 };
  },
};

interface VertexView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly u: number;
  readonly v: number;
  readonly rect: readonly [number, number, number, number];
}

interface QuadView {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly corners: readonly VertexView[];
}

function vertexAt(group: ChunkMeshGroup, index: number): VertexView {
  return {
    x: group.positions[index * 3] ?? 0,
    y: group.positions[index * 3 + 1] ?? 0,
    z: group.positions[index * 3 + 2] ?? 0,
    u: group.uvs[index * 2] ?? 0,
    v: group.uvs[index * 2 + 1] ?? 0,
    rect: [
      group.tileRects[index * 4] ?? 0,
      group.tileRects[index * 4 + 1] ?? 0,
      group.tileRects[index * 4 + 2] ?? 0,
      group.tileRects[index * 4 + 3] ?? 0,
    ],
  };
}

function quadsOf(group: ChunkMeshGroup): QuadView[] {
  const quads: QuadView[] = [];
  for (let i = 0; i + 5 < group.indices.length; i += 6) {
    const a = group.indices[i] ?? 0;
    const b = group.indices[i + 1] ?? 0;
    const c = group.indices[i + 2] ?? 0;
    const d = group.indices[i + 5] ?? 0;
    quads.push({
      nx: group.normals[a * 3] ?? 0,
      ny: group.normals[a * 3 + 1] ?? 0,
      nz: group.normals[a * 3 + 2] ?? 0,
      corners: [vertexAt(group, a), vertexAt(group, b), vertexAt(group, c), vertexAt(group, d)],
    });
  }
  return quads;
}

function countByNormal(group: ChunkMeshGroup): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const quad of quadsOf(group)) {
    const key = `${quad.nx},${quad.ny},${quad.nz}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

const EMPTY_ACCESSOR: BlockAccessor = { getBlock: () => BlockId.Air };

function makeChunk(cx = 0, cz = 0): Chunk {
  return new Chunk(cx, cz);
}

/** 往区块里写一批方块。 */
function fill(
  chunk: Chunk,
  blocks: readonly (readonly [number, number, number, BlockId])[],
): Chunk {
  for (const [x, y, z, id] of blocks) {
    chunk.setBlock(x, y, z, id, false);
  }
  return chunk;
}

/** 一个以 `chunk` 为唯一加载区块的世界访问器。 */
function accessorFor(...chunks: readonly Chunk[]): BlockAccessor {
  const map = new Map<number, Chunk>();
  for (const chunk of chunks) {
    map.set(chunkKey(chunk.cx, chunk.cz), chunk);
  }
  return createChunkMapAccessor(map);
}

function mesh(
  chunk: Chunk,
  accessor: BlockAccessor = accessorFor(chunk),
): ReturnType<ChunkMesher['mesh']> {
  return new ChunkMesher(TEST_LOOKUP).mesh(chunk, accessor);
}

describe('ChunkMesher 贪心合并', () => {
  it('4x1x1 连续石头合并成 6 个四边形', () => {
    const chunk = makeChunk();
    for (let x = 0; x < 4; x += 1) {
      chunk.setBlock(x, 5, 0, BlockId.Stone, false);
    }

    const data = mesh(chunk);

    // 合并前 4 个方块共 24 个候选面，内部 3 对面被剔除 → 18 个单位面。
    expect(data.stats.unitFaces).toBe(18);
    // 上下各 1、两端各 1、左右各 1 → 6 个矩形。
    expect(data.stats.quads).toBe(6);
    expect(data.stats.vertices).toBe(24);
    expect(data.stats.triangles).toBe(12);
    expect(data.opaque.positions).toHaveLength(24 * 3);
    expect(data.opaque.indices).toHaveLength(36);
    expect(countByNormal(data.opaque)).toEqual({
      '0,1,0': 1,
      '0,-1,0': 1,
      '1,0,0': 1,
      '-1,0,0': 1,
      '0,0,1': 1,
      '0,0,-1': 1,
    });
  });

  it('16x16x1 平面在合并前后是 576 → 6，压缩比 96:1', () => {
    const chunk = makeChunk();
    for (let x = 0; x < 16; x += 1) {
      for (let z = 0; z < 16; z += 1) {
        chunk.setBlock(x, 5, z, BlockId.Stone, false);
      }
    }

    const data = mesh(chunk);

    // 上表面 256 + 下表面 256 + 四壁各 16 = 576 个单位面。
    expect(data.stats.unitFaces).toBe(576);
    // 上下各 1 个 16x16 的矩形，四壁各 1 个 16x1 的矩形。
    expect(data.stats.quads).toBe(6);
    expect(data.stats.unitFaces / data.stats.quads).toBe(96);
    expect(data.stats.vertices).toBe(24);
  });

  it('合并后的矩形按方向保留正确尺寸', () => {
    const chunk = makeChunk();
    for (let x = 0; x < 4; x += 1) {
      chunk.setBlock(x, 5, 0, BlockId.Stone, false);
    }

    const data = mesh(chunk);

    // I. 顶面：法线轴是 Y，平面内 u 轴是 Z、v 轴是 X，所以矩形是 1x4。
    // 1. uv 是"tile 局部重复坐标"，跨度 4 意味着贴图沿 X 重复 4 次。
    const top = quadsOf(data.opaque).find((quad) => quad.ny === 1);
    expect(top).toBeDefined();
    expect(top?.corners.map((corner) => `${corner.u},${corner.v}`)).toEqual([
      '0,0',
      '1,0',
      '1,4',
      '0,4',
    ]);

    // II. 侧面：法线轴是 Z，u 轴是 X、v 轴是 Y，矩形的 UV 跨度是 4x1。
    const side = quadsOf(data.opaque).find((quad) => quad.nz === 1);
    expect(side).toBeDefined();
    expect(side?.corners.map((corner) => `${corner.u},${corner.v}`)).toEqual([
      '0,0',
      '4,0',
      '4,1',
      '0,1',
    ]);
  });

  it('完全被遮挡的方块生成 0 个面', () => {
    const chunk = makeChunk();
    // 中心石头加上六个方向的邻居，中心方块被完全包住。
    fill(chunk, [
      [5, 5, 5, BlockId.Stone],
      [6, 5, 5, BlockId.Stone],
      [4, 5, 5, BlockId.Stone],
      [5, 6, 5, BlockId.Stone],
      [5, 4, 5, BlockId.Stone],
      [5, 5, 6, BlockId.Stone],
      [5, 5, 4, BlockId.Stone],
    ]);

    const data = mesh(chunk);

    // 六个"胳膊"各暴露 5 个面（朝中心的那个面被遮挡），中心贡献 0。
    expect(data.stats.unitFaces).toBe(30);
    expect(data.stats.quads).toBe(30);

    // 把中心挖空后，六个朝向中心的面重新出现：30 + 6 = 36。
    chunk.setBlock(5, 5, 5, BlockId.Air, false);
    expect(mesh(chunk).stats.unitFaces).toBe(36);
  });

  it('2x2x2 实心立方体只保留外表面并合并成 6 个矩形', () => {
    const chunk = makeChunk();
    for (let x = 5; x < 7; x += 1) {
      for (let y = 5; y < 7; y += 1) {
        for (let z = 5; z < 7; z += 1) {
          chunk.setBlock(x, y, z, BlockId.Stone, false);
        }
      }
    }

    const data = mesh(chunk);

    // 48 个候选面 - 24 个内部面 = 24 个单位面，合并成 6 个 2x2 矩形。
    expect(data.stats.unitFaces).toBe(24);
    expect(data.stats.quads).toBe(6);
    expect(data.stats.vertices).toBe(24);
  });

  it('世界底部的底面被基岩遮挡，不生成面', () => {
    const chunk = makeChunk();
    chunk.setBlock(1, 0, 1, BlockId.Stone, false);

    // 访问器对 y < 0 返回基岩，因此底面被剔除：只剩 5 个面。
    expect(mesh(chunk).stats.unitFaces).toBe(5);
  });

  it('不同方块的相邻面不会被合并', () => {
    const chunk = makeChunk();
    fill(chunk, [
      [0, 5, 0, BlockId.Stone],
      [1, 5, 0, BlockId.Stone],
      [2, 5, 0, BlockId.Dirt],
      [3, 5, 0, BlockId.Dirt],
    ]);

    const data = mesh(chunk);
    const topQuads = quadsOf(data.opaque).filter((quad) => quad.ny === 1);

    // 石头的 2x1 与泥土的 2x1 各占一个矩形，且 tileRect 指向各自的贴图。
    expect(topQuads).toHaveLength(2);
    const rects = topQuads.map((quad) => quad.corners[0]?.rect[0]);
    expect(new Set(rects).size).toBe(2);
  });
});

describe('ChunkMesher 面剔除', () => {
  it('邻居为不透明方块时不生成该面', () => {
    const chunk = makeChunk();
    fill(chunk, [
      [0, 5, 0, BlockId.Stone],
      [1, 5, 0, BlockId.Dirt],
    ]);

    const data = mesh(chunk);
    // 两个方块各自 6 面，相接的一对面被剔除。
    expect(data.stats.unitFaces).toBe(10);
  });

  it('跨区块边界的面剔除走世界坐标访问器', () => {
    const left = makeChunk(0, 0);
    const right = makeChunk(1, 0);
    left.setBlock(15, 5, 0, BlockId.Stone, false);
    right.setBlock(0, 5, 0, BlockId.Stone, false);

    // 邻居未加载：边界被当成外表面，出现"假墙"的那一面。
    expect(mesh(left, accessorFor(left)).stats.unitFaces).toBe(6);
    // 邻居加载后：相接的一对面被正确剔除。
    expect(mesh(left, accessorFor(left, right)).stats.unitFaces).toBe(5);
    expect(mesh(right, accessorFor(left, right)).stats.unitFaces).toBe(5);
  });

  it('空区块不产生任何几何体', () => {
    const data = mesh(makeChunk());
    expect(data.stats.quads).toBe(0);
    expect(data.opaque.indices).toHaveLength(0);
    expect(data.opaque.positions).toHaveLength(0);
    expect(data.transparent.indices).toHaveLength(0);
    expect(EMPTY_ACCESSOR.getBlock(0, 0, 0)).toBe(BlockId.Air);
  });

  it('按最高非空气方块裁剪扫描范围不会漏面', () => {
    // 高处孤立方块：扫描范围被裁到 y=121，但这 6 个面必须照样输出。
    const high = makeChunk();
    high.setBlock(7, 120, 7, BlockId.Lamp, false);
    expect(mesh(high).stats.unitFaces).toBe(6);

    // 世界最高层的方块：上方在区块外，必须走访问器并判定为空气。
    const top = makeChunk();
    top.setBlock(1, 127, 1, BlockId.Stone, false);
    expect(mesh(top).stats.unitFaces).toBe(6);

    // 只有一格高的地形也不会因为裁剪而丢掉底面（底面被基岩遮挡 → 5 面）。
    const shallow = makeChunk();
    shallow.setBlock(3, 0, 3, BlockId.Stone, false);
    expect(mesh(shallow).stats.unitFaces).toBe(5);
  });
});

describe('ChunkMesher 透明组分离', () => {
  it('水与石头分属两组，且互不遮挡', () => {
    const chunk = makeChunk();
    fill(chunk, [
      [0, 5, 0, BlockId.Stone],
      [1, 5, 0, BlockId.Water],
    ]);

    const data = mesh(chunk);
    // 石头 6 面（水的透明不遮挡它），水 5 面（石头遮挡了它的 -X 面）。
    expect(data.stats.opaque.unitFaces).toBe(6);
    expect(data.stats.transparent.unitFaces).toBe(5);
    expect(data.opaque.indices.length).toBeGreaterThan(0);
    expect(data.transparent.indices.length).toBeGreaterThan(0);
    expect(data.stats.quads).toBe(11);
  });

  it('同种透明方块之间的内部面被剔除并合并', () => {
    const chunk = makeChunk();
    fill(chunk, [
      [0, 5, 0, BlockId.Water],
      [1, 5, 0, BlockId.Water],
    ]);

    const data = mesh(chunk);
    expect(data.stats.opaque.quads).toBe(0);
    // 2x1x1 的水块：12 - 2 = 10 个单位面，合并成 6 个矩形。
    expect(data.stats.transparent.unitFaces).toBe(10);
    expect(data.stats.transparent.quads).toBe(6);
  });

  it('玻璃与树叶也进入透明组', () => {
    const chunk = makeChunk();
    fill(chunk, [
      [2, 5, 2, BlockId.Glass],
      [8, 5, 8, BlockId.Leaves],
    ]);

    const data = mesh(chunk);
    expect(data.stats.transparent.unitFaces).toBe(12);
    expect(data.stats.opaque.quads).toBe(0);
  });
});

describe('ChunkMesher UV 与属性', () => {
  it('按面方向选择 top / side / bottom 贴图', () => {
    const chunk = makeChunk();
    chunk.setBlock(3, 8, 3, BlockId.Grass, false);

    const data = mesh(chunk);
    const quads = quadsOf(data.opaque);

    const rectOf = (ny: number, nz: number): number => {
      const quad = quads.find((entry) => entry.ny === ny && entry.nz === nz);
      expect(quad).toBeDefined();
      return quad?.corners[0]?.rect[0] ?? -1;
    };

    const expected = (face: BlockFace): number => (BlockId.Grass * 3 + FACE_ORDER[face]) / 100;

    expect(rectOf(1, 0)).toBeCloseTo(expected('top'), 6);
    expect(rectOf(-1, 0)).toBeCloseTo(expected('bottom'), 6);
    // ±X 与 ±Z 都是侧面。
    for (const quad of quads) {
      if (quad.ny === 0) {
        expect(quad.corners[0]?.rect[0]).toBeCloseTo(expected('side'), 6);
      }
    }
  });

  it('输出的是区块局部坐标', () => {
    const chunk = makeChunk(2, -3);
    chunk.setBlock(0, 5, 0, BlockId.Stone, false);

    const data = mesh(chunk);
    const xs = Array.from(data.opaque.positions.filter((_, index) => index % 3 === 0));
    const zs = Array.from(data.opaque.positions.filter((_, index) => index % 3 === 2));

    // 顶点留在 0..16 的局部空间，世界偏移交给 Mesh.position。
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(16);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...zs)).toBeLessThanOrEqual(16);
  });

  it('法线是单位轴向向量且绕序朝外', () => {
    const chunk = makeChunk();
    chunk.setBlock(4, 6, 4, BlockId.Stone, false);

    const data = mesh(chunk);
    const quads = quadsOf(data.opaque);
    expect(quads).toHaveLength(6);

    for (const quad of quads) {
      const [a, b, c] = quad.corners;
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(c).toBeDefined();
      if (a === undefined || b === undefined || c === undefined) {
        continue;
      }

      // 三角形 (a,b,c) 的几何法线必须与顶点法线同向：绕序决定了背面被剔除。
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const abz = b.z - a.z;
      const acx = c.x - a.x;
      const acy = c.y - a.y;
      const acz = c.z - a.z;
      const crossX = aby * acz - abz * acy;
      const crossY = abz * acx - abx * acz;
      const crossZ = abx * acy - aby * acx;
      const dot = crossX * quad.nx + crossY * quad.ny + crossZ * quad.nz;
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('重复构建同一个区块得到完全一致的输出', () => {
    const chunk = makeChunk();
    fill(chunk, [
      [0, 5, 0, BlockId.Stone],
      [1, 5, 0, BlockId.Water],
      [2, 5, 0, BlockId.Glass],
    ]);

    const first = mesh(chunk);
    const second = mesh(chunk);
    expect(Array.from(second.opaque.positions)).toEqual(Array.from(first.opaque.positions));
    expect(Array.from(second.transparent.uvs)).toEqual(Array.from(first.transparent.uvs));
    expect(Array.from(second.opaque.tileRects)).toEqual(Array.from(first.opaque.tileRects));
  });

  it('复用同一个 mesher 实例不会残留上一区块的数据', () => {
    const mesher = new ChunkMesher(TEST_LOOKUP);
    const full = makeChunk();
    for (let x = 0; x < 16; x += 1) {
      for (let z = 0; z < 16; z += 1) {
        full.setBlock(x, 5, z, BlockId.Stone, false);
      }
    }

    const big = mesher.mesh(full, accessorFor(full));
    expect(big.stats.quads).toBe(6);

    const empty = mesher.mesh(makeChunk(1, 1), EMPTY_ACCESSOR);
    expect(empty.stats.quads).toBe(0);
    expect(empty.opaque.indices).toHaveLength(0);
  });
});
