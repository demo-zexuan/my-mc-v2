import { access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Playwright global setup.
 *
 * I. Why this check exists
 *
 * The suite serves the production build. Running `playwright test` on a fresh
 * clone without building first would otherwise start a preview server over a
 * missing `dist/` directory and fail inside every test with an opaque 404. A
 * single up-front check turns that into one actionable message.
 */
export default async function globalSetup(): Promise<void> {
  const distIndex = join(process.cwd(), 'dist', 'index.html');
  try {
    await access(distIndex);
  } catch {
    throw new Error(
      [
        'dist/index.html is missing.',
        '',
        'The E2E suite runs against the production build. Run one of:',
        '  pnpm run build && pnpm run test:e2e:run   # build, then run only the browser suite',
        '  pnpm run test:e2e                          # build and run the browser suite',
      ].join('\n'),
    );
  }
}
