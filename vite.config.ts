import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * Shared source-root alias.
 *
 * `@/` maps onto `src/` so that deeply nested modules (for example
 * `src/ui/screens/InventoryScreen.ts`) can import cross-cutting modules without
 * `../../../` chains. The alias is resolved relative to this config file so the
 * same value works from CI, Cloudflare Pages and the Playwright web server.
 */
const srcDir = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },

  preview: {
    port: 4173,
    strictPort: true,
    host: '127.0.0.1',
  },

  worker: {
    // Chunk meshing and terrain generation run in module workers so that the
    // worker entry can `import` from `@/...` like any other module.
    format: 'es',
  },

  build: {
    target: 'es2022',
    sourcemap: false,
    // Three.js alone is ~600 kB minified; keep the warning threshold above it
    // so that a genuine regression is still visible.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Split the renderer away from game logic: the vendor chunk is stable
        // across deploys and therefore stays cached in the browser.
        //
        // The function form is used because Vite 8 types `manualChunks` as a
        // function only; the object shorthand no longer type-checks.
        manualChunks: (id: string): string | undefined =>
          id.includes('node_modules/three') ? 'three' : undefined,
      },
    },
  },
});
