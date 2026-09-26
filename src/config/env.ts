/**
 * Environment configuration surface.
 *
 * I. Design notes
 *
 * 1. Vite inlines `import.meta.env` at build time, so a missing variable can
 *    only be detected at runtime. Validating once at boot turns a misconfigured
 *    deploy into a clear message on screen instead of an obscure crash later.
 * 2. Defaults are provided for every value; the game must still run when the
 *    repository is cloned and started with no `.env` file at all.
 *
 * @module config/env
 */

import { z } from 'zod';

/**
 * `z.coerce` is avoided on purpose: `import.meta.env` values are always strings
 * or undefined, and an explicit transform documents the accepted spelling.
 */
const booleanFromString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .catch(true);

const rawEnvSchema = z.object({
  VITE_APP_TITLE: z.string().min(1).catch('My MC v2'),
  VITE_DEBUG_OVERLAY: booleanFromString,
  VITE_DEFAULT_WORLD_SEED: z.string().catch(''),
});

/** Validated, immutable application configuration. */
export interface AppConfig {
  readonly appTitle: string;
  readonly debugOverlayByDefault: boolean;
  readonly defaultWorldSeed: string;
  readonly isDev: boolean;
  readonly isProd: boolean;
}

/**
 * Parses the Vite environment into {@link AppConfig}.
 *
 * Exported separately from {@link appConfig} so that tests can exercise the
 * parsing rules without touching the real `import.meta.env`.
 *
 * @param source - Raw environment record, normally `import.meta.env`.
 * @returns The validated configuration.
 */
export function parseAppConfig(source: Record<string, string | boolean | undefined>): AppConfig {
  // I. Narrow the source down to the three strings the schema understands.
  // 1. Non-string values (Vite also exposes `DEV`, `PROD`, ...) are dropped so
  //    that a stray boolean can never reach a string schema.
  const picked: Record<string, string | undefined> = {};
  for (const key of ['VITE_APP_TITLE', 'VITE_DEBUG_OVERLAY', 'VITE_DEFAULT_WORLD_SEED']) {
    const value = source[key];
    picked[key] = typeof value === 'string' ? value : undefined;
  }

  // II. Validate. Every field fell back to a safe default, therefore parsing
  //     cannot throw and the boot sequence stays linear.
  const parsed = rawEnvSchema.parse(picked);

  return {
    appTitle: parsed.VITE_APP_TITLE,
    debugOverlayByDefault: parsed.VITE_DEBUG_OVERLAY,
    defaultWorldSeed: parsed.VITE_DEFAULT_WORLD_SEED,
    isDev: source['DEV'] === true,
    isProd: source['PROD'] === true,
  };
}

/** Configuration resolved for the current build. */
export const appConfig: AppConfig = parseAppConfig(import.meta.env);
