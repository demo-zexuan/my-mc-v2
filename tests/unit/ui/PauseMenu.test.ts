// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { formatPlayTime, PauseMenu } from '@/ui/PauseMenu';

import { createRoot } from './helpers';

function element<T extends HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

describe('formatPlayTime', () => {
  it('formats a duration as HH:MM:SS', () => {
    expect(formatPlayTime(0)).toBe('00:00:00');
    expect(formatPlayTime(1000)).toBe('00:00:01');
    expect(formatPlayTime(61_000)).toBe('00:01:01');
    expect(formatPlayTime(3_600_000 + 2 * 60_000 + 3000)).toBe('01:02:03');
  });

  it('clamps negative and fractional input', () => {
    expect(formatPlayTime(-5000)).toBe('00:00:00');
    expect(formatPlayTime(1500)).toBe('00:00:01');
  });
});

describe('PauseMenu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the three actions and starts hidden', () => {
    const menu = new PauseMenu(createRoot(), {
      onResume: vi.fn(),
      onSettings: vi.fn(),
      onSaveAndQuit: vi.fn(),
    });

    expect(menu.visible).toBe(false);
    expect(element('pause-menu')?.hidden).toBe(true);
    expect(element('pause-menu-title')?.textContent).toBe('已暂停');
    expect(element<HTMLButtonElement>('pause-menu-resume')?.textContent).toBe('继续游戏');
    expect(element<HTMLButtonElement>('pause-menu-settings')?.textContent).toBe('设置');
    expect(element<HTMLButtonElement>('pause-menu-quit')?.textContent).toBe('保存并退出到主菜单');
  });

  it('reports open and close once each', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const menu = new PauseMenu(createRoot(), {
      onResume: vi.fn(),
      onSettings: vi.fn(),
      onSaveAndQuit: vi.fn(),
      onOpen,
      onClose,
    });

    menu.show();
    menu.show();
    expect(onOpen).toHaveBeenCalledTimes(1);

    menu.hide();
    menu.hide();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dispatches each action', () => {
    const onResume = vi.fn();
    const onSettings = vi.fn();
    const onSaveAndQuit = vi.fn();
    const menu = new PauseMenu(createRoot(), { onResume, onSettings, onSaveAndQuit });
    menu.show();

    element<HTMLButtonElement>('pause-menu-resume')?.click();
    element<HTMLButtonElement>('pause-menu-settings')?.click();
    element<HTMLButtonElement>('pause-menu-quit')?.click();

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(onSaveAndQuit).toHaveBeenCalledTimes(1);
  });

  it('renders the session meta line from the snapshot', () => {
    const menu = new PauseMenu(createRoot(), {
      onResume: vi.fn(),
      onSettings: vi.fn(),
      onSaveAndQuit: vi.fn(),
    });
    menu.update({ playTimeMs: 65_000, seedLabel: 'seed-42', saving: false });

    expect(element('pause-menu-meta')?.textContent).toBe('本次游玩 00:01:05 · 种子 seed-42');
    expect(element('pause-menu-status')?.hidden).toBe(true);
  });

  it('locks every action while the save is running', () => {
    const onSaveAndQuit = vi.fn();
    const menu = new PauseMenu(createRoot(), {
      onResume: vi.fn(),
      onSettings: vi.fn(),
      onSaveAndQuit,
    });
    menu.update({ playTimeMs: 0, seedLabel: '随机', saving: true });

    expect(element<HTMLButtonElement>('pause-menu-resume')?.disabled).toBe(true);
    expect(element<HTMLButtonElement>('pause-menu-settings')?.disabled).toBe(true);
    const quit = element<HTMLButtonElement>('pause-menu-quit');
    expect(quit?.disabled).toBe(true);
    expect(quit?.textContent).toBe('正在保存…');
    expect(element('pause-menu-status')?.hidden).toBe(false);

    quit?.click();
    expect(onSaveAndQuit).not.toHaveBeenCalled();

    // 保存结束后恢复可用。
    menu.update({ playTimeMs: 0, seedLabel: '随机', saving: false });
    expect(quit?.disabled).toBe(false);
    expect(quit?.textContent).toBe('保存并退出到主菜单');
  });

  it('removes its subtree on dispose', () => {
    const root = createRoot();
    const menu = new PauseMenu(root, {
      onResume: vi.fn(),
      onSettings: vi.fn(),
      onSaveAndQuit: vi.fn(),
    });
    menu.dispose();
    expect(root.querySelector('[data-testid="pause-menu"]')).toBeNull();
  });
});
