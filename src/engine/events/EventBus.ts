/**
 * Typed publish/subscribe bus.
 *
 * I. Why the game needs one
 *
 * Breaking a block has to trigger four unrelated reactions: play a sound, spawn
 * particles, add an item to the inventory and mark the chunk for saving. Wiring
 * those as direct calls would make the interaction code import the audio system,
 * the particle system, the inventory and the save system — five modules that then
 * cannot be tested or reused independently, and a dependency graph that becomes
 * cyclic the moment any of them needs to report back.
 *
 * II. Design constraints
 *
 * 1. Events are declared once in {@link GameEventMap}; publishing an unknown
 *    event name or a payload of the wrong shape is a compile error.
 * 2. Listeners are stored in a `Set` per event, so subscribing is idempotent and
 *    unsubscribing is O(1).
 * 3. `emit` iterates a snapshot when a listener subscribes during dispatch,
 *    which otherwise mutates the set being iterated.
 *
 * @module engine/events/EventBus
 */

import type { BlockId } from '@/world/BlockRegistry';
import { logger } from '@/utils/logger';

/** Payload shapes for every game event. */
export interface GameEventMap {
  /** A block was destroyed by the player. */
  readonly 'block:broken': {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly block: BlockId;
  };
  /** A block was placed by the player. */
  readonly 'block:placed': {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly block: BlockId;
  };
  /** The mining target changed (different block, or nothing under the crosshair). */
  readonly 'mining:target-changed': {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly block: BlockId;
  } | null;
  /** Mining progress advanced; `progress` is in `0..1`. */
  readonly 'mining:progress': {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly block: BlockId;
    readonly progress: number;
  };
  /** An item entity was picked up. */
  readonly 'item:collected': {
    readonly item: BlockId;
    readonly count: number;
  };
  /** A hotbar slot became selected. */
  readonly 'hotbar:selection-changed': { readonly index: number };
  /** A UI-visible notification should be shown. */
  readonly 'ui:notice': {
    readonly text: string;
    readonly tone: 'info' | 'warn' | 'error';
  };
  /** The player moved between chunks; used to drive streaming and the HUD. */
  readonly 'player:chunk-changed': {
    readonly cx: number;
    readonly cz: number;
  };
  /** The player landed after a fall of `distance` blocks. */
  readonly 'player:landed': { readonly distance: number };
  /** The day/night cycle advanced by `deltaSeconds`; fired once per fixed step. */
  readonly 'time:tick': { readonly deltaSeconds: number };
  /** The stage of the day changed (dawn, day, dusk, night). */
  readonly 'time:phase-changed': { readonly phase: 'dawn' | 'day' | 'dusk' | 'night' };
}

/** Event name union. */
export type GameEventName = keyof GameEventMap;

/** Callback for one event. */
export type GameEventListener<K extends GameEventName> = (payload: GameEventMap[K]) => void;

/** Unsubscribe handle returned by {@link EventBus.on}. */
export type Unsubscribe = () => void;

const log = logger.child('events');

export class EventBus {
  readonly #listeners = new Map<GameEventName, Set<(payload: never) => void>>();
  #dispatchDepth = 0;
  #pendingRemovals: (() => void)[] | null = null;

  /**
   * Subscribes to an event.
   *
   * @param event - Event name.
   * @param listener - Callback invoked for every emission.
   * @returns A function that removes the subscription.
   */
  public on<K extends GameEventName>(event: K, listener: GameEventListener<K>): Unsubscribe {
    let set = this.#listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    const stored = listener as (payload: never) => void;
    set.add(stored);

    return () => {
      // Deferred while dispatching so that a listener unsubscribing itself cannot
      // invalidate the iteration in progress.
      if (this.#dispatchDepth > 0 && this.#pendingRemovals !== null) {
        this.#pendingRemovals.push(() => {
          this.#listeners.get(event)?.delete(stored);
        });
        return;
      }
      this.#listeners.get(event)?.delete(stored);
    };
  }

  /** Subscribes for exactly one emission. */
  public once<K extends GameEventName>(event: K, listener: GameEventListener<K>): Unsubscribe {
    // I. The guard matters because unsubscribing during a dispatch is deferred.
    // 1. A listener that re-emits the same event would otherwise still be present
    //    in the snapshot being iterated and fire a second time, so `once` would
    //    deliver twice.
    let fired = false;
    const off = this.on(event, (payload) => {
      if (fired) {
        return;
      }
      fired = true;
      off();
      listener(payload);
    });
    return off;
  }

  /**
   * Emits an event to every current listener.
   *
   * @param event - Event name.
   * @param payload - Event payload.
   */
  public emit<K extends GameEventName>(event: K, payload: GameEventMap[K]): void {
    const set = this.#listeners.get(event);
    if (set === undefined || set.size === 0) {
      return;
    }

    this.#dispatchDepth += 1;
    if (this.#dispatchDepth === 1) {
      this.#pendingRemovals = [];
    }

    try {
      // Snapshot: a listener may subscribe or unsubscribe during dispatch.
      for (const listener of [...set]) {
        // I. A failing listener must not take down the rest of the chain.
        // 1. `block:broken` fans out to audio, particles, inventory and the save
        //    system. If the audio device disappears mid-game and throws, the player
        //    would silently stop collecting drops — a far worse outcome than a
        //    missing sound.
        try {
          (listener as (value: GameEventMap[K]) => void)(payload);
        } catch (error) {
          log.error(`listener for "${event}" threw and was skipped`, error);
        }
      }
    } finally {
      // II. The depth counter must always unwind.
      // 1. Without `finally`, a throwing listener left the depth above zero
      //    forever: every later unsubscribe was deferred into `#pendingRemovals`
      //    and never applied, so closed listeners kept firing and the removal
      //    queue grew without bound.
      this.#dispatchDepth -= 1;
      if (this.#dispatchDepth === 0) {
        const removals = this.#pendingRemovals ?? [];
        this.#pendingRemovals = null;
        for (const remove of removals) {
          remove();
        }
      }
    }
  }

  /** Number of listeners for an event; used by tests. */
  public listenerCount(event: GameEventName): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  /** Drops every subscription; called when a world is unloaded. */
  public clear(): void {
    this.#listeners.clear();
    this.#pendingRemovals = null;
    this.#dispatchDepth = 0;
  }
}
