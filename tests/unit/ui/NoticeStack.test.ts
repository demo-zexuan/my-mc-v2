// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoticeStack } from '@/ui/NoticeStack';

import { createRoot } from './helpers';

function notices(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>('[data-testid="notice"]');
}

describe('NoticeStack', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts hidden and shows itself on the first push', () => {
    const stack = new NoticeStack(createRoot());
    const element = document.querySelector<HTMLElement>('[data-testid="notice-stack"]');
    expect(element?.hidden).toBe(true);

    stack.push('已保存', { kind: 'success' });

    expect(element?.hidden).toBe(false);
    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.dataset['kind']).toBe('success');
    expect(notices()[0]?.textContent).toContain('已保存');
    expect(stack.count).toBe(1);
  });

  it('renders the message as text, never as markup', () => {
    const stack = new NoticeStack(createRoot());
    stack.push('<img src=x onerror=alert(1)>');

    expect(notices()[0]?.querySelector('img')).toBeNull();
    expect(notices()[0]?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('dismisses a notice after its duration', () => {
    vi.useFakeTimers();
    const stack = new NoticeStack(createRoot(), { durationMs: 1000 });
    stack.push('资源不足', { kind: 'warning' });

    vi.advanceTimersByTime(999);
    expect(notices()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(notices()[0]?.classList.contains('notice--leaving')).toBe(true);

    // 淡出结束后节点才真正移除。
    vi.advanceTimersByTime(300);
    expect(notices()).toHaveLength(0);
    expect(stack.count).toBe(0);
  });

  it('lets the per-notice duration override the default', () => {
    vi.useFakeTimers();
    const stack = new NoticeStack(createRoot(), { durationMs: 10_000 });
    stack.push('稍后消失', { durationMs: 500 });

    vi.advanceTimersByTime(600);
    expect(notices()[0]?.classList.contains('notice--leaving')).toBe(true);
  });

  it('drops the oldest notice when the limit is exceeded', () => {
    const stack = new NoticeStack(createRoot(), { maxVisible: 2 });
    stack.push('第一条');
    stack.push('第二条');
    stack.push('第三条');

    expect(notices()).toHaveLength(2);
    expect(stack.count).toBe(2);
    expect(document.body.textContent).not.toContain('第一条');
  });

  it('closes a notice through its own button', () => {
    const stack = new NoticeStack(createRoot());
    stack.push('可关闭');

    document.querySelector<HTMLButtonElement>('[data-testid="notice-close"]')?.click();

    expect(notices()[0]?.classList.contains('notice--leaving')).toBe(true);
  });

  it('treats update() as a push so the panel contract stays uniform', () => {
    const stack = new NoticeStack(createRoot());
    stack.update({ message: '区块已加载', kind: 'info' });

    expect(notices()).toHaveLength(1);
    expect(notices()[0]?.dataset['kind']).toBe('info');
  });

  it('clears, hides and disposes without leaking timers', () => {
    vi.useFakeTimers();
    const root = createRoot();
    const stack = new NoticeStack(root, { durationMs: 1000 });
    stack.push('一');
    stack.push('二');
    stack.clear();
    expect(notices()).toHaveLength(0);

    stack.push('三');
    stack.hide();
    expect(stack.visible).toBe(false);

    stack.dispose();
    expect(root.querySelector('[data-testid="notice-stack"]')).toBeNull();

    // 定时器已清掉：时间前进也不会抛错，更不会重建 DOM。
    vi.advanceTimersByTime(5000);
    expect(root.querySelector('[data-testid="notice"]')).toBeNull();

    // dispose 之后再推入提示应被忽略，而不是往游离节点里塞内容。
    stack.push('四');
    expect(stack.count).toBe(0);
  });
});
