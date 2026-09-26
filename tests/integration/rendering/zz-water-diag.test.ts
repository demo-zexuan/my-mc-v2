// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';

import { BlockId } from '@/world/BlockRegistry';
import { World } from '@/world/World';
import { ChunkMesher } from '@/rendering/ChunkMesher';
import { BlockAtlas } from '@/rendering/textures/BlockAtlas';
import { createTerrainGenerator } from '@/terrain/TerrainGenerator';
import type { ChunkMeshGroup } from '@/rendering/ChunkMesher';

import { installCanvas2DStub } from '../../unit/rendering/canvasStub';

interface Quad {
  readonly group: 'opaque' | 'transparent';
  readonly axis: number;
  readonly sign: number;
  readonly plane: number;
  readonly a0: number;
  readonly a1: number;
  readonly b0: number;
  readonly b1: number;
  readonly block: number;
}

function quadsOf(group: ChunkMeshGroup, kind: 'opaque' | 'transparent'): Quad[] {
  const quads: Quad[] = [];
  for (let i = 0; i + 5 < group.indices.length; i += 6) {
    const a = group.indices[i] ?? 0;
    const nx = group.normals[a * 3] ?? 0;
    const ny = group.normals[a * 3 + 1] ?? 0;
    const nz = group.normals[a * 3 + 2] ?? 0;
    const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
    const sign = nx !== 0 ? nx : ny !== 0 ? ny : nz;
    const corners: number[][] = [];
    for (const index of [
      group.indices[i] ?? 0,
      group.indices[i + 1] ?? 0,
      group.indices[i + 2] ?? 0,
      group.indices[i + 5] ?? 0,
    ]) {
      corners.push([
        group.positions[index * 3] ?? 0,
        group.positions[index * 3 + 1] ?? 0,
        group.positions[index * 3 + 2] ?? 0,
      ]);
    }
    const axes = [0, 1, 2].filter((value) => value !== axis);
    const u = axes[0] ?? 0;
    const v = axes[1] ?? 1;
    const us = corners.map((c) => c[u] ?? 0);
    const vs = corners.map((c) => c[v] ?? 0);
    quads.push({
      group: kind,
      axis,
      sign,
      plane: corners[0]?.[axis] ?? 0,
      a0: Math.min(...us),
      a1: Math.max(...us),
      b0: Math.min(...vs),
      b1: Math.max(...vs),
      block: Math.round((group.tileRects[a * 4] ?? 0) * 100),
    });
  }
  return quads;
}

function overlaps(x: Quad, y: Quad): boolean {
  if (x.axis !== y.axis || x.sign !== y.sign) return false;
  if (Math.abs(x.plane - y.plane) > 1e-4) return false;
  // 共享一条边不算重叠。
  const da = Math.min(x.a1, y.a1) - Math.max(x.a0, y.a0);
  const db = Math.min(x.b1, y.b1) - Math.max(x.b0, y.b0);
  return da > 1e-4 && db > 1e-4;
}

describe('water diagnostic', () => {
  beforeAll(() => {
    installCanvas2DStub();
  });

  it('finds an ocean chunk and reports coplanar overlaps', () => {
    const generator = createTerrainGenerator(2024, {});
    const world = new World({ seed: 2024, generator });
    const atlas = new BlockAtlas();
    const mesher = new ChunkMesher(atlas);

    // 找一块有水的区块。
    let target: { cx: number; cz: number } | null = null;
    for (let cx = -6; cx <= 6 && target === null; cx += 1) {
      for (let cz = -6; cz <= 6 && target === null; cz += 1) {
        const chunk = world.generateChunkNow(cx, cz);
        if (chunk.blocks.includes(BlockId.Water)) {
          target = { cx, cz };
        }
      }
    }
    if (target === null) {
      console.warn('no water found');
      expect(true).toBe(true);
      return;
    }

    // 加载 3x3 邻居，跨区块剔除才正确。
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        world.generateChunkNow(target.cx + dx, target.cz + dz);
      }
    }
    const chunk = world.getChunk(target.cx, target.cz);
    if (chunk === undefined) throw new Error('missing chunk');

    const data = mesher.mesh(chunk, world);
    const opaque = quadsOf(data.opaque, 'opaque');
    const transparent = quadsOf(data.transparent, 'transparent');

    const reports: string[] = [];
    reports.push(
      `chunk (${target.cx},${target.cz}) opaqueQuads=${opaque.length} transparentQuads=${transparent.length}`,
    );

    // I. 透明组内部重叠（水水共面重叠）。
    let selfOverlap = 0;
    for (let i = 0; i < transparent.length; i += 1) {
      for (let j = i + 1; j < transparent.length; j += 1) {
        const a = transparent[i];
        const b = transparent[j];
        if (a !== undefined && b !== undefined && overlaps(a, b)) selfOverlap += 1;
      }
    }

    // II. 透明组与不透明组共面重叠（水与沙子同一平面）。
    let crossOverlap = 0;
    const crossSamples: string[] = [];
    for (const water of transparent) {
      for (const solid of opaque) {
        if (overlaps(water, solid)) {
          crossOverlap += 1;
          if (crossSamples.length < 8) {
            crossSamples.push(
              `axis=${water.axis} sign=${water.sign} plane=${water.plane.toFixed(2)} water[${water.a0}-${water.a1},${water.b0}-${water.b1}] solid[${solid.a0}-${solid.a1},${solid.b0}-${solid.b1}] solidBlock=${solid.block}`,
            );
          }
        }
      }
    }

    // III. 水面的高度分布与海底最高面。
    const waterTop = transparent.filter((q) => q.axis === 1 && q.sign === 1);
    const solidTop = opaque.filter((q) => q.axis === 1 && q.sign === 1);
    const planes = new Set(waterTop.map((q) => q.plane));
    const solidPlanes = new Set(solidTop.map((q) => q.plane));

    reports.push(`selfOverlap=${selfOverlap} crossOverlap=${crossOverlap}`);
    reports.push(`water top planes: ${[...planes].sort((a, b) => a - b).join(',')}`);
    reports.push(`solid top planes: ${[...solidPlanes].sort((a, b) => a - b).join(',')}`);
    reports.push(...crossSamples);
    console.warn(reports.join('\n'));

    atlas.dispose();
    expect(true).toBe(true);
  });
});
