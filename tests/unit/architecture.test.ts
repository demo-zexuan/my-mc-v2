import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Architecture guard.
 *
 * I. Why this is a test instead of a lint rule
 *
 * 1. The two properties that matter here — "no dependency cycles" and "the low
 *    layers never reach up into the UI" — are graph properties of the whole
 *    source tree. Expressing them requires resolving `@/` aliases through
 *    `tsconfig`, which `eslint-plugin-import` can only do with an extra resolver
 *    dependency and a second configuration surface.
 * 2. A plain TypeScript test over the file tree has no dependency, runs in
 *    milliseconds, and reports a readable cycle path. It also cannot be silently
 *    disabled by an inline `eslint-disable`.
 *
 * II. Why the rule set is deliberately small
 *
 * Layer rules that are too fine-grained become bureaucratic and get worked
 * around. These two rules are the ones that actually keep the engine testable:
 * a cycle makes module initialisation order matter, and a low layer importing
 * the UI makes the logic impossible to test without a DOM.
 */

const SRC_DIR = resolve(import.meta.dirname, '../../src');

/** Top-level source directories, treated as architectural layers. */
type Layer =
  | 'app'
  | 'audio'
  | 'config'
  | 'debug'
  | 'engine'
  | 'entities'
  | 'input'
  | 'interaction'
  | 'inventory'
  | 'particles'
  | 'physics'
  | 'player'
  | 'rendering'
  | 'save'
  | 'settings'
  | 'terrain'
  | 'ui'
  | 'utils'
  | 'workers'
  | 'world';

/**
 * Layers that must stay free of UI and application-assembly concerns.
 *
 * A module in this set may not import from `ui`, `app` or `main`. Without the
 * rule it is tempting to let, say, the world raise a toast directly, which
 * immediately makes that module untestable outside a browser.
 */
const UI_AGNOSTIC_LAYERS: ReadonlySet<string> = new Set<string>([
  'audio',
  'config',
  'engine',
  'entities',
  'input',
  'interaction',
  'inventory',
  'particles',
  'physics',
  'player',
  'rendering',
  'save',
  'settings',
  'terrain',
  'utils',
  'workers',
  'world',
]);

/** Layers that may never be imported from anywhere below `app`. */
const TOP_LEVEL_LAYERS: ReadonlySet<string> = new Set<string>(['app']);

interface SourceModule {
  /** Layer derived from the first path segment under `src/`. */
  readonly layer: Layer | 'root';
  /** Path relative to the repository root, used in failure messages. */
  readonly displayPath: string;
  /** Absolute path on disk. */
  readonly filePath: string;
  /** Resolved internal imports. */
  readonly imports: readonly string[];
}

/** Recursively lists every `.ts` file under a directory. */
function listTypeScriptFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const fullPath = join(directory, entry);
    if (statSync(fullPath).isDirectory()) {
      found.push(...listTypeScriptFiles(fullPath));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      found.push(fullPath);
    }
  }
  return found;
}

/**
 * Extracts every module specifier a file imports.
 *
 * I. Type-only imports are ignored
 *
 * `verbatimModuleSyntax` guarantees that `import type ...` and inline
 * `{ type X }` specifiers are erased at compile time. They therefore cannot
 * create a runtime initialisation cycle — the failure mode this check exists to
 * prevent — and counting them as edges produces false positives that push people
 * to contort otherwise reasonable code. An import counts as an edge only when at
 * least one binding survives to runtime.
 *
 * @param source - File contents.
 * @returns Module specifiers that produce a runtime dependency.
 */
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    // `import x from '...'`, `import { a, type b } from '...'`
    /(?:^|\n)\s*import\s+(?!type\s)([^'"]*?)from\s*['"]([^'"]+)['"]/g,
    // Side-effect import: `import '...'` — always a runtime edge.
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    // `export { a } from '...'`, `export * from '...'`
    /(?:^|\n)\s*export\s+(?!type\s)([^'"]*?)from\s*['"]([^'"]+)['"]/g,
    // Dynamic `import('...')` is always a runtime edge.
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      // The clause sits in group 1 for the from-forms, group 2 for the path.
      const clause = match.length > 2 ? (match[1] ?? '') : '';
      const specifier = match.length > 2 ? match[2] : match[1];
      if (specifier === undefined) {
        continue;
      }
      if (clause !== '' && clauseIsTypeOnly(clause)) {
        continue;
      }
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Decides whether an import clause carries no runtime binding.
 *
 * @param clause - Text between `import`/`export` and `from`.
 */
function clauseIsTypeOnly(clause: string): boolean {
  const trimmed = clause.trim();
  if (trimmed.startsWith('type ') || trimmed.startsWith('type{')) {
    return true;
  }
  // Named list: every element must be individually marked `type`.
  const named = /\{([^}]*)\}/.exec(trimmed);
  if (named !== null) {
    const body = named[1] ?? '';
    const parts = body
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    // A default or namespace binding outside the braces keeps the import alive.
    const outsideBraces = trimmed.replace(/\{[^}]*\}/, '').replace(/,\s*$/, '').trim();
    const hasRuntimeOutsideBraces =
      outsideBraces !== '' && outsideBraces !== ',' && outsideBraces !== 'default';
    if (!hasRuntimeOutsideBraces && parts.length > 0 && parts.every((p) => p.startsWith('type '))) {
      return true;
    }
  }
  return false;
}

/** Resolves a specifier to a file on disk, or `null` for external packages. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let basePath: string;

  if (specifier.startsWith('@/')) {
    basePath = join(SRC_DIR, specifier.slice(2));
  } else if (specifier.startsWith('.')) {
    basePath = resolve(dirname(fromFile), specifier);
  } else {
    // Bare specifier: a package, a Vite virtual module or a Node builtin.
    return null;
  }

  const candidates = [`${basePath}.ts`, join(basePath, 'index.ts')];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Not a file; try the next candidate.
    }
  }
  return null;
}

function toLayer(filePath: string): Layer | 'root' {
  const relativePath = relative(SRC_DIR, filePath);
  const segments = relativePath.split(sep);
  // A file directly under `src/` (for example `main.ts`) has no layer.
  return segments.length > 1 ? (segments[0] as Layer) : 'root';
}

/** Reads the whole source tree into a dependency graph. */
function loadModules(): SourceModule[] {
  return listTypeScriptFiles(SRC_DIR).map((filePath) => {
    const source = readFileSync(filePath, 'utf8');
    const imports = extractImportSpecifiers(source)
      .map((specifier) => resolveSpecifier(specifier, filePath))
      .filter((resolved): resolved is string => resolved !== null);

    return {
      layer: toLayer(filePath),
      displayPath: relative(process.cwd(), filePath),
      filePath,
      imports,
    };
  });
}

/**
 * Finds dependency cycles with an iterative depth-first search.
 *
 * @param modules - Dependency graph to inspect.
 * @returns One human readable cycle per detected loop.
 */
function findCycles(modules: readonly SourceModule[]): string[] {
  const byPath = new Map(modules.map((module) => [module.filePath, module]));
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const cycles: string[] = [];

  for (const module of modules) {
    colour.set(module.filePath, WHITE);
  }

  for (const start of modules) {
    if (colour.get(start.filePath) !== WHITE) {
      continue;
    }

    // I. Iterative DFS so that a deep tree cannot overflow the call stack.
    // 1. Each frame keeps the list of not-yet-visited children, which makes the
    //    current path reconstructible when a back edge is found.
    const path: string[] = [];
    const stack: { filePath: string; nextChild: number }[] = [
      { filePath: start.filePath, nextChild: 0 },
    ];
    colour.set(start.filePath, GREY);
    path.push(start.filePath);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame === undefined) {
        break;
      }
      const current = byPath.get(frame.filePath);
      const children = current?.imports ?? [];

      if (frame.nextChild >= children.length) {
        colour.set(frame.filePath, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const childPath = children[frame.nextChild];
      frame.nextChild += 1;
      if (childPath === undefined || !byPath.has(childPath)) {
        continue;
      }

      const childColour = colour.get(childPath);
      if (childColour === GREY) {
        const cycleStart = path.indexOf(childPath);
        const cycle = path.slice(cycleStart >= 0 ? cycleStart : 0);
        cycles.push([...cycle, childPath].map((p) => relative(process.cwd(), p)).join(' -> '));
        continue;
      }
      if (childColour === WHITE) {
        colour.set(childPath, GREY);
        path.push(childPath);
        stack.push({ filePath: childPath, nextChild: 0 });
      }
    }
  }

  return cycles;
}

describe('architecture constraints', () => {
  const modules = loadModules();

  it('discovers the source tree', () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it('assigns every file to a known layer', () => {
    const knownLayers = new Set<string>([
      'app',
      'audio',
      'config',
      'debug',
      'engine',
      'entities',
      'input',
      'interaction',
      'inventory',
      'particles',
      'physics',
      'player',
      'rendering',
      'save',
      'settings',
      'terrain',
      'ui',
      'utils',
      'workers',
      'world',
      'root',
    ]);

    const unknown = modules.filter((module) => !knownLayers.has(module.layer));
    expect(unknown.map((module) => module.displayPath)).toEqual([]);
  });

  it('contains no dependency cycles', () => {
    // Cyclic imports make module initialisation order observable and are the
    // usual root cause of "undefined at import time" bugs in engine code.
    expect(findCycles(modules)).toEqual([]);
  });

  it('never lets a UI-agnostic layer reach up into the UI or app assembly', () => {
    const byPath = new Map(modules.map((module) => [module.filePath, module]));
    const violations: string[] = [];

    for (const module of modules) {
      if (module.layer === 'root') {
        continue;
      }
      const isUiAgnostic = UI_AGNOSTIC_LAYERS.has(module.layer);
      const isTopLevel = TOP_LEVEL_LAYERS.has(module.layer);

      for (const importedPath of module.imports) {
        const target = byPath.get(importedPath);
        if (target === undefined || target.layer === 'root') {
          continue;
        }
        const targetLayer = target.layer;

        if (isUiAgnostic && (targetLayer === 'ui' || targetLayer === 'app')) {
          violations.push(
            `${module.displayPath} (${module.layer}) -> ${target.displayPath} (${targetLayer})`,
          );
        }
        if (isTopLevel && targetLayer === 'app' && module.filePath !== target.filePath) {
          violations.push(
            `${module.displayPath} (${module.layer}) -> ${target.displayPath} (${targetLayer})`,
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps production sources free of test imports', () => {
    const offenders = modules.filter((module) =>
      module.imports.some((imported) => relative(SRC_DIR, imported).startsWith(`..${sep}`)),
    );
    expect(offenders.map((module) => module.displayPath)).toEqual([]);
  });
});
