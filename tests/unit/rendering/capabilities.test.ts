import { describe, expect, it, vi } from 'vitest';

import { detectGraphicsBackend, type GraphicsProbeTarget } from '@/rendering/capabilities';

function createProbe(
  result: unknown,
  options: { readonly throwOnGet?: boolean } = {},
): GraphicsProbeTarget {
  return {
    getContext: (contextId: string): unknown => {
      if (options.throwOnGet === true) {
        throw new DOMException('canvas access blocked', 'SecurityError');
      }
      return contextId === 'webgl2' ? result : null;
    },
  };
}

describe('detectGraphicsBackend', () => {
  it('reports webgl2 when a context is available', () => {
    expect(detectGraphicsBackend(createProbe({ getExtension: () => null }))).toBe('webgl2');
  });

  it('reports none when getContext returns null', () => {
    expect(detectGraphicsBackend(createProbe(null))).toBe('none');
  });

  it('reports none instead of throwing when the canvas is blocked', () => {
    expect(detectGraphicsBackend(createProbe(null, { throwOnGet: true }))).toBe('none');
  });

  it('never leaks the probe context', () => {
    const loseContext = vi.fn();
    const probe = createProbe({ getExtension: () => ({ loseContext }) });

    expect(detectGraphicsBackend(probe)).toBe('webgl2');
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('tolerates contexts without the lose_context extension', () => {
    expect(detectGraphicsBackend({ getContext: () => ({}) })).toBe('webgl2');
  });

  it('handles a missing probe target', () => {
    expect(detectGraphicsBackend(null)).toBe('none');
  });
});
