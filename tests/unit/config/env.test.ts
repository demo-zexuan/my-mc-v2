import { describe, expect, it } from 'vitest';

import { parseAppConfig } from '@/config/env';

describe('parseAppConfig', () => {
  it('applies defaults when no environment variables are present', () => {
    const config = parseAppConfig({});

    expect(config.appTitle).toBe('My MC v2');
    expect(config.debugOverlayByDefault).toBe(true);
    expect(config.defaultWorldSeed).toBe('');
    expect(config.isDev).toBe(false);
  });

  it('reads the values provided by Vite', () => {
    const config = parseAppConfig({
      VITE_APP_TITLE: 'Voxel World',
      VITE_DEBUG_OVERLAY: 'false',
      VITE_DEFAULT_WORLD_SEED: 'my-mc-v2',
      DEV: true,
      PROD: false,
    });

    expect(config.appTitle).toBe('Voxel World');
    expect(config.debugOverlayByDefault).toBe(false);
    expect(config.defaultWorldSeed).toBe('my-mc-v2');
    expect(config.isDev).toBe(true);
    expect(config.isProd).toBe(false);
  });

  it('falls back instead of crashing on a malformed flag', () => {
    // A typo in the deployment environment must not prevent the game from
    // booting; the flag degrades to its default.
    expect(parseAppConfig({ VITE_DEBUG_OVERLAY: 'yes' }).debugOverlayByDefault).toBe(true);
    expect(parseAppConfig({ VITE_DEBUG_OVERLAY: '' }).debugOverlayByDefault).toBe(true);
  });

  it('ignores empty titles rather than rendering a blank one', () => {
    expect(parseAppConfig({ VITE_APP_TITLE: '' }).appTitle).toBe('My MC v2');
  });

  it('only reads string values, never booleans', () => {
    // `import.meta.env` also exposes `DEV`/`PROD` as booleans; a schema built on
    // strings must not be reachable by them.
    const config = parseAppConfig({ VITE_APP_TITLE: true, VITE_DEFAULT_WORLD_SEED: false });
    expect(config.appTitle).toBe('My MC v2');
    expect(config.defaultWorldSeed).toBe('');
  });
});
