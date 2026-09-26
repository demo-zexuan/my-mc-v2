/**
 * Developer overlay.
 *
 * I. Why a hand-written panel instead of `stats.js` plus `lil-gui`
 *
 * 1. The panel has to display engine metrics that no generic library knows
 *    about (loaded chunk count, render distance, world seed, current chunk
 *    coordinates). Wiring those into `stats.js` costs the same effort as
 *    rendering them directly, while adding two dependencies.
 * 2. Direct DOM control lets the panel reuse the game's CSS variables, so it
 *    stays visually consistent with the rest of the HUD.
 *
 * II. Cost
 *
 * Rows are created once and only their `textContent` is updated afterwards.
 * Updating text is the cheapest possible DOM mutation, which matters because
 * this runs every frame.
 *
 * @module debug/DebugOverlay
 */

/** A single metric row. */
export interface DebugRow {
  /** Stable key used by {@link DebugOverlay.set}. */
  readonly key: string;
  /** Human readable label shown on the left. */
  readonly label: string;
}

const DEFAULT_ROWS: readonly DebugRow[] = [
  { key: 'fps', label: 'FPS' },
  { key: 'frameTime', label: 'Frame' },
  { key: 'drawCalls', label: 'Draw calls' },
  { key: 'triangles', label: 'Triangles' },
];

export interface DebugOverlayOptions {
  /** Extra rows appended after the default engine rows. */
  readonly rows?: readonly DebugRow[];
  /** Initial visibility. Defaults to true. */
  readonly visible?: boolean;
}

export class DebugOverlay {
  readonly #root: HTMLElement;
  readonly #rowElements = new Map<string, HTMLElement>();
  #visible: boolean;

  public constructor(root: HTMLElement, options: DebugOverlayOptions = {}) {
    this.#visible = options.visible ?? true;
    this.#root = document.createElement('div');
    this.#root.className = 'debug-overlay';
    this.#root.dataset['testid'] = 'debug-overlay';

    for (const row of [...DEFAULT_ROWS, ...(options.rows ?? [])]) {
      const line = document.createElement('div');
      line.className = 'debug-overlay__row';
      line.dataset['testid'] = `debug-row-${row.key}`;

      const label = document.createElement('span');
      label.className = 'debug-overlay__label';
      label.textContent = row.label;

      const value = document.createElement('span');
      value.className = 'debug-overlay__value';
      value.textContent = '—';

      line.append(label, value);
      this.#root.append(line);
      this.#rowElements.set(row.key, value);
    }

    root.append(this.#root);
    this.#applyVisibility();
  }

  public get visible(): boolean {
    return this.#visible;
  }

  /** Writes a value into a row; unknown keys are ignored on purpose. */
  public set(key: string, value: string): void {
    const element = this.#rowElements.get(key);
    if (element !== undefined) {
      element.textContent = value;
    }
  }

  /** Convenience wrapper that formats a number to one decimal place. */
  public setNumber(key: string, value: number, suffix = ''): void {
    this.set(key, `${value.toFixed(1)}${suffix}`);
  }

  public toggle(visible?: boolean): void {
    this.#visible = visible ?? !this.#visible;
    this.#applyVisibility();
  }

  public dispose(): void {
    this.#root.remove();
    this.#rowElements.clear();
  }

  #applyVisibility(): void {
    this.#root.hidden = !this.#visible;
  }
}
