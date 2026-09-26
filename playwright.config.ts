import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright configuration.
 *
 * I. Why the E2E suite runs against the production build
 *
 * 1. `vite preview` serves exactly the artefact that Cloudflare Pages will
 *    publish (hashed asset names, minified bundle, no HMR client). Running the
 *    browser suite against `vite dev` would verify a bundle that never ships.
 * 2. Hash-based asset names and the SPA rewrite rules are only exercised on the
 *    built output, so a broken `base` path or a missing `_redirects` entry is
 *    caught here instead of in production.
 *
 * II. WebGL in headless Chromium
 *
 * Playwright's default headless mode (`chromium_headless_shell`) does provide
 * WebGL 2 through SwiftShader — verified with `scripts/probe-launch-modes.mjs`.
 * Chrome gates software rendering behind `--enable-unsafe-swiftshader`, which is
 * therefore kept for GPU-less CI runners.
 */
const PORT = 4173;
const baseURL = process.env['E2E_BASE_URL'] ?? `http://127.0.0.1:${PORT}`;
const isCI = process.env['CI'] !== undefined && process.env['CI'] !== '';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // I. Always one worker.
  // 1. Every spec drives a full voxel world through SwiftShader software rendering.
  //    Running them concurrently starves the CPU, so a 45 s budget that is generous
  //    in isolation is not enough under load: two specs timed out or measured a
  //    half-streamed world, which is a false negative that costs more to diagnose
  //    than the parallel run saves. The suite is 24 specs; serial execution is
  //    only about a minute.
  workers: 1,

  // Chunk streaming, world creation and the first frames all happen inside a
  // spec, and software rendering makes each of them slow.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  reporter: isCI
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: 'playwright-report' }],
        ['junit', { outputFile: 'coverage/e2e-junit.xml' }],
      ]
    : [['list']],

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    // A fixed viewport keeps the visual assertions comparable between runs and
    // between machines.
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      args: [
        '--enable-unsafe-swiftshader',
        // Suppresses the "Chrome is being controlled by automated software"
        // infobar, which would otherwise be captured in screenshots.
        '--disable-infobars',
      ],
    },
  },

  projects: [
    {
      name: 'chromium-desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],

  webServer: {
    // I. The server is started through the local binary rather than
    //    `pnpm run preview`.
    // 1. A package-manager wrapper spawns the real server as a grandchild.
    //    Playwright terminates only the process it started, so the surviving
    //    grandchild keeps the log pipe open and the run never exits.
    // 2. Building is a separate step (`pnpm run test:e2e` builds first) so this
    //    command starts exactly one process.
    command: 'node_modules/.bin/vite preview --port 4173 --strictPort',
    url: baseURL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },

  outputDir: './test-results',
});
