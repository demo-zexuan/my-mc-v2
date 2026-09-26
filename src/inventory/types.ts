/**
 * Inventory contract.
 *
 * I. Why the interface is frozen before the implementation
 *
 * Three systems meet at the inventory: the interaction layer deposits drops, the
 * HUD renders the hotbar, and the save system serialises the whole thing. If each
 * of them knew the concrete class, any refactor of the storage layout would break
 * all three. The interface below is the only thing they are allowed to depend on.
 *
 * II. Why a stack is a value, not a mutable object
 *
 * `ItemStack` is readonly. Merging, splitting and consuming therefore produce new
 * values instead of mutating in place, which removes an entire class of bug where
 * a UI panel keeps a reference to a stack that the game later empties. The cost —
 * one small allocation per inventory operation — is irrelevant next to the
 * per-frame work of a voxel renderer.
 *
 * @module inventory/types
 */

import type { BlockId } from '@/world/BlockRegistry';

/** Maximum number of items in one slot. */
export const MAX_STACK_SIZE = 64;

/** Number of always-visible hotbar slots. */
export const HOTBAR_SLOTS = 9;

/** Number of additional backpack slots. */
export const BACKPACK_SLOTS = 27;

/** Total slot count, hotbar first. */
export const INVENTORY_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

/** One stack of identical items. */
export interface ItemStack {
  readonly item: BlockId;
  /** Always `1 .. MAX_STACK_SIZE`. */
  readonly count: number;
}

/** Immutable view of the inventory, safe to hand to the UI. */
export interface InventorySnapshot {
  /** Slot contents, hotbar slots first, `null` for empty. */
  readonly slots: readonly (ItemStack | null)[];
  /** Index of the selected hotbar slot, `0 .. HOTBAR_SLOTS - 1`. */
  readonly selected: number;
}

/** Mutable inventory surface used by gameplay and UI code. */
export interface Inventory {
  /** Total number of slots. */
  readonly size: number;
  /** Index of the selected hotbar slot. */
  readonly selectedIndex: number;

  /**
   * Reads a slot.
   *
   * @param index - Slot index.
   * @returns The stack, or `null` when the slot is empty or out of range.
   */
  getSlot(index: number): ItemStack | null;

  /**
   * Replaces a slot's contents.
   *
   * @param index - Slot index.
   * @param stack - New contents, or `null` to clear.
   */
  setSlot(index: number, stack: ItemStack | null): void;

  /**
   * Adds items, filling partial stacks before empty slots.
   *
   * @param item - Item id.
   * @param count - Number of items to add.
   * @returns The number of items that did **not** fit, so the caller can decide
   *          whether to leave a drop on the ground or report a full inventory.
   */
  add(item: BlockId, count: number): number;

  /**
   * Returns the contents of a slot without changing it.
   *
   * @param index - Slot index.
   */
  peek(index: number): ItemStack | null;

  /** The currently selected stack, or `null`. */
  selectedStack(): ItemStack | null;

  /**
   * Removes items from the selected slot.
   *
   * @param count - Number of items to remove; defaults to one.
   * @returns The removed stack, or `null` when the slot was empty.
   */
  consumeSelected(count?: number): ItemStack | null;

  /**
   * Selects a hotbar slot.
   *
   * @param index - Index in `0 .. HOTBAR_SLOTS - 1`; values are wrapped so that
   *        mouse-wheel scrolling can pass any integer.
   */
  select(index: number): void;

  /**
   * Moves items between two slots, merging when both hold the same item.
   *
   * @param from - Source slot index.
   * @param to - Destination slot index.
   */
  moveSlot(from: number, to: number): void;

  /**
   * Splits a slot in half, moving one half into an empty slot.
   *
   * @param from - Source slot index.
   * @param to - Destination slot index.
   */
  splitSlot(from: number, to: number): void;

  /**
   * Discards a whole slot.
   *
   * @param index - Slot index.
   * @returns The discarded stack, so the caller can spawn it as a drop.
   */
  dropSlot(index: number): ItemStack | null;

  /** Index of the first slot holding `item`, or `-1`. */
  findItem(item: BlockId): number;

  /** Total number of `item` held across every slot. */
  countItem(item: BlockId): number;

  /** True when no slot holds anything. */
  isEmpty(): boolean;

  /** Copy of the current contents. */
  snapshot(): InventorySnapshot;

  /**
   * Replaces the whole inventory, typically after loading a save.
   *
   * @param snapshot - Previously captured state.
   */
  restore(snapshot: InventorySnapshot): void;

  /** Empties every slot. */
  clear(): void;
}

/**
 * Creates an empty snapshot.
 *
 * @returns A snapshot with every slot empty and the first hotbar slot selected.
 */
export function createEmptySnapshot(): InventorySnapshot {
  return {
    slots: new Array<ItemStack | null>(INVENTORY_SLOTS).fill(null),
    selected: 0,
  };
}
