/**
 * Game state machine.
 *
 * I. Why a state machine instead of boolean flags
 *
 * The naive version of this game ends up with `isPaused`, `isInMenu`,
 * `inventoryOpen`, `isLoading`, `isSaving` and a dozen combinations that are
 * impossible to reason about — the classic symptom being a HUD that renders while
 * the player is still in the loading screen, or pointer lock being re-acquired
 * after the inventory is opened.
 *
 * A single current state plus an explicit transition table gives one answer to
 * every question: "should the player move?", "should mouse look be active?",
 * "should the inventory be visible?". Illegal transitions are rejected instead of
 * silently producing an inconsistent combination.
 *
 * II. Front-end versus simulation
 *
 * Only `playing` advances player physics and world interaction. Every other state
 * still renders the world (so the pause menu has a backdrop) but freezes the
 * simulation, which is both expected by players and cheap to implement: the loop
 * simply skips the fixed step.
 *
 * @module app/GameState
 */

import type { Unsubscribe } from '@/engine/events/EventBus';

/** Every state the application can be in. */
export type GameStateName =
  | 'boot'
  | 'menu'
  | 'world-loading'
  | 'playing'
  | 'paused'
  | 'inventory'
  | 'settings'
  | 'saving'
  | 'error';

/** Description of a state for the UI layer. */
export interface GameStateInfo {
  readonly name: GameStateName;
  /** Whether user input drives the simulation. */
  readonly interactive: boolean;
  /** Whether the pointer should be locked to the canvas. */
  readonly pointerLocked: boolean;
  /** Whether the world simulation advances. */
  readonly simulates: boolean;
  /** Player facing label, used by the HUD. */
  readonly label: string;
}

const STATE_INFO: Readonly<Record<GameStateName, GameStateInfo>> = {
  boot: {
    name: 'boot',
    interactive: false,
    pointerLocked: false,
    simulates: false,
    label: '正在启动',
  },
  menu: {
    name: 'menu',
    interactive: false,
    pointerLocked: false,
    simulates: false,
    label: '主菜单',
  },
  'world-loading': {
    name: 'world-loading',
    interactive: false,
    pointerLocked: false,
    simulates: false,
    label: '正在生成世界',
  },
  playing: {
    name: 'playing',
    interactive: true,
    pointerLocked: true,
    simulates: true,
    label: '游戏中',
  },
  paused: {
    name: 'paused',
    interactive: false,
    pointerLocked: false,
    simulates: false,
    label: '已暂停',
  },
  inventory: {
    name: 'inventory',
    interactive: false,
    pointerLocked: false,
    simulates: false,
    label: '背包',
  },
  settings: {
    name: 'settings',
    interactive: false,
    pointerLocked: false,
    simulates: false,
    label: '设置',
  },
  saving: {
    name: 'saving',
    interactive: false,
    pointerLocked: false,
    simulates: false,
    label: '正在保存',
  },
  error: {
    name: 'error',
    interactive: false,
    pointerLocked: false,
    simulates: false,
    label: '发生错误',
  },
};

/**
 * Legal transitions.
 *
 * I. Reading the table
 *
 * `settings` is reachable from both `menu` and `paused` and returns to wherever it
 * came from; that "return to origin" rule is the reason the machine records the
 * previous state instead of hard-coding a single back target.
 */
const TRANSITIONS: Readonly<Record<GameStateName, readonly GameStateName[]>> = {
  boot: ['menu', 'error'],
  menu: ['world-loading', 'settings', 'error'],
  'world-loading': ['playing', 'menu', 'error'],
  playing: ['paused', 'inventory', 'saving', 'error'],
  // The pause menu is the hub: settings and quitting both leave from here.
  paused: ['playing', 'settings', 'menu', 'saving', 'error'],
  inventory: ['playing', 'error'],
  // `settings` may only return to the state it was opened from.
  settings: ['menu', 'paused', 'playing', 'error'],
  saving: ['playing', 'paused', 'menu', 'error'],
  error: ['menu'],
};

/** Emitted whenever the state changes. */
export interface GameStateChange {
  readonly from: GameStateName;
  readonly to: GameStateName;
  readonly info: GameStateInfo;
}

export class GameStateMachine {
  #current: GameStateName;
  /** State to return to when the settings screen is dismissed. */
  #settingsReturn: GameStateName = 'menu';
  readonly #listeners = new Set<(change: GameStateChange) => void>();

  public constructor(initial: GameStateName = 'boot') {
    this.#current = initial;
  }

  public get current(): GameStateName {
    return this.#current;
  }

  public get info(): GameStateInfo {
    return STATE_INFO[this.#current];
  }

  /** True when user input should drive the simulation. */
  public get interactive(): boolean {
    return STATE_INFO[this.#current].interactive;
  }

  /** True when the pointer should be locked to the canvas. */
  public get pointerLocked(): boolean {
    return STATE_INFO[this.#current].pointerLocked;
  }

  /**
   * Tests whether a transition is allowed from the current state.
   *
   * @param next - Target state.
   */
  public canTransitionTo(next: GameStateName): boolean {
    return TRANSITIONS[this.#current].includes(next);
  }

  /**
   * Moves to a new state.
   *
   * @param next - Target state.
   * @param options - `silent` suppresses listeners, used while tearing down.
   * @returns True when the transition happened.
   */
  public transition(next: GameStateName, options: { readonly silent?: boolean } = {}): boolean {
    if (next === this.#current) {
      return false;
    }
    if (!this.canTransitionTo(next)) {
      return false;
    }

    // Remember where settings was opened from so "back" is unambiguous.
    if (next === 'settings') {
      this.#settingsReturn = this.#current;
    }

    const from = this.#current;
    this.#current = next;

    if (options.silent !== true) {
      const change: GameStateChange = { from, to: next, info: STATE_INFO[next] };
      for (const listener of [...this.#listeners]) {
        listener(change);
      }
    }
    return true;
  }

  /**
   * Leaves the settings screen, returning to whatever opened it.
   *
   * @returns True when a transition happened.
   */
  public leaveSettings(): boolean {
    if (this.#current !== 'settings') {
      return false;
    }
    const target = this.#settingsReturn === 'settings' ? 'menu' : this.#settingsReturn;
    // `settings` may not list itself as a return target, so the guard above keeps
    // a corrupted value from producing a dead end.
    return this.transition(target);
  }

  /**
   * Subscribes to state changes.
   *
   * @param listener - Callback invoked after each successful transition.
   * @returns Unsubscribe handle.
   */
  public onChange(listener: (change: GameStateChange) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Human readable label for the current state. */
  public get label(): string {
    return STATE_INFO[this.#current].label;
  }
}
