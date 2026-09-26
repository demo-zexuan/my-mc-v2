// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_LIMITS, type GameSettings } from '@/settings/types';
import { SettingsScreen, SETTINGS_SCREEN_KEYS } from '@/ui/SettingsScreen';

import { createRoot } from './helpers';

function element<T extends HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

function range(testId: string): HTMLInputElement {
  const input = element<HTMLInputElement>(testId);
  if (input === null) {
    throw new Error(`range input ${testId} missing`);
  }
  return input;
}

function setRange(testId: string, value: number): void {
  const input = range(testId);
  input.value = String(value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('SettingsScreen', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('covers every player-facing setting exactly once', () => {
    expect([...SETTINGS_SCREEN_KEYS.numeric].sort()).toEqual(
      [
        'ambientVolume',
        'fov',
        'masterVolume',
        'mouseSensitivity',
        'renderDistance',
        'sfxVolume',
      ].sort(),
    );
    expect([...SETTINGS_SCREEN_KEYS.toggles].sort()).toEqual(
      ['debugOverlay', 'invertY', 'shadows', 'viewBobbing'].sort(),
    );
  });

  it('renders a control with a live readout for every setting', () => {
    const screen = new SettingsScreen(createRoot(), { onChange: vi.fn() });

    expect(screen.visible).toBe(false);
    expect(element('settings-screen')?.hidden).toBe(true);

    for (const key of SETTINGS_SCREEN_KEYS.numeric) {
      expect(element(`settings-${key}`)).not.toBeNull();
      expect(element(`settings-${key}-value`)).not.toBeNull();
    }
    for (const key of SETTINGS_SCREEN_KEYS.toggles) {
      expect(element(`settings-${key}-toggle`)).not.toBeNull();
    }
    for (const quality of ['low', 'medium', 'high']) {
      expect(element(`settings-quality-${quality}`)).not.toBeNull();
    }
    expect(element('settings-reset')).not.toBeNull();
    expect(element('settings-back')).not.toBeNull();
  });

  it('mirrors the slider bounds from SETTINGS_LIMITS', () => {
    new SettingsScreen(createRoot(), { onChange: vi.fn() });

    const fov = range('settings-fov');
    expect(fov.min).toBe(String(SETTINGS_LIMITS.fov.min));
    expect(fov.max).toBe(String(SETTINGS_LIMITS.fov.max));
    expect(fov.type).toBe('range');

    const sensitivity = range('settings-mouseSensitivity');
    expect(sensitivity.min).toBe(String(SETTINGS_LIMITS.mouseSensitivity.min));
    expect(sensitivity.max).toBe(String(SETTINGS_LIMITS.mouseSensitivity.max));
  });

  it('reports a slider change immediately with a typed patch', () => {
    const onChange = vi.fn<(patch: Partial<GameSettings>) => void>();
    new SettingsScreen(createRoot(), { onChange });

    setRange('settings-fov', 92);
    expect(onChange).toHaveBeenLastCalledWith({ fov: 92 });

    setRange('settings-masterVolume', 0.35);
    expect(onChange).toHaveBeenLastCalledWith({ masterVolume: 0.35 });
  });

  it('shows the new value in the readout once update() applies it', () => {
    const screen = new SettingsScreen(createRoot(), { onChange: vi.fn() });
    screen.update({ ...DEFAULT_SETTINGS, fov: 92, ambientVolume: 0.25 });

    expect(element('settings-fov-value')?.textContent).toBe('92°');
    expect(element('settings-ambientVolume-value')?.textContent).toBe('25%');
    expect(range('settings-fov').value).toBe('92');
    expect(range('settings-fov').getAttribute('aria-valuetext')).toBe('92°');
  });

  it('renders sensitivity with enough precision to be useful', () => {
    const screen = new SettingsScreen(createRoot(), { onChange: vi.fn() });
    expect(element('settings-mouseSensitivity-value')?.textContent).toBe('0.0022');

    screen.update({ ...DEFAULT_SETTINGS, mouseSensitivity: 0.0005 });
    expect(element('settings-mouseSensitivity-value')?.textContent).toBe('0.0005');
  });

  it('toggles a switch and reflects the applied value', () => {
    const onChange = vi.fn<(patch: Partial<GameSettings>) => void>();
    const screen = new SettingsScreen(createRoot(), { onChange });

    element<HTMLButtonElement>('settings-shadows-toggle')?.click();
    expect(onChange).toHaveBeenLastCalledWith({ shadows: false });

    screen.update({ ...DEFAULT_SETTINGS, shadows: false });
    const toggle = element<HTMLButtonElement>('settings-shadows-toggle');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(toggle?.dataset['state']).toBe('off');
    expect(toggle?.classList.contains('toggle--on')).toBe(false);
    expect(toggle?.textContent).toBe('关闭');

    // 再点一次回到开启：状态来自 update() 传入的设置，而不是组件内部的副本。
    element<HTMLButtonElement>('settings-shadows-toggle')?.click();
    expect(onChange).toHaveBeenLastCalledWith({ shadows: true });
  });

  it('applies the Y-axis inversion flag', () => {
    const onChange = vi.fn<(patch: Partial<GameSettings>) => void>();
    new SettingsScreen(createRoot(), { onChange });

    element<HTMLButtonElement>('settings-invertY-toggle')?.click();
    expect(onChange).toHaveBeenLastCalledWith({ invertY: true });
  });

  it('selects a quality preset and explains it', () => {
    const onChange = vi.fn<(patch: Partial<GameSettings>) => void>();
    const screen = new SettingsScreen(createRoot(), { onChange });

    element<HTMLButtonElement>('settings-quality-low')?.click();
    expect(onChange).toHaveBeenLastCalledWith({ graphicsQuality: 'low' });

    // 视图只跟着 update() 走：调用方应用补丁后必须把新设置回灌进来。
    screen.update({ ...DEFAULT_SETTINGS, graphicsQuality: 'low' });
    expect(element('settings-quality-hint')?.textContent).toContain('像素比 1.0');

    screen.update({ ...DEFAULT_SETTINGS, graphicsQuality: 'high' });
    expect(element<HTMLButtonElement>('settings-quality-high')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(element<HTMLButtonElement>('settings-quality-low')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(element('settings-quality-hint')?.textContent).toContain('2048');
  });

  it('restores the defaults as one patch', () => {
    const onChange = vi.fn<(patch: Partial<GameSettings>) => void>();
    const screen = new SettingsScreen(createRoot(), { onChange });
    screen.update({ ...DEFAULT_SETTINGS, fov: 100, renderDistance: 16, invertY: true });

    element<HTMLButtonElement>('settings-reset')?.click();
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS });
  });

  it('notifies open/close and returns through the back button', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const onBack = vi.fn();
    const screen = new SettingsScreen(createRoot(), { onChange: vi.fn(), onOpen, onClose, onBack });

    screen.show();
    screen.show();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.visible).toBe(true);

    element<HTMLButtonElement>('settings-back')?.click();
    expect(onBack).toHaveBeenCalledTimes(1);

    screen.hide();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hides the back button when no return handler is provided', () => {
    new SettingsScreen(createRoot(), { onChange: vi.fn() });
    expect(element<HTMLButtonElement>('settings-back')?.hidden).toBe(true);
  });

  it('keeps its own view of the settings in sync', () => {
    const screen = new SettingsScreen(createRoot(), { onChange: vi.fn() });
    expect(screen.settings).toEqual(DEFAULT_SETTINGS);

    const custom: GameSettings = { ...DEFAULT_SETTINGS, fov: 60, shadows: false };
    screen.update(custom);
    expect(screen.settings).toEqual(custom);
  });

  it('removes its subtree on dispose', () => {
    const root = createRoot();
    const screen = new SettingsScreen(root, { onChange: vi.fn() });
    screen.dispose();
    expect(root.querySelector('[data-testid="settings-screen"]')).toBeNull();
  });
});
