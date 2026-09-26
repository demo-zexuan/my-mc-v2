import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@/utils/logger';

describe('Logger', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let debugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('suppresses messages below the configured level', () => {
    const logger = new Logger({ level: 'warn' });

    logger.debug('hidden');
    logger.info('hidden');
    logger.warn('shown');

    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('routes each level to the matching console method', () => {
    const logger = new Logger({ level: 'debug' });

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('prefixes messages with the scope chain', () => {
    const logger = new Logger({ level: 'info', scope: 'world' }).child('chunk');

    logger.info('loaded');

    expect(infoSpy).toHaveBeenCalledWith('[info][world:chunk] loaded');
  });

  it('propagates level changes to children created afterwards', () => {
    const parent = new Logger({ level: 'error' });
    const child = parent.child('physics');

    child.warn('hidden');
    expect(warnSpy).not.toHaveBeenCalled();

    child.setLevel('debug');
    child.debug('shown');
    expect(debugSpy).toHaveBeenCalledTimes(1);
  });

  it('silences everything at level "silent"', () => {
    const logger = new Logger({ level: 'silent' });

    logger.error('nothing');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('forwards extra details to the console', () => {
    const logger = new Logger({ level: 'info' });
    const detail = { seed: 42 };

    logger.info('world created', detail);
    expect(infoSpy).toHaveBeenCalledWith('[info] world created', detail);
  });
});
