/**
 * Browser entry point.
 *
 * I. Responsibilities
 *
 * 1. Mount the application into the static `#app` element from `index.html`.
 * 2. Install process-wide error handlers so that an unhandled rejection is
 *    reported once, through the logger, rather than appearing as an anonymous
 *    console entry that the visual-regression harness cannot classify.
 *
 * @module main
 */

import './styles/main.css';

import { GameApp } from '@/app/GameApp';
import { appConfig } from '@/config/env';
import { logger } from '@/utils/logger';

const log = logger.child('main');

/**
 * Creates the application and starts it.
 *
 * @param root - Element that hosts the canvas and every overlay.
 * @returns The running instance, so tests and hot-reload can dispose it.
 */
export function bootstrap(root: HTMLElement): GameApp {
  document.title = `${appConfig.appTitle} — Voxel Sandbox`;
  const app = new GameApp(root);
  void app.start();
  return app;
}

// I. Report unhandled failures.
// 1. They are logged at error level so the E2E suite, which fails on console
//    errors, catches regressions that would otherwise be silent.
// 2. The handlers are registered before bootstrap so that an early failure is
//    still reported.
window.addEventListener('error', (event) => {
  log.error('uncaught error', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  log.error('unhandled rejection', event.reason);
});

const rootElement = document.getElementById('app');
if (rootElement === null) {
  throw new Error('Mount element #app is missing from index.html.');
}
bootstrap(rootElement);
