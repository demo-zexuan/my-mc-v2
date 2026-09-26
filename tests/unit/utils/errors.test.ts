import { describe, expect, it } from 'vitest';

import { AppError, toAppError } from '@/utils/errors';

describe('AppError', () => {
  it('carries a machine readable code and a player facing message', () => {
    const error = new AppError('WEBGL_UNAVAILABLE', 'probe failed');

    expect(error.code).toBe('WEBGL_UNAVAILABLE');
    expect(error.message).toBe('probe failed');
    expect(error.userMessage).toContain('WebGL');
    expect(error.name).toBe('AppError');
  });

  it('allows overriding the player facing message', () => {
    const error = new AppError('SAVE_CORRUPTED', 'checksum mismatch', {
      userMessage: '存档损坏',
    });

    expect(error.userMessage).toBe('存档损坏');
  });

  it('preserves the original cause', () => {
    const original = new Error('driver exploded');
    const error = new AppError('RENDERER_INIT_FAILED', 'init failed', { cause: original });

    expect(error.cause).toBe(original);
  });

  it('defaults the context to an empty object', () => {
    expect(new AppError('UNKNOWN', 'x').context).toEqual({});
  });
});

describe('toAppError', () => {
  it('returns an AppError unchanged', () => {
    const error = new AppError('AUDIO_INIT_FAILED', 'no output device');
    expect(toAppError(error)).toBe(error);
  });

  it('wraps a plain Error with the requested fallback code', () => {
    const wrapped = toAppError(new Error('boom'), 'STORAGE_UNAVAILABLE');

    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.code).toBe('STORAGE_UNAVAILABLE');
    expect(wrapped.message).toBe('boom');
  });

  it('wraps thrown non-errors such as string rejections', () => {
    const wrapped = toAppError('nope');

    expect(wrapped.code).toBe('UNKNOWN');
    expect(wrapped.message).toBe('nope');
  });

  it('always produces a player facing message', () => {
    expect(toAppError(null).userMessage.length).toBeGreaterThan(0);
  });
});
