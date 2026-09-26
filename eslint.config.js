// @ts-check
import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint configuration.
 *
 * I. Design intent
 *
 * 1. Formatting is owned by Prettier, therefore `eslint-config-prettier` is
 *    applied last to switch off every stylistic rule that could fight it.
 * 2. Type-aware linting is enabled for `src/` and `tests/` only; configuration
 *    files are linted without type information to keep `pnpm lint` fast and to
 *    avoid requiring a successful build before linting is useful.
 * 3. `no-explicit-any` is an error rather than a warning: the project brief
 *    forbids `any`, and a warning would silently accumulate.
 *
 * II. Why the rule set is declared once
 *
 * Two groups of files are linted with type information against *different*
 * tsconfig projects (browser sources vs. the Node-only architecture guard). The
 * shared rule block is defined once and reused so the two groups cannot drift
 * apart.
 */

/** Rules applied to every type-aware group. */
const typeAwareRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/require-await': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/restrict-template-expressions': [
    'error',
    { allowNumber: true, allowBoolean: true },
  ],
  'no-console': ['warn', { allow: ['warn', 'error'] }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-var': 'error',
  'prefer-const': 'error',
  'object-shorthand': ['error', 'always'],
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'public/**',
    ],
  },

  // I. Base JavaScript rules
  js.configs.recommended,

  // II. Typed rules for application and test sources, checked against the
  //     browser tsconfig project.
  {
    files: [
      'src/**/*.ts',
      'tests/unit/**/*.ts',
      'tests/integration/**/*.ts',
      'tests/support/**/*.ts',
    ],
    ignores: ['tests/unit/architecture.test.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    rules: typeAwareRules,
  },

  // III. The architecture guard reads the file system, so it is checked against
  //      the Node-only project that grants Node globals. Merging it into group
  //      II would either leak `process` into browser sources or leave the file
  //      untyped and therefore full of false `no-unsafe-*` reports.
  {
    files: ['tests/unit/architecture.test.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.tests-node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: typeAwareRules,
  },

  // IV. Worker entry points talk to the DOM-free worker scope through a narrow
  //      typed facade, so they are allowed to reach worker globals.
  {
    files: ['src/workers/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.worker,
      },
    },
  },

  // V. Node-side scripts and configuration files.
  //    These are linted without type information: requiring a built project
  //    graph just to lint `vite.config.ts` would make `pnpm lint` depend on a
  //    successful typecheck, and a broken config file is exactly when that is
  //    least useful. The TypeScript parser is still required so that type syntax
  //    such as annotations and `satisfies` parses at all.
  {
    files: [
      '*.config.ts',
      '*.config.js',
      'scripts/**/*.ts',
      'scripts/**/*.mjs',
      'tests/e2e/**/*.ts',
    ],
    extends: [tseslint.configs.disableTypeChecked],
    // `disableTypeChecked` only turns rules off; the plugin still has to be
    // registered for `@typescript-eslint/no-unused-vars` below to resolve.
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        // Diagnostic scripts contain `page.evaluate` callbacks that are
        // serialised and executed inside the browser, so browser globals must be
        // visible to the linter as well.
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
      // The base rule cannot see TypeScript function-type signatures and reports
      // their parameter names as unused; the TS-aware variant understands them.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // VI. Prettier compatibility last
  prettierConfig,
);
