/// <reference types="vite/client" />

/**
 * Typed view over Vite's environment variables.
 *
 * Declaring every variable explicitly (instead of relying on the index
 * signature) is what makes `src/config/env.ts` able to validate them with Zod at
 * boot: a typo in `.env` becomes a startup error rather than a silent
 * `undefined` somewhere deep in the renderer.
 */
interface ImportMetaEnv {
  /** Human readable application title, shown on the main menu and tab title. */
  readonly VITE_APP_TITLE?: string;
  /** Enables the on-screen debug overlay by default (`true` / `false`). */
  readonly VITE_DEBUG_OVERLAY?: string;
  /** Seed used when the player creates a world without typing one. */
  readonly VITE_DEFAULT_WORLD_SEED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
