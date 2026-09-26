/**
 * 程序化方块纹理图集。
 *
 * I. 为什么在运行时画图集，而不是打包 PNG
 *
 * 1. 与 `textures/procedural.ts` 相同的取舍：图集由 `world/blocks.ts` 的 `TILE`
 *    描述符派生，改一次配色不需要经历"改图 → 导出 → 提交二进制"的流程。
 * 2. 描述符只声明"这个方块长什么样"（主色 / 图案 / 点缀色），画布、mipmap 与
 *    Three.js 只出现在渲染层，`world/` 依旧不认识像素。
 * 3. 图集必须能被单测断言：颜色、padding、UV 矩形都是纯函数输出，不依赖美术资源。
 *
 * II. 为什么每个 tile 周围必须留 padding（本项目最容易踩的视觉坑）
 *
 * 1. 图集启用 mipmap 后，采样会读取相邻像素的加权平均。如果两个 tile 在纹理里紧挨
 *    着，缩小视图时 GPU 会把邻居的颜色混进来，方块边缘出现一圈"彩边"。
 * 2. 因此每个 tile 外侧铺一圈 padding，且 padding 不是透明或黑，而是**边缘像素复制**
 *    （clamp 采样），这样任何一级 mip 读到的仍然是本 tile 自己的颜色。
 * 3. `tileUV()` 只返回内边界矩形，padding 永远落在 UV 之外，绝不会被采样到。
 *
 * III. 图集布局
 *
 * 1. 每个 (blockId, face) 占一个 slot，共 `BLOCK_TYPE_COUNT * 3` 个，slot 与
 *    (id, face) 之间是纯算术关系，不做去重：去重会让"同一份样式在不同面画不同图案"
 *    的规则变得隐晦，而 66 个 16x16 tile 的显存代价可以忽略。
 * 2. slot 排列为 `slot = id * 3 + FACE_SLOT[face]`，图集按 `columns` 列折行，
 *    每个 slot 的步进是 `tileSize + 2 * padding`。
 * 3. `flipY` 保持 Three.js 默认的 `true`，所以画布行号与 V 轴方向相反：
 *    `v = 1 - y / height`，`tileUV` 已经把这次翻转算进去了。
 *
 * @module rendering/textures/BlockAtlas
 */

import * as THREE from 'three';

import { BLOCK_TYPE_COUNT, texturesOf } from '@/world/BlockRegistry';
import type { BlockId } from '@/world/BlockRegistry';
import type { TilePattern, TileStyle } from '@/world/blocks';

/** 方块的一个面所对应的 tile 类别。 */
export type BlockFace = 'top' | 'side' | 'bottom';

/** slot 内的固定顺序，保证 `slot = id * 3 + FACE_SLOT[face]` 稳定。 */
const FACE_SLOT: Readonly<Record<BlockFace, number>> = { top: 0, side: 1, bottom: 2 };

/** UV 空间中的一个矩形，`v0 < v1`。 */
export interface TileUvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

/**
 * tile UV 查询接口。
 *
 * 网格构建器只依赖这个窄接口，因此它不需要知道 canvas、mipmap 或 Three.js 的存在，
 * 单测里可以注入一张假的 UV 表。
 */
export interface TileLookup {
  /**
   * 查询某个方块某一面在图集中的内边界 UV 矩形。
   *
   * @param blockId - 方块 id。
   * @param face - 该面所属的 tile 类别。
   * @returns 内边界矩形，实现应返回缓存对象以避免每个面都分配对象。
   */
  tileUV(blockId: BlockId, face: BlockFace): TileUvRect;
}

export interface BlockAtlasOptions {
  /** 单个 tile 的边长（像素）。默认 16，与体素美术的粒度一致。 */
  readonly tileSize?: number;
  /** tile 四周的 padding 宽度（像素）。默认 4，可覆盖 3 级 mip 的采样半径。 */
  readonly padding?: number;
  /** 图集列数；默认按 slot 数开平方取整。 */
  readonly columns?: number;
  /** 各向异性过滤等级，默认 4；由调用方按硬件上限收敛。 */
  readonly anisotropy?: number;
  /** 噪声种子；固定默认值保证同一份代码画出完全相同的图集。 */
  readonly seed?: number;
}

/** 透明图案的 alpha：水体半透明，玻璃更透，其余不透明。 */
const PATTERN_ALPHA: Readonly<Record<TilePattern, number>> = {
  solid: 1,
  noise: 1,
  grass: 1,
  wood: 1,
  leaves: 1,
  liquid: 0.78,
  glass: 0.5,
  ore: 1,
  crystal: 1,
};

const DEFAULT_TILE_SIZE = 16;
const DEFAULT_PADDING = 4;
const DEFAULT_SEED = 0x9e37;

// ---------------------------------------------------------------------------
// 颜色工具：全部用 0xRRGGBB 打包整数运算，避免每个像素分配对象
// ---------------------------------------------------------------------------

/** 按 `t` 在 `a`、`b` 之间线性插值，`t` 会被夹到 `0..1`。 */
function mixColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(((a >> 16) & 255) * (1 - k) + ((b >> 16) & 255) * k);
  const g = Math.round(((a >> 8) & 255) * (1 - k) + ((b >> 8) & 255) * k);
  const bl = Math.round((a & 255) * (1 - k) + (b & 255) * k);
  return (r << 16) | (g << 8) | bl;
}

/** 整体提亮（`f > 1`）或压暗（`f < 1`）一个颜色。 */
function scaleColor(color: number, factor: number): number {
  const r = Math.min(255, Math.round(((color >> 16) & 255) * factor));
  const g = Math.min(255, Math.round(((color >> 8) & 255) * factor));
  const bl = Math.min(255, Math.round((color & 255) * factor));
  return (r << 16) | (g << 8) | bl;
}

/** 写入一个 RGBA 像素，`index` 是字节偏移。 */
function writePixel(out: Uint8ClampedArray, index: number, color: number, alpha: number): void {
  out[index] = (color >> 16) & 255;
  out[index + 1] = (color >> 8) & 255;
  out[index + 2] = color & 255;
  out[index + 3] = Math.round(alpha * 255);
}

/**
 * 整数哈希，返回 `0 .. 1` 的确定性噪声。
 *
 * 刻意不使用 `Math.random()`：图集必须是可复现的，否则同一份源码在不同会话里
 * 会画出不同的方块，视觉回归测试也就失去了意义。
 */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 0x100000000;
}

// ---------------------------------------------------------------------------
// 图案绘制
// ---------------------------------------------------------------------------

/**
 * 把一个 `TileStyle` 画成 `size x size` 的 RGBA 像素。
 *
 * I. 为什么需要 `isSideStyle`
 *
 * 1. `TileStyle` 只描述颜色，不描述"这张 tile 贴在哪个面"。同样一份 `wood` 样式，
 *    贴在侧面应该是竖直木纹（木板 / 树皮），贴在顶面应该是年轮（原木端面）。
 * 2. 判定依据来自方块自身：如果这份样式同时是该方块的侧面 tile，说明它是"六面通用"
 *    样式（木板），一律画竖纹；否则它只出现在水平面上（原木端面），画年轮。
 * 3. 同一个规则也让 `grass` 区分出"草顶"（整片绿）与"草侧"（泥土 + 顶部草皮）。
 *
 * @param style - 方块纹理描述符。
 * @param size - tile 边长（像素）。
 * @param isSideStyle - 该样式是否同时被用作所属方块的侧面 tile。
 * @param seed - 噪声种子。
 * @param out - 长度 `size * size * 4` 的 RGBA 缓冲，函数会完整覆写它。
 */
export function paintTile(
  style: TileStyle,
  size: number,
  isSideStyle: boolean,
  seed: number,
  out: Uint8ClampedArray,
): void {
  const base = style.baseColor;
  const accent = style.accentColor ?? scaleColor(base, 0.75);
  const speckle = style.speckle ?? 0.3;
  const alpha = PATTERN_ALPHA[style.pattern];
  // 自发光方块（萤石灯）在贴图层面提亮，避免夜里看起来像一块暗斑。
  const glow = 1 + (style.emissive ?? 0) * 0.35;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const noise = hash2(x, y, seed);
      let color = base;
      let pixelAlpha = alpha;

      switch (style.pattern) {
        case 'solid':
          color = base;
          break;

        case 'noise':
          // 颗粒感来自围绕中值的对称抖动，speckle 越大越像砾石。
          color = mixColor(base, accent, 0.5 + (noise - 0.5) * 2 * speckle);
          break;

        case 'grass': {
          if (isSideStyle) {
            // (1) 侧面：泥土底色 + 顶部一条锯齿状草皮。
            color = mixColor(base, accent, 0.5 + (noise - 0.5) * 2 * speckle);
            const depth = 3 + Math.floor(hash2(x, 0, seed + 11) * 3);
            if (y < depth) {
              color = mixColor(accent, style.baseColor, 0.25 + noise * 0.2);
            }
          } else {
            // (1) 顶面：整片草色，用点缀色画出明暗草叶。
            color = mixColor(base, accent, 0.35 + noise * 0.65);
          }
          break;
        }

        case 'wood': {
          if (isSideStyle) {
            // (1) 竖纹：每 4 像素一条深色纹路，再叠加轻微抖动。
            const line = x % 4 === 1 || x % 7 === 3;
            const tone = line ? 0.75 : 0.2 + noise * 0.35;
            color = mixColor(base, accent, tone);
          } else {
            // (1) 年轮：以 tile 中心为圆心的同心环。
            const dx = x - (size - 1) / 2;
            const dy = y - (size - 1) / 2;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const ring = 0.5 + 0.5 * Math.sin(dist * 2.2 + noise * 0.6);
            color = mixColor(base, accent, ring);
          }
          break;
        }

        case 'leaves': {
          color = mixColor(base, accent, noise);
          // (1) 少量镂空让树叶透光；alpha 0 的像素由材质的 alphaTest 丢弃。
          if (noise > 0.94) {
            pixelAlpha = 0;
          }
          break;
        }

        case 'liquid': {
          // (1) 横向波纹：相位随 x 缓慢偏移，形成流动的错觉。
          const wave = Math.sin((y + Math.sin(x * 0.55) * 1.6) * 0.85);
          color = mixColor(base, accent, 0.5 + wave * 0.4);
          break;
        }

        case 'glass': {
          // (1) 玻璃只画边框与一条高光，中间几乎全透。
          const edge = x === 0 || y === 0 || x === size - 1 || y === size - 1;
          const highlight = Math.abs(x - y) <= 1;
          if (edge) {
            color = mixColor(accent, base, 0.15);
            pixelAlpha = 0.65;
          } else if (highlight) {
            color = mixColor(base, accent, 0.7);
            pixelAlpha = 0.4;
          } else {
            color = base;
            pixelAlpha = PATTERN_ALPHA.glass * 0.35;
          }
          break;
        }

        case 'ore': {
          // (1) 石头底 + 若干矿脉团块，团块位置由哈希决定，因此矿石永远长在同一个地方。
          color = mixColor(base, accent, 0.5 + (noise - 0.5) * 2 * speckle);
          for (let blob = 0; blob < 5; blob += 1) {
            const bx = hash2(blob, 3, seed) * size;
            const by = hash2(blob, 7, seed) * size;
            const dx = x - bx;
            const dy = y - by;
            if (dx * dx + dy * dy <= 2.6) {
              color = mixColor(accent, base, noise * 0.25);
              break;
            }
          }
          break;
        }

        case 'crystal': {
          // (1) 斜向切面 + 中心亮核，用于冰与萤石灯。
          const facet = (x + y) % 8 < 2 ? 0.55 : 0.15 + noise * 0.3;
          const dx = x - (size - 1) / 2;
          const dy = y - (size - 1) / 2;
          const core = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / (size * 0.5));
          color = mixColor(base, accent, Math.min(1, facet + core * 0.5));
          break;
        }
      }

      writePixel(out, (y * size + x) * 4, scaleColor(color, glow), pixelAlpha);
    }
  }
}

// ---------------------------------------------------------------------------
// 图集
// ---------------------------------------------------------------------------

export class BlockAtlas implements TileLookup {
  /** 可直接挂到 `map` 上的图集纹理（sRGB + Nearest + mipmap + 各向异性）。 */
  public readonly texture: THREE.CanvasTexture;

  /** 生成图集用的画布；保留引用便于调试与二次修改。 */
  public readonly canvas: HTMLCanvasElement;

  /** 完整 RGBA 像素副本；单测直接断言 padding 复制与图案确定性。 */
  public readonly pixels: Uint8ClampedArray;

  public readonly tileSize: number;
  public readonly padding: number;
  public readonly columns: number;
  public readonly rows: number;
  public readonly width: number;
  public readonly height: number;

  /** 每个 slot 的步进（含两侧 padding）。 */
  readonly #stride: number;
  /** 预计算的 UV 矩形，`tileUV` 直接返回它，因此没有逐面分配。 */
  readonly #rects: readonly (TileUvRect | undefined)[];

  public constructor(options: BlockAtlasOptions = {}) {
    const tileSize = Math.max(1, Math.floor(options.tileSize ?? DEFAULT_TILE_SIZE));
    const padding = Math.max(0, Math.floor(options.padding ?? DEFAULT_PADDING));
    const seed = options.seed ?? DEFAULT_SEED;

    const slots = BLOCK_TYPE_COUNT * 3;
    const columns = Math.max(1, Math.floor(options.columns ?? Math.ceil(Math.sqrt(slots))));
    const rows = Math.ceil(slots / columns);
    const stride = tileSize + padding * 2;
    const width = columns * stride;
    const height = rows * stride;

    this.tileSize = tileSize;
    this.padding = padding;
    this.columns = columns;
    this.rows = rows;
    this.width = width;
    this.height = height;
    this.#stride = stride;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('2D canvas context is unavailable; cannot build the block atlas.');
    }

    const image = context.createImageData(width, height);
    const pixels = image.data;
    const rects: (TileUvRect | undefined)[] = new Array<TileUvRect | undefined>(slots);
    const tile = new Uint8ClampedArray(tileSize * tileSize * 4);

    for (let id = 0; id < BLOCK_TYPE_COUNT; id += 1) {
      // `texturesOf` 只接受合法 id；这里按注册表长度遍历，因此必然是合法的。
      const textures = texturesOf(id as BlockId);
      for (const face of ['top', 'side', 'bottom'] as const) {
        const style = textures[face];
        const slot = id * 3 + FACE_SLOT[face];
        const column = slot % columns;
        const row = Math.floor(slot / columns);

        // 同一份样式贴在侧面上还是水平面上，图案不同（见 paintTile 的说明）。
        paintTile(style, tileSize, textures.side === style, seed + id * 31, tile);

        const originX = column * stride;
        const originY = row * stride;
        this.#blitTile(pixels, tile, originX, originY);

        const u0 = (originX + padding) / width;
        const u1 = (originX + padding + tileSize) / width;
        // flipY = true：画布行号越大，V 越小。
        const v1 = 1 - (originY + padding) / height;
        const v0 = 1 - (originY + padding + tileSize) / height;
        rects[slot] = { u0, v0, u1, v1 };
      }
    }

    context.putImageData(image, 0, 0);
    this.canvas = canvas;
    this.pixels = pixels;
    this.#rects = rects;

    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'block-atlas';
    // 体素美术靠最近邻采样保持锐利；缩小视图时用 mipmap 抑制闪烁。
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    texture.generateMipmaps = true;
    // 图集不能重复，越界采样必须钳制在 padding 内。
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.max(1, Math.floor(options.anisotropy ?? 4));
    texture.needsUpdate = true;
    this.texture = texture;
  }

  /**
   * 查询某个方块某一面的内边界 UV 矩形。
   *
   * @throws {RangeError} id 或 face 越界时抛出，避免"石头画出水的贴图"这类静默错误。
   */
  public tileUV(blockId: BlockId, face: BlockFace): TileUvRect {
    const slot = blockId * 3 + FACE_SLOT[face];
    const rect = this.#rects[slot];
    if (rect === undefined) {
      throw new RangeError(`No atlas tile for block ${blockId} face ${face}.`);
    }
    return rect;
  }

  /** 释放纹理占用的 GPU 资源。 */
  public dispose(): void {
    this.texture.dispose();
  }

  /**
   * 把一个 tile 写进图集，并把内容四周的像素复制到 padding 里。
   *
   * I. 为什么用边缘复制而不是留透明
   *
   * 1. mipmap 每一级都会把邻居平均进来，透明 padding 会让方块边缘变成半透明黑边。
   * 2. 复制边缘像素后，任何一级 mip 读到的都是本 tile 颜色的延伸，接缝不可见。
   * 3. 角落同样按 clamp 处理，因此四个角不会出现"两个方向的边缘不一致"的缺口。
   */
  #blitTile(
    target: Uint8ClampedArray,
    tile: Uint8ClampedArray,
    originX: number,
    originY: number,
  ): void {
    const { tileSize, padding, width } = this;
    const stride = this.#stride;

    for (let py = 0; py < stride; py += 1) {
      const cy = Math.min(tileSize - 1, Math.max(0, py - padding));
      for (let px = 0; px < stride; px += 1) {
        const cx = Math.min(tileSize - 1, Math.max(0, px - padding));
        const source = (cy * tileSize + cx) * 4;
        const destination = ((originY + py) * width + originX + px) * 4;
        target[destination] = tile[source] ?? 0;
        target[destination + 1] = tile[source + 1] ?? 0;
        target[destination + 2] = tile[source + 2] ?? 0;
        target[destination + 3] = tile[source + 3] ?? 0;
      }
    }
  }
}
