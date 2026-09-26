// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { applyItemVisual, createItemIcon, ITEM_ICON_CLASS } from '@/ui/itemIcon';
import { toCssColor, visualFor } from '@/ui/itemVisuals';

describe('itemVisuals', () => {
  it('maps block ids onto the palette used by the world', () => {
    expect(visualFor(1).displayName).toBe('石头');
    expect(visualFor(1).baseColor).toBe(0x8a8a8f);
    expect(visualFor(3).displayName).toBe('草方块');
    expect(visualFor(3).baseColor).toBe(0x6cae4a);
    expect(visualFor(3).pattern).toBe('grass');
    expect(visualFor(19).displayName).toBe('钻石矿石');
    expect(visualFor(19).pattern).toBe('ore');
  });

  it('falls back to a neutral visual for ids it does not know', () => {
    const unknown = visualFor(200);
    expect(unknown.displayName).toBe('未知方块');
    expect(unknown.pattern).toBe('noise');
    expect(visualFor(-1)).toBe(unknown);
    expect(visualFor(1.5)).toBe(unknown);
    expect(visualFor(Number.NaN)).toBe(unknown);
  });

  it('formats colours as six-digit CSS hex values', () => {
    expect(toCssColor(0x6cae4a)).toBe('#6cae4a');
    expect(toCssColor(0x0000ff)).toBe('#0000ff');
    expect(toCssColor(0xffffff)).toBe('#ffffff');
    expect(toCssColor(0)).toBe('#000000');
  });
});

describe('itemIcon', () => {
  it('creates an icon carrying the colour pair and the pattern class', () => {
    const icon = createItemIcon(3);

    expect(icon.className).toBe(`${ITEM_ICON_CLASS} ${ITEM_ICON_CLASS}--grass`);
    expect(icon.style.getPropertyValue('--item-color')).toBe('#6cae4a');
    expect(icon.style.getPropertyValue('--item-accent')).toBe('#86c95c');
    expect(icon.dataset['item']).toBe('3');
    expect(icon.getAttribute('aria-label')).toBe('草方块');
  });

  it('recolours an existing icon in place without replacing the node', () => {
    const icon = createItemIcon(1);
    applyItemVisual(icon, 21);

    expect(icon.className).toContain(`${ITEM_ICON_CLASS}--noise`);
    expect(icon.style.getPropertyValue('--item-color')).toBe('#9c5744');
    expect(icon.dataset['itemName']).toBe('砖块');
  });
});
