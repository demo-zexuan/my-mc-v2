import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * I. Why this file does not reuse `vite.config.ts`
 *
 * 1. `mergeConfig(viteConfig, ...)` does not type-check: Vite 8's `UserConfig`
 *    and the copy of `UserConfig` bundled with `vitest/config` are structurally
 *    different because both packages ship their own Rolldown typings. Mixing
 *    them produced a `never` parameter rather than a useful diagnostic.
 * 2. The only setting genuinely shared between the two configs is the `@/`
 *    alias, so it is declared here explicitly. Keeping the duplication visible
 *    is cheaper than a shared module that both configs must import through a
 *    third tsconfig project.
 *
 * II. Environment policy
 *
 * The default environment is `node` because most of the engine is pure logic
 * (terrain maths, chunk storage, inventory rules, save serialisation).
 * DOM-dependent specs opt in per file with `// @vitest-environment jsdom`.
 */
const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: {
      junit: './coverage/junit.xml',
    },
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/main.ts', 'src/vite-env.d.ts'],
    },
  },
});
