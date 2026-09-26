// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MainMenu } from '@/ui/MainMenu';

import { createRoot } from './helpers';

function element<T extends HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

describe('MainMenu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the actions, the seed field and the version, hidden by default', () => {
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld: vi.fn(),
      onSettings: vi.fn(),
      onBack: vi.fn(),
      version: '0.1.0',
    });

    expect(menu.visible).toBe(false);
    expect(element('main-menu')?.hidden).toBe(true);
    expect(element<HTMLButtonElement>('main-menu-start')?.textContent).toBe('开始游戏');
    expect(element<HTMLButtonElement>('main-menu-new-world')?.textContent).toBe('新建世界');
    expect(element<HTMLButtonElement>('main-menu-settings')?.textContent).toBe('设置');
    expect(element<HTMLButtonElement>('main-menu-back')?.hidden).toBe(false);
    expect(element<HTMLInputElement>('main-menu-seed')?.placeholder).toBe('留空则随机');
    expect(element('main-menu-version')?.textContent).toBe('版本 v0.1.0');
    expect(element('main-menu-controls')?.textContent).toContain('WASD');
  });

  it('notifies the caller exactly once per open and per close', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld: vi.fn(),
      onSettings: vi.fn(),
      onOpen,
      onClose,
    });

    menu.show();
    menu.show();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(menu.visible).toBe(true);

    menu.hide();
    menu.hide();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(menu.visible).toBe(false);
  });

  it('starts the previous world through the primary action', () => {
    const onStart = vi.fn();
    const menu = new MainMenu(createRoot(), {
      onStart,
      onNewWorld: vi.fn(),
      onSettings: vi.fn(),
    });
    menu.show();

    element<HTMLButtonElement>('main-menu-start')?.click();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('passes a trimmed seed to the world generator', () => {
    const onNewWorld = vi.fn<(seed: string) => void>();
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld,
      onSettings: vi.fn(),
    });
    menu.show();

    const input = element<HTMLInputElement>('main-menu-seed');
    if (input === null) {
      throw new Error('seed input missing');
    }
    input.value = '  我的世界 42  ';
    element<HTMLButtonElement>('main-menu-new-world')?.click();

    expect(onNewWorld).toHaveBeenCalledWith('我的世界 42');
  });

  it('treats an empty seed as "pick one at random"', () => {
    const onNewWorld = vi.fn<(seed: string) => void>();
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld,
      onSettings: vi.fn(),
    });
    menu.show();

    element<HTMLButtonElement>('main-menu-new-world')?.click();
    expect(onNewWorld).toHaveBeenCalledWith('');
  });

  it('submits on Enter inside the seed field', () => {
    const onNewWorld = vi.fn<(seed: string) => void>();
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld,
      onSettings: vi.fn(),
    });
    menu.show();

    const input = element<HTMLInputElement>('main-menu-seed');
    if (input === null) {
      throw new Error('seed input missing');
    }
    input.value = 'seed-7';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(onNewWorld).toHaveBeenCalledWith('seed-7');
  });

  it('rejects an illegal seed without calling the generator', () => {
    const onNewWorld = vi.fn<(seed: string) => void>();
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld,
      onSettings: vi.fn(),
    });
    menu.show();

    const input = element<HTMLInputElement>('main-menu-seed');
    if (input === null) {
      throw new Error('seed input missing');
    }
    input.value = '<script>';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const error = element('main-menu-seed-error');
    expect(error?.hidden).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('true');

    element<HTMLButtonElement>('main-menu-new-world')?.click();
    expect(onNewWorld).not.toHaveBeenCalled();

    // 改回合法值后提示消失。
    input.value = 'ok-1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(element('main-menu-seed-error')?.hidden).toBe(true);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('hides the back button when there is nothing to return to', () => {
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld: vi.fn(),
      onSettings: vi.fn(),
    });
    menu.show();

    expect(element<HTMLButtonElement>('main-menu-back')?.hidden).toBe(true);

    // 从暂停菜单打开时才有可返回的会话。
    menu.setCanReturn(true);
    expect(element<HTMLButtonElement>('main-menu-back')?.hidden).toBe(true);
  });

  it('shows the back button again when a return handler exists', () => {
    const onBack = vi.fn();
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld: vi.fn(),
      onSettings: vi.fn(),
      onBack,
    });
    menu.show();

    const back = element<HTMLButtonElement>('main-menu-back');
    expect(back?.hidden).toBe(false);
    back?.click();
    expect(onBack).toHaveBeenCalledTimes(1);

    menu.setCanReturn(false);
    expect(back?.hidden).toBe(true);
  });

  it('opens the settings screen from its button', () => {
    const onSettings = vi.fn();
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld: vi.fn(),
      onSettings,
    });
    menu.show();

    element<HTMLButtonElement>('main-menu-settings')?.click();
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it('reflects the session state reported through update()', () => {
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld: vi.fn(),
      onSettings: vi.fn(),
    });

    menu.update({ hasSave: false });
    // The primary action stays clickable even with no save: a disabled main button
    // reads as "this is broken", and with no save it simply creates a world from
    // the seed field. The label changes so the outcome is still predictable.
    expect(element<HTMLButtonElement>('main-menu-start')?.disabled).toBe(false);
    expect(element('main-menu-start')?.textContent).toBe('开始新世界');
    expect(element('main-menu-start-hint')?.textContent).toContain('还没有存档');

    menu.update({ hasSave: true, version: '1.2.3', seed: 'preset' });
    expect(element<HTMLButtonElement>('main-menu-start')?.disabled).toBe(false);
    expect(element('main-menu-version')?.textContent).toBe('版本 v1.2.3');
    expect(element<HTMLInputElement>('main-menu-seed')?.value).toBe('preset');
  });

  it('falls back to a generic build label when no version is given', () => {
    const menu = new MainMenu(createRoot(), {
      onStart: vi.fn(),
      onNewWorld: vi.fn(),
      onSettings: vi.fn(),
    });
    expect(element('main-menu-version')?.textContent).toBe('开发构建');

    menu.update({ version: null });
    expect(element('main-menu-version')?.textContent).toBe('开发构建');
  });

  it('removes its subtree on dispose', () => {
    const root = createRoot();
    const menu = new MainMenu(root, {
      onStart: vi.fn(),
      onNewWorld: vi.fn(),
      onSettings: vi.fn(),
    });
    menu.dispose();
    expect(root.querySelector('[data-testid="main-menu"]')).toBeNull();
  });
});
