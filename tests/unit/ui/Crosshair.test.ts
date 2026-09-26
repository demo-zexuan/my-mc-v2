// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { Crosshair } from '@/ui/Crosshair';

import { createRoot } from './helpers';

describe('Crosshair', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the four arms and starts hidden', () => {
    const crosshair = new Crosshair(createRoot());

    const element = document.querySelector<HTMLElement>('[data-testid="crosshair"]');
    expect(element).not.toBeNull();
    expect(element?.hidden).toBe(true);
    expect(element?.dataset['mode']).toBe('default');
    expect(element?.querySelectorAll('.crosshair__segment')).toHaveLength(4);
    expect(crosshair.mode).toBe('default');
    expect(crosshair.visible).toBe(false);
  });

  it('switches to the interactive form when aiming at a usable block', () => {
    const crosshair = new Crosshair(createRoot());
    crosshair.show();
    crosshair.update({ interactable: true, label: '石头' });

    const element = document.querySelector<HTMLElement>('[data-testid="crosshair"]');
    expect(crosshair.mode).toBe('interactive');
    expect(element?.classList.contains('crosshair--interactive')).toBe(true);
    expect(element?.dataset['mode']).toBe('interactive');

    const label = document.querySelector<HTMLElement>('[data-testid="crosshair-label"]');
    expect(label?.hidden).toBe(false);
    expect(label?.textContent).toBe('石头');
  });

  it('falls back to the default form and hides the label when aiming at air', () => {
    const crosshair = new Crosshair(createRoot());
    crosshair.show();
    crosshair.update({ interactable: true, label: '泥土' });
    crosshair.update({ interactable: false });

    const element = document.querySelector<HTMLElement>('[data-testid="crosshair"]');
    expect(element?.dataset['mode']).toBe('default');
    expect(element?.classList.contains('crosshair--interactive')).toBe(false);

    const label = document.querySelector<HTMLElement>('[data-testid="crosshair-label"]');
    expect(label?.hidden).toBe(true);
    expect(label?.textContent).toBe('');
  });

  it('toggles visibility without touching the stored mode', () => {
    const crosshair = new Crosshair(createRoot());
    crosshair.setMode('interactive');
    crosshair.show();
    expect(crosshair.visible).toBe(true);

    crosshair.hide();
    expect(crosshair.visible).toBe(false);
    expect(crosshair.mode).toBe('interactive');
  });

  it('removes its subtree on dispose and stays idempotent', () => {
    const root = createRoot();
    const crosshair = new Crosshair(root);
    crosshair.dispose();
    crosshair.dispose();

    expect(root.querySelector('[data-testid="crosshair"]')).toBeNull();
  });
});
