// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BACKPACK_SLOTS, createEmptySnapshot, HOTBAR_SLOTS } from '@/inventory/types';
import { InventoryScreen } from '@/ui/InventoryScreen';

import { createRoot, snapshotOf, stack } from './helpers';

function slotAt(index: number): HTMLElement {
  const slot = document.querySelector<HTMLElement>(
    `[data-testid="inventory-slot"][data-index="${index}"]`,
  );
  if (slot === null) {
    throw new Error(`slot ${index} is missing`);
  }
  return slot;
}

function fire(slot: HTMLElement, type: string, init: MouseEventInit = {}): void {
  slot.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
}

interface Fixture {
  readonly screen: InventoryScreen;
  readonly root: HTMLElement;
  readonly onMove: ReturnType<typeof vi.fn>;
  readonly onSplit: ReturnType<typeof vi.fn>;
  readonly onQuickMove: ReturnType<typeof vi.fn>;
  readonly onClose: ReturnType<typeof vi.fn>;
}

function setup(): Fixture {
  const root = createRoot();
  const onMove = vi.fn();
  const onSplit = vi.fn();
  const onQuickMove = vi.fn();
  const onClose = vi.fn();
  const screen = new InventoryScreen(root, { onMove, onSplit, onQuickMove, onClose });
  return { screen, root, onMove, onSplit, onQuickMove, onClose };
}

describe('InventoryScreen', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders 27 backpack slots and a separate 9-slot hotbar row', () => {
    const { screen } = setup();

    expect(screen.visible).toBe(false);
    expect(document.querySelector('[data-testid="inventory-screen"]')?.hasAttribute('hidden')).toBe(
      true,
    );

    const backpack = document.querySelector('[data-testid="inventory-grid"]');
    const hotbar = document.querySelector('[data-testid="inventory-hotbar"]');
    expect(backpack?.querySelectorAll('[data-testid="inventory-slot"]')).toHaveLength(
      BACKPACK_SLOTS,
    );
    expect(hotbar?.querySelectorAll('[data-testid="inventory-slot"]')).toHaveLength(HOTBAR_SLOTS);

    // 界面把物品栏放上面、快捷栏放下面，但索引用的是快照索引。
    expect(
      backpack?.querySelector('[data-testid="inventory-slot"]')?.getAttribute('data-index'),
    ).toBe(String(HOTBAR_SLOTS));
    expect(
      hotbar?.querySelector('[data-testid="inventory-slot"]')?.getAttribute('data-index'),
    ).toBe('0');
  });

  it('picks a stack up and puts it down on the next click', () => {
    const { screen, onMove } = setup();
    screen.show();
    screen.update(snapshotOf({ 9: stack(1, 32), 10: stack(3, 1) }, 0));

    expect(slotAt(9).dataset['item']).toBe('1');
    expect(slotAt(9).querySelector('.slot-count')?.textContent).toBe('32');

    fire(slotAt(9), 'click');
    expect(screen.pickedIndex).toBe(9);
    expect(slotAt(9).classList.contains('slot--picked')).toBe(true);
    expect(document.querySelector('[data-testid="inventory-status"]')?.textContent).toContain(
      '已拾取 石头 ×32',
    );
    expect(onMove).not.toHaveBeenCalled();

    fire(slotAt(10), 'click');
    expect(onMove).toHaveBeenCalledWith(9, 10);
    expect(screen.pickedIndex).toBeNull();
    expect(slotAt(9).classList.contains('slot--picked')).toBe(false);
  });

  it('cancels the pick when the same slot is clicked twice', () => {
    const { screen, onMove } = setup();
    screen.show();
    screen.update(snapshotOf({ 12: stack(2, 4) }, 0));

    fire(slotAt(12), 'click');
    fire(slotAt(12), 'click');

    expect(screen.pickedIndex).toBeNull();
    expect(onMove).not.toHaveBeenCalled();
  });

  it('ignores clicks on empty slots', () => {
    const { screen, onMove } = setup();
    screen.show();
    screen.update(snapshotOf({}, 0));

    fire(slotAt(20), 'click');

    expect(screen.pickedIndex).toBeNull();
    expect(onMove).not.toHaveBeenCalled();
  });

  it('splits a stack with the right mouse button', () => {
    const { screen, onSplit } = setup();
    screen.show();
    screen.update(snapshotOf({ 9: stack(3, 16), 14: stack(3, 1) }, 0));

    fire(slotAt(9), 'contextmenu');
    expect(screen.pickedIndex).toBe(9);

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    slotAt(14).dispatchEvent(event);
    expect(onSplit).toHaveBeenCalledWith(9, 14);
    // 系统右键菜单必须被屏蔽，否则每次分堆都会弹出浏览器菜单。
    expect(event.defaultPrevented).toBe(true);
    expect(screen.pickedIndex).toBeNull();
  });

  it('quick-moves with shift+click and never touches an empty slot', () => {
    const { screen, onQuickMove } = setup();
    screen.show();
    screen.update(snapshotOf({ 11: stack(9, 64) }, 0));

    fire(slotAt(11), 'click', { shiftKey: true });
    expect(onQuickMove).toHaveBeenCalledWith(11);

    fire(slotAt(30), 'click', { shiftKey: true });
    expect(onQuickMove).toHaveBeenCalledTimes(1);
  });

  it('supports the same gestures from the keyboard', () => {
    const { screen, onMove, onQuickMove } = setup();
    screen.show();
    screen.update(snapshotOf({ 9: stack(4, 3), 10: stack(4, 1) }, 0));

    slotAt(9).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(screen.pickedIndex).toBe(9);

    slotAt(10).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onMove).toHaveBeenCalledWith(9, 10);

    slotAt(10).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(onQuickMove).toHaveBeenCalledWith(10);
  });

  it('reports usage, selected hotbar slot and cleared slots from the snapshot', () => {
    const { screen } = setup();
    screen.show();
    screen.update(snapshotOf({ 0: stack(1, 1), 9: stack(2, 1), 10: stack(3, 1) }, 3));

    expect(document.querySelector('[data-testid="inventory-usage"]')?.textContent).toBe('2/27');
    expect(slotAt(3).classList.contains('slot--selected')).toBe(true);
    expect(slotAt(0).classList.contains('slot--selected')).toBe(false);

    screen.update(snapshotOf({ 0: stack(1, 1) }, 0));
    expect(slotAt(9).dataset['empty']).toBe('true');
    expect(slotAt(9).dataset['item']).toBeUndefined();
  });

  it('drops the pick when the source slot empties underneath it', () => {
    const { screen } = setup();
    screen.show();
    screen.update(snapshotOf({ 9: stack(1, 5) }, 0));

    fire(slotAt(9), 'click');
    expect(screen.pickedIndex).toBe(9);

    // 外部逻辑（例如快捷键消耗、掉落拾取）把格子清空了。
    screen.update(createEmptySnapshot());

    expect(screen.pickedIndex).toBeNull();
    expect(slotAt(9).classList.contains('slot--picked')).toBe(false);
    expect(document.querySelector('[data-testid="inventory-status"]')?.textContent).toContain(
      '点击格子拾取整组',
    );
  });

  it('shows a hover tooltip with the item name and count', () => {
    const { screen } = setup();
    screen.show();
    screen.update(snapshotOf({ 9: stack(19, 7) }, 0));

    const tooltip = document.querySelector<HTMLElement>('[data-testid="inventory-tooltip"]');
    expect(tooltip?.hidden).toBe(true);

    fire(slotAt(9), 'mouseover');
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toContain('钻石矿石');
    expect(tooltip?.textContent).toContain('×7');

    fire(slotAt(9), 'mouseout');
    expect(tooltip?.hidden).toBe(true);
  });

  it('keeps the tooltip hidden over empty slots', () => {
    const { screen } = setup();
    screen.show();
    screen.update(snapshotOf({}, 0));

    fire(slotAt(9), 'mouseover');
    expect(document.querySelector<HTMLElement>('[data-testid="inventory-tooltip"]')?.hidden).toBe(
      true,
    );
  });

  it('closes through its own button and notifies the caller', () => {
    const { screen, onClose } = setup();
    screen.show();

    document.querySelector<HTMLButtonElement>('[data-testid="inventory-close"]')?.click();

    expect(screen.visible).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('removes its subtree on dispose and ignores later updates', () => {
    const { screen, root } = setup();
    screen.show();
    screen.dispose();
    screen.dispose();

    expect(root.querySelector('[data-testid="inventory-screen"]')).toBeNull();

    screen.update(snapshotOf({ 9: stack(1, 1) }, 0));
    expect(document.querySelector('[data-testid="inventory-slot"][data-item]')).toBeNull();
  });
});
