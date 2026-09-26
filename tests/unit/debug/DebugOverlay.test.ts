// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { DebugOverlay } from '@/debug/DebugOverlay';

describe('DebugOverlay', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.append(root);
  });

  it('creates the default engine rows plus the extra world rows', () => {
    const overlay = new DebugOverlay(root, {
      rows: [{ key: 'seed', label: 'Seed' }],
    });

    expect(root.querySelector('[data-testid="debug-row-fps"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="debug-row-drawCalls"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="debug-row-seed"]')).not.toBeNull();
    overlay.dispose();
  });

  it('writes values into an existing row', () => {
    const overlay = new DebugOverlay(root);
    overlay.set('fps', '60');
    overlay.setNumber('screenPercent', 12.34, '%');

    expect(root.querySelector('[data-testid="debug-row-fps"]')?.textContent).toContain('60');
    expect(root.querySelector('[data-testid="debug-row-drawCalls"]')).not.toBeNull();
    overlay.dispose();
  });

  it('ignores writes to unknown rows instead of creating stray DOM', () => {
    const overlay = new DebugOverlay(root);
    const before = root.querySelectorAll('.debug-overlay__row').length;

    overlay.set('does-not-exist', '42');

    expect(root.querySelectorAll('.debug-overlay__row')).toHaveLength(before);
    overlay.dispose();
  });

  it('toggles visibility', () => {
    const overlay = new DebugOverlay(root, { visible: true });
    expect(overlay.visible).toBe(true);

    overlay.toggle();
    expect(overlay.visible).toBe(false);
    expect(root.querySelector<HTMLElement>('.debug-overlay')?.hidden).toBe(true);

    overlay.toggle(true);
    expect(overlay.visible).toBe(true);
    overlay.dispose();
  });

  it('removes its subtree on dispose', () => {
    const overlay = new DebugOverlay(root);
    overlay.dispose();

    expect(root.querySelector('.debug-overlay')).toBeNull();
  });
});
