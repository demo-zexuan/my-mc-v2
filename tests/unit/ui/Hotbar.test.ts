// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HOTBAR_SLOTS } from '@/inventory/types';
import { Hotbar } from '@/ui/Hotbar';

import { createRoot, snapshotOf, stack } from './helpers';

function slots(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="hotbar-slot"]')];
}

function pressKey(code: string, init: KeyboardEventInit = {}): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, ...init }));
}

function rollWheel(deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, cancelable: true, bubbles: true });
  window.dispatchEvent(event);
  return event;
}

describe('Hotbar', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders nine slots and starts hidden', () => {
    const hotbar = new Hotbar(createRoot());

    expect(slots()).toHaveLength(HOTBAR_SLOTS);
    expect(document.querySelector<HTMLElement>('[data-testid="hotbar"]')?.hidden).toBe(true);
    expect(hotbar.slotCount).toBe(HOTBAR_SLOTS);
    expect(hotbar.selectedIndex).toBe(0);
    expect(slots()[0]?.classList.contains('hotbar__slot--selected')).toBe(true);
    expect(slots()[0]?.dataset['empty']).toBe('true');
  });

  it('paints icons, counts and the selected item label from the snapshot', () => {
    const hotbar = new Hotbar(createRoot());
    hotbar.show();
    hotbar.update(snapshotOf({ 0: stack(3, 64), 4: stack(1, 1) }, 4));

    expect(slots()[0]?.dataset['item']).toBe('3');
    expect(slots()[0]?.dataset['count']).toBe('64');
    expect(slots()[0]?.querySelector('.slot-count')?.textContent).toBe('64');
    expect(slots()[0]?.querySelector<HTMLElement>('.item-icon')?.dataset['itemName']).toBe(
      '草方块',
    );

    // 单件物品不显示数量，避免每格都挂一个 "1"。
    expect(slots()[4]?.dataset['item']).toBe('1');
    expect(slots()[4]?.querySelector('.slot-count')?.textContent).toBe('');
    expect(slots()[4]?.classList.contains('hotbar__slot--selected')).toBe(true);
    expect(slots()[0]?.classList.contains('hotbar__slot--selected')).toBe(false);

    const label = document.querySelector<HTMLElement>('[data-testid="hotbar-label"]');
    expect(label?.hidden).toBe(false);
    expect(label?.textContent).toBe('石头');
  });

  it('hides the label when the selected slot is empty', () => {
    const hotbar = new Hotbar(createRoot());
    hotbar.show();
    hotbar.update(snapshotOf({ 0: stack(3, 64) }, 0));
    hotbar.update(snapshotOf({ 0: stack(3, 64) }, 1));

    expect(document.querySelector<HTMLElement>('[data-testid="hotbar-label"]')?.hidden).toBe(true);
  });

  it('reports digit keys 1-9 as zero-based indexes', () => {
    const onSelect = vi.fn<(index: number) => void>();
    const hotbar = new Hotbar(createRoot(), { onSelect });
    hotbar.show();

    pressKey('Digit4');
    expect(onSelect).toHaveBeenLastCalledWith(3);

    pressKey('Numpad9');
    expect(onSelect).toHaveBeenLastCalledWith(8);
  });

  it('ignores keys while hidden, while disabled, or with modifiers', () => {
    const onSelect = vi.fn<(index: number) => void>();
    const hotbar = new Hotbar(createRoot(), { onSelect });

    pressKey('Digit4');
    expect(onSelect).not.toHaveBeenCalled();

    hotbar.show();
    pressKey('Digit4', { ctrlKey: true });
    pressKey('Digit4', { repeat: true });
    pressKey('KeyE');
    expect(onSelect).not.toHaveBeenCalled();

    hotbar.setInputEnabled(false);
    pressKey('Digit4');
    expect(onSelect).not.toHaveBeenCalled();

    hotbar.setInputEnabled(true);
    pressKey('Digit4');
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('wraps selection through select() and step()', () => {
    const onSelect = vi.fn<(index: number) => void>();
    const hotbar = new Hotbar(createRoot(), { onSelect });
    hotbar.show();
    hotbar.update(snapshotOf({}, 0));

    hotbar.step(-1);
    expect(onSelect).toHaveBeenLastCalledWith(8);

    hotbar.select(99);
    expect(onSelect).toHaveBeenLastCalledWith(0);

    hotbar.select(2.7);
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });

  it('switches one slot per wheel gesture and blocks page scrolling', () => {
    const onSelect = vi.fn<(index: number) => void>();
    const hotbar = new Hotbar(createRoot(), { onSelect });
    hotbar.show();
    hotbar.update(snapshotOf({}, 5));

    const event = rollWheel(120);
    expect(onSelect).toHaveBeenLastCalledWith(6);
    expect(event.defaultPrevented).toBe(true);

    // 触摸板会产生一连串小 delta，累计到阈值前不应切换。
    onSelect.mockClear();
    rollWheel(10);
    rollWheel(10);
    expect(onSelect).not.toHaveBeenCalled();

    rollWheel(-120);
    // 回调不会自己改内部选中格，因此基准仍是 update() 给出的 5。
    expect(onSelect).toHaveBeenLastCalledWith(4);
  });

  it('keeps unchanged slots and their icons in place', () => {
    const hotbar = new Hotbar(createRoot());
    hotbar.update(snapshotOf({ 0: stack(3, 64), 1: stack(1, 64) }, 0));
    const iconBefore = slots()[0]?.querySelector('.item-icon');
    const otherIconBefore = slots()[1]?.querySelector('.item-icon');

    hotbar.update(snapshotOf({ 0: stack(3, 63), 1: stack(1, 64) }, 0));

    expect(slots()[0]?.querySelector('.slot-count')?.textContent).toBe('63');
    // 数量变化不该重建图标节点：重绘会让悬停提示闪烁。
    expect(slots()[0]?.querySelector('.item-icon')).toBe(iconBefore);
    expect(slots()[1]?.querySelector('.item-icon')).toBe(otherIconBefore);
  });

  it('clears a slot when the snapshot empties it', () => {
    const hotbar = new Hotbar(createRoot());
    hotbar.update(snapshotOf({ 2: stack(4, 5) }, 0));
    expect(slots()[2]?.dataset['empty']).toBe('false');

    hotbar.update(snapshotOf({}, 0));
    expect(slots()[2]?.dataset['empty']).toBe('true');
    expect(slots()[2]?.dataset['item']).toBeUndefined();
    expect(slots()[2]?.querySelector<HTMLElement>('.item-icon')?.hidden).toBe(true);
  });

  it('stops listening after dispose', () => {
    const root = createRoot();
    const onSelect = vi.fn<(index: number) => void>();
    const hotbar = new Hotbar(root, { onSelect });
    hotbar.show();

    hotbar.dispose();
    expect(root.querySelector('[data-testid="hotbar"]')).toBeNull();

    pressKey('Digit4');
    rollWheel(120);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
