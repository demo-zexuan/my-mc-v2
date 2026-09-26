/**
 * Integration test support: a minimal 2D canvas shim for jsdom.
 *
 * I. Why a shim is required
 *
 * 1. jsdom implements `HTMLCanvasElement` but not its rendering contexts; every
 *    `getContext('2d')` call returns `null` and prints a "Not implemented"
 *    warning. Scene assembly depends on being able to draw a procedural texture,
 *    so without a shim the integration test could not exercise real code.
 * 2. Three.js only hands the canvas element to WebGL as an image source, so a
 *    recorder that implements `fillRect`/`fillStyle` is sufficient and keeps the
 *    test free of a native canvas dependency.
 *
 * @module tests/support/canvas
 */

/** Records the fill operations the texture generator performs. */
export interface Canvas2DRecorder {
  readonly fills: { readonly style: string; readonly x: number; readonly y: number }[];
}

/**
 * Installs a 2D context stub on `HTMLCanvasElement`.
 *
 * @returns A recorder exposing every `fillRect` call for assertions.
 */
export function installCanvas2DStub(): Canvas2DRecorder {
  const recorder: Canvas2DRecorder = { fills: [] };

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
      fillRect: (x: number, y: number, _width: number, _height: number): void => {
        recorder.fills.push({ style: state.fillStyle, x, y });
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

/**
 * Converts a recorder back into a rectangular grid of colour strings.
 *
 * Used to assert that neighbouring checker cells actually received different
 * colours, which is the property the visual result depends on.
 *
 * @param recorder - Recorder returned by {@link installCanvas2DStub}.
 * @param size - Texture edge length in pixels (cells are square).
 * @param cells - Number of cells along one axis.
 * @returns Row-major grid of the colour applied to each cell origin.
 */
export function readCheckerGrid(
  recorder: Canvas2DRecorder,
  size: number,
  cells: number,
): string[][] {
  const grid: string[][] = [];
  for (let row = 0; row < cells; row += 1) {
    grid.push(new Array<string>(cells).fill(''));
  }

  const cellSize = size / cells;
  for (const fill of recorder.fills) {
    const column = Math.round(fill.x / cellSize);
    const row = Math.round(fill.y / cellSize);
    const target = grid[row];
    if (target !== undefined && column >= 0 && column < cells) {
      target[column] = fill.style;
    }
  }
  return grid;
}
