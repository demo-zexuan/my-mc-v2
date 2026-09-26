// @vitest-environment jsdom
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';

import { BlockId, BLOCK_TYPE_COUNT } from '@/world/BlockRegistry';
import { BlockAtlas, type BlockFace } from '@/rendering/textures/BlockAtlas';

import { installCanvas2DStub } from './canvasStub';

/**
 * 图集单测。
 *
 * I. 覆盖的四个不变量
 *
 * 1. **布局**：slot 与 (id, face) 的映射、内边界 UV 矩形、padding 的像素宽度。
 * 2. **padding 复制**：gutter 像素必须等于相邻的内容像素——它是 mipmap 不渗色的唯一保证。
 * 3. **确定性**：同样的参数必须画出逐字节相同的图集，否则视觉回归与快照都不可靠。
 * 4. **采样设置**：Nearest + mipmap + sRGB + anisotropy + ClampToEdge。
 */

const FACES: readonly BlockFace[] = ['top', 'side', 'bottom'];

function pixel(atlas: BlockAtlas, x: number, y: number): readonly number[] {
  const offset = (y * atlas.width + x) * 4;
  return [
    atlas.pixels[offset] ?? 0,
    atlas.pixels[offset + 1] ?? 0,
    atlas.pixels[offset + 2] ?? 0,
    atlas.pixels[offset + 3] ?? 0,
  ];
}

/** slot 在图集中的列号与行号。 */
function slotOf(
  atlas: BlockAtlas,
  blockId: BlockId,
  face: BlockFace,
): { column: number; row: number } {
  const rect = atlas.tileUV(blockId, face);
  const stride = atlas.tileSize + atlas.padding * 2;
  // flipY = true：`v = 1 - y / height`，所以行号由 v1 反推。
  const column = Math.round((rect.u0 * atlas.width - atlas.padding) / stride);
  const row = Math.round(((1 - rect.v1) * atlas.height) / stride);
  return { column, row };
}

describe('BlockAtlas 布局', () => {
  let atlas: BlockAtlas;

  beforeAll(() => {
    installCanvas2DStub();
    atlas = new BlockAtlas();
  });

  it('每个 (blockId, face) 都有一个 slot', () => {
    for (let id = 0; id < BLOCK_TYPE_COUNT; id += 1) {
      for (const face of FACES) {
        const rect = atlas.tileUV(id as BlockId, face);
        expect(rect.u1).toBeGreaterThan(rect.u0);
        expect(rect.v1).toBeGreaterThan(rect.v0);
        expect(rect.u0).toBeGreaterThanOrEqual(0);
        expect(rect.u1).toBeLessThanOrEqual(1);
        expect(rect.v0).toBeGreaterThanOrEqual(0);
        expect(rect.v1).toBeLessThanOrEqual(1);
      }
    }
  });

  it('内边界矩形正好是 tileSize 像素', () => {
    const rect = atlas.tileUV(BlockId.Stone, 'side');
    expect((rect.u1 - rect.u0) * atlas.width).toBeCloseTo(atlas.tileSize, 6);
    expect((rect.v1 - rect.v0) * atlas.height).toBeCloseTo(atlas.tileSize, 6);
  });

  it('相邻 tile 之间至少有 2 倍 padding 的间隔', () => {
    const left = atlas.tileUV(BlockId.Stone, 'top');
    const right = atlas.tileUV(BlockId.Stone, 'side');
    // stone 的 top 与 side 是相邻 slot（slot = id*3 + 0/1）。
    const gap = (right.u0 - left.u1) * atlas.width;
    expect(gap).toBeCloseTo(atlas.padding * 2, 6);
  });

  it('grass 的顶面与侧面使用不同 tile', () => {
    const top = atlas.tileUV(BlockId.Grass, 'top');
    const side = atlas.tileUV(BlockId.Grass, 'side');

    expect(top.u0).not.toBe(side.u0);
    const topSlot = slotOf(atlas, BlockId.Grass, 'top');
    const sideSlot = slotOf(atlas, BlockId.Grass, 'side');
    expect(topSlot.column).not.toBe(sideSlot.column);
  });

  it('图集尺寸覆盖所有 slot', () => {
    const stride = atlas.tileSize + atlas.padding * 2;
    expect(atlas.width).toBe(atlas.columns * stride);
    expect(atlas.height).toBe(atlas.rows * stride);
    expect(atlas.columns * atlas.rows).toBeGreaterThanOrEqual(BLOCK_TYPE_COUNT * 3);
    expect(atlas.pixels).toHaveLength(atlas.width * atlas.height * 4);
  });
});

describe('BlockAtlas padding', () => {
  it('gutter 逐像素复制相邻的内容像素', () => {
    installCanvas2DStub();
    const atlas = new BlockAtlas({ tileSize: 16, padding: 4 });
    const stride = atlas.tileSize + atlas.padding * 2;
    const { column, row } = slotOf(atlas, BlockId.Stone, 'top');
    const originX = column * stride;
    const originY = row * stride;

    for (let y = 0; y < atlas.tileSize; y += 1) {
      const contentY = originY + atlas.padding + y;
      // (1) 左 gutter 等于内容最左列。
      expect(pixel(atlas, originX, contentY)).toEqual(
        pixel(atlas, originX + atlas.padding, contentY),
      );
      // (2) 右 gutter 等于内容最右列。
      expect(pixel(atlas, originX + stride - 1, contentY)).toEqual(
        pixel(atlas, originX + atlas.padding + atlas.tileSize - 1, contentY),
      );
    }

    for (let x = 0; x < atlas.tileSize; x += 1) {
      const contentX = originX + atlas.padding + x;
      // (3) 上下 gutter 同理。
      expect(pixel(atlas, contentX, originY)).toEqual(
        pixel(atlas, contentX, originY + atlas.padding),
      );
      expect(pixel(atlas, contentX, originY + stride - 1)).toEqual(
        pixel(atlas, contentX, originY + atlas.padding + atlas.tileSize - 1),
      );
    }

    // (4) 四个角同样被复制，不会出现空洞。
    expect(pixel(atlas, originX, originY)).toEqual(
      pixel(atlas, originX + atlas.padding, originY + atlas.padding),
    );
  });

  it('padding = 0 时 tile 紧挨着，内边界矩形仍然正确', () => {
    installCanvas2DStub();
    const atlas = new BlockAtlas({ tileSize: 8, padding: 0, columns: 8 });
    const rect = atlas.tileUV(BlockId.Dirt, 'top');
    expect((rect.u1 - rect.u0) * atlas.width).toBeCloseTo(8, 6);

    // dirt 的 top 是 slot 6，第 6 列 → u0 落在 48 像素处。
    expect(rect.u0 * atlas.width).toBeCloseTo(48, 6);
    // 没有 padding 时相邻 tile 直接相接。
    const next = atlas.tileUV(BlockId.Dirt, 'side');
    expect((next.u0 - rect.u1) * atlas.width).toBeCloseTo(0, 6);
  });
});

describe('BlockAtlas 图案', () => {
  it('生成了确定性的像素', () => {
    installCanvas2DStub();
    const first = new BlockAtlas();
    const second = new BlockAtlas();
    expect(Array.from(second.pixels)).toEqual(Array.from(first.pixels));
  });

  it('不同方块的 tile 内容不同', () => {
    installCanvas2DStub();
    const atlas = new BlockAtlas();
    const stride = atlas.tileSize + atlas.padding * 2;

    const sample = (blockId: BlockId): number[] => {
      const { column, row } = slotOf(atlas, blockId, 'side');
      const originX = column * stride + atlas.padding;
      const originY = row * stride + atlas.padding;
      return [0, 1, 2, 3].flatMap((offset) => pixel(atlas, originX + offset, originY + offset));
    };

    expect(sample(BlockId.Stone)).not.toEqual(sample(BlockId.Water));
    expect(sample(BlockId.Grass)).not.toEqual(sample(BlockId.Sand));
  });

  it('不透明方块的 tile 完全不透明，水与玻璃带 alpha', () => {
    installCanvas2DStub();
    const atlas = new BlockAtlas();
    const stride = atlas.tileSize + atlas.padding * 2;

    const alphas = (blockId: BlockId, face: BlockFace): number[] => {
      const { column, row } = slotOf(atlas, blockId, face);
      const originX = column * stride + atlas.padding;
      const originY = row * stride + atlas.padding;
      const values: number[] = [];
      for (let y = 0; y < atlas.tileSize; y += 1) {
        for (let x = 0; x < atlas.tileSize; x += 1) {
          values.push(pixel(atlas, originX + x, originY + y)[3] ?? 0);
        }
      }
      return values;
    };

    expect(Math.min(...alphas(BlockId.Stone, 'side'))).toBe(255);
    expect(Math.min(...alphas(BlockId.Water, 'top'))).toBeLessThan(255);
    expect(alphas(BlockId.Glass, 'side').filter((value) => value < 255).length).toBeGreaterThan(0);
  });

  it('只产生一次 putImageData 上传', () => {
    const recorder = installCanvas2DStub();
    new BlockAtlas();
    expect(recorder.images).toHaveLength(1);
    expect(recorder.fills).toBe(0);
  });
});

describe('BlockAtlas 纹理设置', () => {
  it('使用 Nearest + mipmap + sRGB + 各向异性 + 边缘钳制', () => {
    installCanvas2DStub();
    const atlas = new BlockAtlas({ anisotropy: 8 });
    const texture = atlas.texture;

    expect(texture.magFilter).toBe(THREE.NearestFilter);
    expect(texture.minFilter).toBe(THREE.NearestMipmapLinearFilter);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
    expect(texture.wrapT).toBe(THREE.ClampToEdgeWrapping);
    expect(texture.anisotropy).toBe(8);
    expect(texture.image).toBe(atlas.canvas);
  });

  it('dispose 释放纹理', () => {
    installCanvas2DStub();
    const atlas = new BlockAtlas();
    let disposed = false;
    atlas.texture.addEventListener('dispose', () => {
      disposed = true;
    });

    atlas.dispose();
    expect(disposed).toBe(true);
  });
});
