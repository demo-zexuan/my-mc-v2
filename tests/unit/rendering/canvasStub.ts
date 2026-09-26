/**
 * 图集单测用的 2D 上下文替身。
 *
 * I. 为什么不能直接用 `tests/support/canvas.ts`
 *
 * 1. 那份替身只实现 `fillStyle` + `fillRect`，够 checker 贴图使用，但图集走的是
 *    `createImageData` / `putImageData` 路径：一次上传 66 个 tile，比逐像素 fillRect
 *    快一个数量级。
 * 2. 这里把 `putImageData` 收到的图像记录下来，测试就可以直接断言"padding 是否复制了
 *    边缘像素"这种只有看图集原始像素才能验证的性质。
 *
 * @module tests/unit/rendering/canvasStub
 */

/** 最小 canvas 2D 替身，只记录被上传的 ImageData。 */
export interface Canvas2DStub {
  /** 每次 `putImageData` 的图像，按调用顺序。 */
  readonly images: ImageData[];
  /** `fillRect` 的调用次数；图集路径应为 0。 */
  fills: number;
}

/**
 * 在 `HTMLCanvasElement.prototype` 上装一个只支持图集路径的 2D 上下文。
 *
 * @returns 记录器；重复调用会重置记录。
 */
export function installCanvas2DStub(): Canvas2DStub {
  const recorder: Canvas2DStub = { images: [], fills: 0 };

  const getContext = function (this: HTMLCanvasElement, contextId: string): unknown {
    if (contextId !== '2d') {
      return null;
    }

    const state = { fillStyle: '#000000' };
    return {
      get fillStyle(): string {
        return state.fillStyle;
      },
      set fillStyle(value: string) {
        state.fillStyle = value;
      },
      createImageData: (width: number, height: number): ImageData =>
        ({
          width,
          height,
          data: new Uint8ClampedArray(width * height * 4),
          colorSpace: 'srgb',
        }) as unknown as ImageData,
      putImageData: (image: ImageData): void => {
        recorder.images.push(image);
      },
      getImageData: (): ImageData =>
        ({
          width: 1,
          height: 1,
          data: new Uint8ClampedArray(4),
          colorSpace: 'srgb',
        }) as unknown as ImageData,
      fillRect: (): void => {
        recorder.fills += 1;
      },
      clearRect: (): void => {},
      drawImage: (): void => {},
    };
  };

  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: getContext,
  });

  return recorder;
}
