/**
 * HUD：左下角的状态读数。
 *
 * I. 为什么只读快照
 *
 * 1. 坐标、区块、生物群系、时间分别由玩家、地形与时间系统产生。HUD 不持有
 *    这些系统，只接收一个 `HudSnapshot`，因此可以在 jsdom 里用假数据完整测试。
 * 2. 区块坐标是**调用方算好传进来的**：区块边长属于世界层的约定，UI 不该复制
 *    这个常数，否则改一次区块大小就要在两个层里各改一处。
 *
 * II. 为什么用等宽数字
 *
 * 每帧变化的读数如果用比例字体，数字宽度会跳变，整块文本会左右抖动。数字用
 * `font-variant-numeric: tabular-nums` 固定宽度后读数就稳定了。
 *
 * III. 非模态
 *
 * HUD 整块 `pointer-events: none`，并且贴在左下角，避开屏幕中央的准星区域。
 *
 * @module ui/Hud
 */

import { createEl, setVisible } from './dom';

/** 一帧内需要的世界状态。 */
export interface HudSnapshot {
  /** 玩家世界坐标。 */
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** 玩家所在的区块坐标（由调用方换算）。 */
  readonly chunk: { readonly x: number; readonly z: number };
  /** 生物群系显示名。 */
  readonly biome: string;
  /** 世界时间，单位刻；0 刻为日出，24000 刻为一天。 */
  readonly timeTicks: number;
  /** 朝向标签，例如「北」。省略表示不显示该行。 */
  readonly facing?: string;
  /** 帧率。省略或传 `null` 表示不显示该行。 */
  readonly fps?: number | null;
}

/** HUD 贴靠的角。 */
export type HudPosition = 'bottom-left' | 'top-left';

export interface HudOptions {
  /** 贴靠位置，默认 `bottom-left`（左上角留给调试面板）。 */
  readonly position?: HudPosition;
}

/** 一行读数的取值方式。 */
type HudRowKey = 'position' | 'chunk' | 'biome' | 'time' | 'facing' | 'fps';

const ROWS: readonly { readonly key: HudRowKey; readonly label: string }[] = [
  { key: 'position', label: '坐标' },
  { key: 'chunk', label: '区块' },
  { key: 'biome', label: '群系' },
  { key: 'time', label: '时间' },
  { key: 'facing', label: '朝向' },
  { key: 'fps', label: '帧率' },
];

const ROOT_CLASS = 'hud';

/** 一天的总刻数。 */
export const TICKS_PER_DAY = 24000;

/** 世界时间中"日出"对应的时钟小时数（第 0 刻 = 早上 6 点）。 */
const DAWN_HOUR = 6;

/**
 * 把世界刻换算成 `HH:MM`。
 *
 * @param ticks - 世界时间；允许为负或任意大，内部按一天回绕。
 * @returns 两位小时与两位分钟的时钟文本。
 */
export function formatClock(ticks: number): string {
  const wrapped = ((ticks % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const hours = (wrapped / 1000 + DAWN_HOUR) % 24;
  const wholeHours = Math.floor(hours);
  const minutes = Math.floor((hours - wholeHours) * 60);
  return `${String(wholeHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * 把世界刻换算成"第几天"。
 *
 * @param ticks - 世界时间。
 * @returns 从 1 开始的天数。
 */
export function dayOf(ticks: number): number {
  return Math.max(1, Math.floor(ticks / TICKS_PER_DAY) + 1);
}

/**
 * 把世界刻换算成时段名称。
 *
 * 阈值按 Minecraft 的昼夜比例取值：日出在 0 刻，正午 6000 刻，日落在 12000 刻
 * 左右，13000 刻之后进入夜晚。
 *
 * @param ticks - 世界时间。
 * @returns 中文时段名。
 */
export function timeOfDayLabel(ticks: number): string {
  const wrapped = ((ticks % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  if (wrapped < 1500) {
    return '清晨';
  }
  if (wrapped < 10500) {
    return '白天';
  }
  if (wrapped < 13500) {
    return '黄昏';
  }
  return '夜晚';
}

/** 数值格式化：非有限值显示为破折号，避免出现 `NaN` / `Infinity`。 */
function formatNumber(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

export class Hud {
  readonly #element: HTMLElement;
  readonly #values = new Map<HudRowKey, HTMLElement>();

  /**
   * @param root - 宿主元素，通常是 `#app`。
   * @param options - 贴靠位置。
   */
  public constructor(root: HTMLElement, options: HudOptions = {}) {
    const variant = options.position === 'top-left' ? ` ${ROOT_CLASS}--top-left` : '';
    this.#element = createEl('div', {
      className: `${ROOT_CLASS}${variant}`,
      testId: 'hud',
    });
    this.#element.dataset['position'] = options.position ?? 'bottom-left';

    for (const row of ROWS) {
      const rowElement = createEl('div', {
        className: `${ROOT_CLASS}__row`,
        testId: 'hud-row',
      });
      rowElement.dataset['row'] = row.key;
      rowElement.append(
        createEl('span', { className: `${ROOT_CLASS}__label`, text: row.label }),
        createEl('span', { className: `${ROOT_CLASS}__value`, text: '—' }),
      );
      const value = rowElement.querySelector<HTMLElement>(`.${ROOT_CLASS}__value`);
      if (value !== null) {
        this.#values.set(row.key, value);
      }
      // 可选行先隐藏，等 `update` 拿到数据再出现，避免显示一行空白标签。
      if (row.key === 'facing' || row.key === 'fps') {
        rowElement.hidden = true;
      }
      this.#element.append(rowElement);
    }

    setVisible(this.#element, false);
    root.append(this.#element);
  }

  /** 是否可见。 */
  public get visible(): boolean {
    return !this.#element.hidden;
  }

  /**
   * 用最新快照刷新各行文本。
   *
   * 只改 `textContent`，不重建 DOM：HUD 会被每帧或每几帧调用一次。
   *
   * @param snapshot - 本帧世界状态。
   */
  public update(snapshot: HudSnapshot): void {
    const { position, chunk, biome, timeTicks } = snapshot;

    this.#set(
      'position',
      `${formatNumber(position.x)} ${formatNumber(position.y)} ${formatNumber(position.z)}`,
    );
    this.#set('chunk', `${Math.trunc(chunk.x)}, ${Math.trunc(chunk.z)}`);
    this.#set('biome', biome === '' ? '未知' : biome);
    this.#set(
      'time',
      `${formatClock(timeTicks)} · ${timeOfDayLabel(timeTicks)} · 第 ${dayOf(timeTicks)} 天`,
    );

    const facing = snapshot.facing;
    this.#setOptional('facing', facing === undefined || facing === '' ? null : facing);

    const fps = snapshot.fps;
    this.#setOptional('fps', fps === undefined || fps === null ? null : `${Math.round(fps)} FPS`);
  }

  /** 显示 HUD。 */
  public show(): void {
    setVisible(this.#element, true);
  }

  /** 隐藏 HUD。 */
  public hide(): void {
    setVisible(this.#element, false);
  }

  /** 移除自己创建的子树。幂等。 */
  public dispose(): void {
    this.#values.clear();
    this.#element.remove();
  }

  #set(key: HudRowKey, text: string): void {
    const target = this.#values.get(key);
    if (target !== undefined) {
      target.textContent = text;
    }
  }

  /** 写入可选行：`null` 表示隐藏整行。 */
  #setOptional(key: HudRowKey, text: string | null): void {
    const target = this.#values.get(key);
    if (target === undefined) {
      return;
    }
    target.textContent = text ?? '—';
    const row = target.parentElement;
    if (row !== null) {
      row.hidden = text === null;
    }
  }
}
