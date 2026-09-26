// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BootOverlay } from '@/ui/BootOverlay';
import { AppError } from '@/utils/errors';

function createRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  return root;
}

describe('BootOverlay', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a loading card on demand', () => {
    const overlay = new BootOverlay(createRoot());
    overlay.showLoading('正在加载区块…');

    const card = document.querySelector('[data-testid="boot-loading"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain('正在加载区块…');
    expect(overlay.state).toBe('loading');
  });

  it('updates the progress bar width', () => {
    const overlay = new BootOverlay(createRoot());
    overlay.showLoading();
    overlay.setProgress('生成地形', 0.42);

    // jsdom normalises percentage values, so `42.0%` reads back as `42%`.
    const fill = document.querySelector<HTMLElement>('.boot-screen__progress-fill');
    expect(Number.parseFloat(fill?.style.width ?? '0')).toBeCloseTo(42, 3);
  });

  it('clamps out-of-range progress values', () => {
    const overlay = new BootOverlay(createRoot());
    overlay.showLoading();
    overlay.setProgress('生成地形', 1.8);

    const fill = document.querySelector<HTMLElement>('.boot-screen__progress-fill');
    expect(Number.parseFloat(fill?.style.width ?? '0')).toBeCloseTo(100, 3);
  });

  it('shows the player facing message for a fatal error, never the raw one', () => {
    const overlay = new BootOverlay(createRoot());
    overlay.showFatal(
      new AppError('WEBGL_UNAVAILABLE', 'glGetError returned 0x0500', {
        userMessage: '你的浏览器不支持 WebGL 2。',
      }),
    );

    const card = document.querySelector('[data-testid="boot-fatal"]');
    expect(card?.textContent).toContain('你的浏览器不支持 WebGL 2。');
    expect(card?.textContent).toContain('glGetError returned 0x0500');
    expect(overlay.state).toBe('fatal');
  });

  it('detaches itself when hidden', () => {
    vi.useFakeTimers();
    try {
      const root = createRoot();
      const overlay = new BootOverlay(root);
      overlay.showLoading();
      overlay.hide();

      // The card fades out first; jsdom never fires `transitionend`, so the
      // fallback timer is what detaches it.
      expect(overlay.state).toBe('hidden');
      vi.advanceTimersByTime(500);
      expect(root.querySelector('.boot-screen')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces a previous card instead of stacking them', () => {
    const root = createRoot();
    const overlay = new BootOverlay(root);

    overlay.showLoading('第一次');
    overlay.showLoading('第二次');

    expect(root.querySelectorAll('.boot-screen')).toHaveLength(1);
    expect(root.textContent).toContain('第二次');
  });

  it('configures the stage message only while loading', () => {
    const overlay = new BootOverlay(createRoot());
    overlay.showFatal(new AppError('UNKNOWN', 'x'));
    overlay.setProgress('不应出现', 0.5);

    expect(document.body.textContent).not.toContain('不应出现');
  });
});
