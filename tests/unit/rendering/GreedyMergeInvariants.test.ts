import { describe, expect, it } from 'vitest';

import { BlockId, isOpaque, isTransparent } from '@/world/BlockRegistry';
import { Chunk } from '@/world/Chunk';
import { CHUNK_SIZE_X, CHUNK_SIZE_Z, chunkKey } from '@/world/coords';
import {
  ChunkMesher,
  createChunkMapAccessor,
  type BlockAccessor,
  type ChunkMeshGroup,
} from '@/rendering/ChunkMesher';
import type { BlockFace, TileLookup } from '@/rendering/textures/BlockAtlas';

/**
 * 贪心合并的几何不变量。
 *
 * I. 为什么需要这一层测试
 *
 * 只看"面数对不对"无法排除一类危险缺陷：**两个四边形在同一平面上互相重叠**。
 * 重叠会让透明水面与地形在深度上打架（密集横纹），而且面数统计一点都不会异常。
 * 因此这里从最终 typed array 反解出每个四边形，独立验证：
 *
 * 1. 同一组、同一平面、同一朝向的四边形两两不重叠（最多共享边）。
 * 2. 不透明组的四边形不会和透明组在同一平面重叠（水与沙不会共面打架）。
 * 3. 所有四边形的面积之和 == 通过面剔除后存活的面数，且该面数由上文的**朴素逐方块
 *    枚举**独立算出——两条实现路径互相印证。
 */

/** 面法线方向，顺序与朴素枚举保持一致。 */
const DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

const TEST_LOOKUP: TileLookup = {
  tileUV: (blockId, face) => {
    const slot = blockId * 3 + (face === 'top' ? 0 : face === 'side' ? 1 : 2);
    return { u0: slot / 128, v0: 0.5, u1: slot / 128 + 1 / 256, v1: 0.55 };
  },
};

/** 从 typed array 反解出的一个四边形。 */
interface QuadView {
  readonly group: 'opaque' | 'transparent';
  readonly axis: number;
  readonly sign: number;
  readonly plane: number;
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
}

function quadsOf(group: ChunkMeshGroup, kind: 'opaque' | 'transparent'): QuadView[] {
  const quads: QuadView[] = [];
  for (let i = 0; i + 5 < group.indices.length; i += 6) {
    const corners = [
      group.indices[i] ?? 0,
      group.indices[i + 1] ?? 0,
      group.indices[i + 2] ?? 0,
      group.indices[i + 5] ?? 0,
    ].map((index) => {
      return [
        group.positions[index * 3] ?? 0,
        group.positions[index * 3 + 1] ?? 0,
        group.positions[index * 3 + 2] ?? 0,
      ] as const;
    });

    const first = corners[0];
    if (first === undefined) {
      continue;
    }
    const nx = group.normals[(group.indices[i] ?? 0) * 3] ?? 0;
    const ny = group.normals[(group.indices[i] ?? 0) * 3 + 1] ?? 0;
    const nz = group.normals[(group.indices[i] ?? 0) * 3 + 2] ?? 0;
    const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
    const sign = nx !== 0 ? (nx > 0 ? 1 : -1) : ny !== 0 ? (ny > 0 ? 1 : -1) : nz > 0 ? 1 : -1;
    const other = [0, 1, 2].filter((value) => value !== axis);
    const u = other[0] ?? 0;
    const v = other[1] ?? 1;
    const us = corners.map((corner) => corner[u]);
    const vs = corners.map((corner) => corner[v]);

    quads.push({
      group: kind,
      axis,
      sign,
      plane: first[axis],
      u0: Math.min(...us),
      u1: Math.max(...us),
      v0: Math.min(...vs),
      v1: Math.max(...vs),
    });
  }
  return quads;
}

/** 两个四边形是否在同一平面上有正面积交叠（共享一条边不算）。 */
function overlaps(a: QuadView, b: QuadView): boolean {
  if (a.axis !== b.axis || a.sign !== b.sign) {
    return false;
  }
  if (Math.abs(a.plane - b.plane) > 1e-4) {
    return false;
  }
  const du = Math.min(a.u1, b.u1) - Math.max(a.u0, b.u0);
  const dv = Math.min(a.v1, b.v1) - Math.max(a.v0, b.v0);
  return du > 1e-4 && dv > 1e-4;
}

/** 四个角必须共面、且与顶点法线一致（绕序正确）。 */
function checkPlanarAndWound(group: ChunkMeshGroup): void {
  for (let i = 0; i + 5 < group.indices.length; i += 6) {
    const [a, b, c, d] = [
      group.indices[i] ?? 0,
      group.indices[i + 1] ?? 0,
      group.indices[i + 2] ?? 0,
      group.indices[i + 5] ?? 0,
    ];
    const at = (index: number): readonly number[] => [
      group.positions[index * 3] ?? 0,
      group.positions[index * 3 + 1] ?? 0,
      group.positions[index * 3 + 2] ?? 0,
    ];
    const [pa, pb, pc, pd] = [at(a), at(b), at(c), at(d)];
    // 三角形 (a, b, c) 的几何法线方向必须与顶点法线一致。
    const ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const cross = [
      (ab[1] ?? 0) * (ac[2] ?? 0) - (ab[2] ?? 0) * (ac[1] ?? 0),
      (ab[2] ?? 0) * (ac[0] ?? 0) - (ab[0] ?? 0) * (ac[2] ?? 0),
      (ab[0] ?? 0) * (ac[1] ?? 0) - (ab[1] ?? 0) * (ac[0] ?? 0),
    ];
    const normal = [
      group.normals[a * 3] ?? 0,
      group.normals[a * 3 + 1] ?? 0,
      group.normals[a * 3 + 2] ?? 0,
    ];
    const dot =
      (cross[0] ?? 0) * (normal[0] ?? 0) +
      (cross[1] ?? 0) * (normal[1] ?? 0) +
      (cross[2] ?? 0) * (normal[2] ?? 0);
    expect(dot).toBeGreaterThan(0);

    // 第四个角必须落在前三者确定的平面上。
    const planeDot =
      normal[0] * ((pd[0] ?? 0) - (pa[0] ?? 0)) +
      normal[1] * ((pd[1] ?? 0) - (pa[1] ?? 0)) +
      normal[2] * ((pd[2] ?? 0) - (pa[2] ?? 0));
    expect(Math.abs(planeDot ?? 0)).toBeLessThan(1e-5);
  }
}

/**
 * 朴素逐方块枚举：与贪心合并完全独立的实现路径。
 *
 * 对每个非空气方块、每个方向判断邻居是否遮挡，得出"存活单位面数"。
 */
function naiveVisibleFaces(chunk: Chunk, accessor: BlockAccessor): number {
  let count = 0;
  for (let y = 0; y < 128; y += 1) {
    for (let lz = 0; lz < CHUNK_SIZE_Z; lz += 1) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx += 1) {
        const id = chunk.getBlock(lx, y, lz);
        if (id === BlockId.Air) {
          continue;
        }
        for (const [dx, dy, dz] of DIRECTIONS) {
          const neighbour = accessor.getBlock(
            chunk.cx * CHUNK_SIZE_X + lx + dx,
            y + dy,
            chunk.cz * CHUNK_SIZE_Z + lz + dz,
          ) as BlockId;
          const hidden =
            isOpaque(neighbour) || (neighbour === id && isTransparent(id) && id !== BlockId.Air);
          if (!hidden) {
            count += 1;
          }
        }
      }
    }
  }
  return count;
}

function accessorFor(...chunks: readonly Chunk[]): BlockAccessor {
  const map = new Map<number, Chunk>();
  for (const chunk of chunks) {
    map.set(chunkKey(chunk.cx, chunk.cz), chunk);
  }
  return createChunkMapAccessor(map);
}

/** 造一个"阶梯海底 + 平坦水面 + 沙滩"的测试区块。 */
function createOceanChunk(): Chunk {
  const chunk = new Chunk(0, 0);
  const seaLevel = 8;
  for (let x = 0; x < CHUNK_SIZE_X; x += 1) {
    for (let z = 0; z < CHUNK_SIZE_Z; z += 1) {
      // 海底每 3 格下降一层，形成会被贪心合并切分的阶梯。
      const floor = 4 - Math.floor(x / 3) + (z % 5 === 0 ? 1 : 0);
      for (let y = 0; y <= floor; y += 1) {
        chunk.setBlock(x, y, z, y === floor ? BlockId.Sand : BlockId.Stone, false);
      }
      // 高于海平面的柱子留成沙滩（不填水），其余填水。
      for (let y = floor + 1; y <= seaLevel; y += 1) {
        const id = floor >= seaLevel ? BlockId.Air : BlockId.Water;
        if (id === BlockId.Air) {
          continue;
        }
        // 偶数列留几个空气泡，制造水与水的分割面。
        if (y === seaLevel && x % 7 === 3) {
          continue;
        }
        chunk.setBlock(x, y, z, id, false);
      }
      if (floor >= seaLevel) {
        chunk.setBlock(x, seaLevel, z, BlockId.Sand, false);
      }
    }
  }
  return chunk;
}

describe('贪心合并几何不变量', () => {
  it('四边形不重叠、总面积等于存活面数', () => {
    const chunk = createOceanChunk();
    const accessor = accessorFor(chunk);
    const data = new ChunkMesher(TEST_LOOKUP).mesh(chunk, accessor);

    const quads = [...quadsOf(data.opaque, 'opaque'), ...quadsOf(data.transparent, 'transparent')];
    expect(quads.length).toBeGreaterThan(50);

    // I. 同一组内两两不重叠。
    for (let i = 0; i < quads.length; i += 1) {
      for (let j = i + 1; j < quads.length; j += 1) {
        const a = quads[i];
        const b = quads[j];
        if (a === undefined || b === undefined) {
          continue;
        }
        expect(overlaps(a, b)).toBe(false);
      }
    }

    // II. 面积之和 == 存活面数（贪心合并只改变矩形数量，不改变面积）。
    let area = 0;
    for (const quad of quads) {
      area += (quad.u1 - quad.u0) * (quad.v1 - quad.v0);
    }
    expect(area).toBe(data.stats.unitFaces);

    // III. 与朴素逐方块枚举的结果一致：两条独立实现路径互相印证。
    expect(naiveVisibleFaces(chunk, accessor)).toBe(data.stats.unitFaces);

    // IV. 合并后确实变少了，否则说明合并逻辑没有生效。
    expect(data.stats.quads).toBeLessThan(data.stats.unitFaces);
  });

  it('水面与海底不会共面重叠（透明组 vs 不透明组）', () => {
    const chunk = createOceanChunk();
    const data = new ChunkMesher(TEST_LOOKUP).mesh(chunk, accessorFor(chunk));

    const opaque = quadsOf(data.opaque, 'opaque');
    const transparent = quadsOf(data.transparent, 'transparent');
    expect(transparent.length).toBeGreaterThan(0);
    expect(opaque.length).toBeGreaterThan(0);

    let crossPairs = 0;
    for (const water of transparent) {
      for (const solid of opaque) {
        if (overlaps(water, solid)) {
          crossPairs += 1;
        }
      }
    }
    expect(crossPairs).toBe(0);
  });

  it('水面合并后覆盖所有暴露的水柱', () => {
    const chunk = createOceanChunk();
    const data = new ChunkMesher(TEST_LOOKUP).mesh(chunk, accessorFor(chunk));

    // 统计"顶面暴露的水柱"数量。
    let exposed = 0;
    for (let x = 0; x < CHUNK_SIZE_X; x += 1) {
      for (let z = 0; z < CHUNK_SIZE_Z; z += 1) {
        for (let y = 127; y >= 0; y -= 1) {
          const id = chunk.getBlock(x, y, z);
          if (id === BlockId.Air) {
            continue;
          }
          if (id === BlockId.Water) {
            exposed += 1;
          }
          break;
        }
      }
    }
    expect(exposed).toBeGreaterThan(0);

    const topQuads = quadsOf(data.transparent, 'transparent').filter(
      (quad) => quad.axis === 1 && quad.sign === 1,
    );
    let covered = 0;
    for (const quad of topQuads) {
      covered += (quad.u1 - quad.u0) * (quad.v1 - quad.v0);
    }
    expect(covered).toBe(exposed);
  });

  it('所有四边形共面且绕序朝外', () => {
    const chunk = createOceanChunk();
    const data = new ChunkMesher(TEST_LOOKUP).mesh(chunk, accessorFor(chunk));
    checkPlanarAndWound(data.opaque);
    checkPlanarAndWound(data.transparent);
  });
});
