// @vitest-environment node
// src/lib/fx/__tests__/boundaryGuard.test.ts
//
// Pins the FX engine's import boundary (rules FX1 and FX2 of
// scripts/check-guards.mjs, run by `pnpm lint:guards` and CI): the engine
// imports nothing from the rest of the repository and only its allowed
// packages, and the rest of the app reaches it only through `@/lib/fx`. Each
// rule is fed a known-bad sample and must trip; the forms the code really uses
// must stay clean. Excluded from the scan itself, because its samples are
// banned imports on purpose.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ROOTS,
  FX_ALLOWED_PACKAGES,
  FX_DIR,
  FX_RENDER_ENTRY,
  FX_TEST_PACKAGES,
  collectFiles,
  moduleSpecifiers,
  readKnownTenantTables,
  scanText,
} from '../../../../scripts/check-guards.mjs';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const knownTables = readKnownTenantTables();

function rules(filePath: string, text: string): string[] {
  return scanText({ path: filePath, text, knownTables }).map((v: { rule: string }) => v.rule);
}

const ENGINE_FILE = 'src/lib/fx/layers/gradient.tsx';
const APP_FILE = 'src/lib/renderer/server/FxIsland.tsx';

describe('moduleSpecifiers', () => {
  it('reads static imports, re-exports, bare imports, dynamic imports and require', () => {
    const code = [
      `import a from 'pkg-a';`,
      `import { b,\n  c } from "pkg-b";`,
      `import type { T } from './types';`,
      `export { d } from '../d';`,
      `export * from './all';`,
      `import './side-effect';`,
      `const e = await import('pkg-e');`,
      `const f = require("pkg-f");`,
    ].join('\n');
    expect(moduleSpecifiers(code).map((s: { specifier: string | null }) => s.specifier)).toEqual([
      'pkg-a',
      'pkg-b',
      './types',
      '../d',
      './all',
      './side-effect',
      'pkg-e',
      'pkg-f',
    ]);
  });

  it('reports a computed dynamic import as unreadable', () => {
    expect(moduleSpecifiers('const m = await import(name);')).toEqual([{ specifier: null, index: 16 }]);
    expect(moduleSpecifiers('const m = await import(`./layers/${name}`);')[0].specifier).toBeNull();
  });

  it('does not read an exported declaration as a re-export', () => {
    expect(moduleSpecifiers(`export function from(x: string) { return x; }\nexport const y = 'from';`)).toEqual([]);
  });
});

describe('FX1: the engine imports nothing from the rest of the repository', () => {
  it('allows relative imports that stay inside the engine', () => {
    expect(rules(ENGINE_FILE, `import { x } from '../registry';\nimport y from './contentBlend';`)).toEqual([]);
    expect(rules('src/lib/fx/index.ts', `export { LumitraScene } from './LumitraScene';\nimport './builtins';`)).toEqual([]);
    expect(rules('src/lib/fx/__tests__/a.test.ts', `import j from './fixtures/v7.json';`)).toEqual([]);
  });

  it('allows the engine alias onto itself', () => {
    expect(rules(ENGINE_FILE, `import { x } from '@/lib/fx/registry';`)).toEqual([]);
  });

  it('allows the test runner, the TypeScript parser and Node built-ins in the engine tests only', () => {
    const TEST_FILE = 'src/lib/fx/__tests__/importGraph.test.ts';
    for (const name of FX_TEST_PACKAGES) {
      expect(rules(TEST_FILE, `import x from '${name}';`)).toEqual([]);
      expect(rules(ENGINE_FILE, `import x from '${name}';`)).toEqual(['FX1']);
    }
    expect(rules(TEST_FILE, `import { readFileSync } from 'node:fs';`)).toEqual([]);
    expect(rules(ENGINE_FILE, `import { readFileSync } from 'node:fs';`)).toEqual(['FX1']);
    // Without the prefix a built-in is not told apart from a package, in a test too.
    expect(rules(TEST_FILE, `import { readFileSync } from 'fs';`)).toEqual(['FX1']);
    // A test still imports nothing from the rest of the repository.
    expect(rules(TEST_FILE, `import { x } from '@/lib/renderer';`)).toEqual(['FX1']);
  });

  it('allows every listed package and its subpaths', () => {
    for (const name of FX_ALLOWED_PACKAGES) {
      expect(rules(ENGINE_FILE, `import x from '${name}';`)).toEqual([]);
    }
    expect(rules(ENGINE_FILE, `import('react-dom/client');\nimport { X } from 'three/addons/x.js';`)).toEqual([]);
  });

  it('flags an alias import of app code', () => {
    expect(rules(ENGINE_FILE, `import { store } from '@/stores/EditorStore';`)).toEqual(['FX1']);
  });

  it('flags a relative import that escapes the engine', () => {
    expect(rules(ENGINE_FILE, `import { cn } from '../../utils';`)).toEqual(['FX1']);
    expect(rules('src/lib/fx/index.ts', `export * from '../renderer';`)).toEqual(['FX1']);
  });

  it('flags a dynamic import and a require of app code', () => {
    expect(rules(ENGINE_FILE, `const m = await import('@/lib/renderer');`)).toEqual(['FX1']);
    expect(rules(ENGINE_FILE, `const m = require('../../behaviour');`)).toEqual(['FX1']);
  });

  it('flags a dynamic import whose target cannot be read', () => {
    expect(rules(ENGINE_FILE, 'const m = await import(target);')).toEqual(['FX1']);
  });

  it('flags the packages the plan keeps out of Sites, and any unlisted one', () => {
    expect(rules(ENGINE_FILE, `import { useControls } from 'leva';`)).toEqual(['FX1']);
    expect(rules(ENGINE_FILE, `import { PerformanceMonitor } from '@react-three/drei';`)).toEqual(['FX1']);
    expect(rules(ENGINE_FILE, `import gsap from 'gsap';`)).toEqual(['FX1']);
    // A name that merely starts like an allowed package is a different package.
    expect(rules(ENGINE_FILE, `import x from 'three-stdlib';`)).toEqual(['FX1']);
    expect(rules(ENGINE_FILE, `import x from 'react-three-fiber';`)).toEqual(['FX1']);
  });

  it('ignores an import that is only named in a comment', () => {
    expect(rules(ENGINE_FILE, `// import { store } from '@/stores/EditorStore';\n/* import 'leva'; */`)).toEqual([]);
  });
});

describe('FX2: the app reaches the engine only through its public entry', () => {
  it('allows the render-free entry', () => {
    expect(rules(APP_FILE, `import { parseFx } from '@/lib/fx/format';`)).toEqual([]);
    expect(rules(APP_FILE, `import { parseFx } from '../../fx/format.ts';`)).toEqual([]);
    expect(rules(APP_FILE, `import { x } from '@/lib/fx/formatting';`)).toEqual(['FX2']);
  });

  it('allows the public entry, by alias and by relative path', () => {
    expect(rules(APP_FILE, `import { LumitraScene } from '@/lib/fx';`)).toEqual([]);
    expect(rules(APP_FILE, `const fx = await import('@/lib/fx');`)).toEqual([]);
    expect(rules(APP_FILE, `import type { SceneConfig } from '@/lib/fx/index';`)).toEqual([]);
    expect(rules(APP_FILE, `import { LumitraScene } from '../../fx';`)).toEqual([]);
    expect(rules(APP_FILE, `import { LumitraScene } from '../../fx/index.ts';`)).toEqual([]);
  });

  it('flags a deep import, by alias and by relative path', () => {
    expect(rules(APP_FILE, `import { getLayerDefinition } from '@/lib/fx/registry';`)).toEqual(['FX2']);
    expect(rules(APP_FILE, `import { GradientLayer } from '../../fx/layers/gradient';`)).toEqual(['FX2']);
    expect(rules('scripts/tool.ts', `import { deserializeScene } from '../src/lib/fx/serialize';`)).toEqual(['FX2']);
  });

  it('flags a deep dynamic import, re-export and type import', () => {
    expect(rules(APP_FILE, `const m = await import('@/lib/fx/LumitraScene');`)).toEqual(['FX2']);
    expect(rules(APP_FILE, `export { PRESETS } from '@/lib/fx/presets';`)).toEqual(['FX2']);
    expect(rules(APP_FILE, `import type { SceneConfig } from '@/lib/fx/types';`)).toEqual(['FX2']);
  });

  it('leaves a neighbour whose name only starts like the engine alone', () => {
    expect(rules(APP_FILE, `import { x } from '@/lib/fxTools/thing';`)).toEqual([]);
  });

  it('leaves app code that imports other app code alone', () => {
    expect(rules(APP_FILE, `import { x } from '@/lib/renderer';\nconst m = await import(target);`)).toEqual([]);
  });
});

describe('the repository as it is', () => {
  // One walk and one read of every scanned file, shared by the tests below.
  // About 1,700 files: quick alone, but given room for a loaded machine.
  const SCAN_TIMEOUT_MS = 60_000;
  let files: string[] = [];
  let sources = new Map<string, string>();

  beforeAll(() => {
    files = collectFiles(DEFAULT_ROOTS);
    sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  }, SCAN_TIMEOUT_MS);

  it(
    'is clean under the boundary rules',
    () => {
      const found: Array<{ rule: string; line: number; path: string }> = [];
      for (const [file, text] of sources) {
        for (const v of scanText({ path: file, text, knownTables }) as Array<{ rule: string; line: number }>) {
          if (v.rule.startsWith('FX')) found.push({ rule: v.rule, line: v.line, path: path.relative(REPO_ROOT, file) });
        }
      }
      expect(found).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it('scans the engine itself', () => {
    const engine = files.filter((f) => f.includes(`${path.sep}src${path.sep}lib${path.sep}fx${path.sep}`));
    expect(engine.length).toBeGreaterThan(30);
  });

  // Until slice F3 of the plan mounts the scene from the published page's island
  // (and replaces this test with the bundle tests `fx-no-bytes-without-fx` and
  // `fx-bundle-budget`), nothing outside the engine imports its render entry
  // (`@/lib/fx`), so no page's bundle carries three.js. The render-free entry
  // (`@/lib/fx/format`) is imported by the app and proven free of three.js in
  // importGraph.test.ts.
  it(
    'has no importer of the render entry outside the engine yet, so no bundle carries three.js',
    () => {
      const fxAbs = path.join(REPO_ROOT, FX_DIR);
      const renderEntry = path.join(REPO_ROOT, FX_RENDER_ENTRY);
      const importers: string[] = [];
      for (const [file, code] of sources) {
        if (file.startsWith(`${fxAbs}${path.sep}`)) continue;
        if (!code.includes('fx')) continue;
        for (const { specifier } of moduleSpecifiers(code) as Array<{ specifier: string | null }>) {
          if (!specifier) continue;
          const target = specifier.startsWith('@/')
            ? path.join(REPO_ROOT, 'src', specifier.slice(2))
            : specifier.startsWith('.')
              ? path.resolve(path.dirname(file), specifier)
              : null;
          if (!target) continue;
          const bare = target.replace(/\.(?:ts|tsx)$/, '');
          if (bare === fxAbs || bare === renderEntry) importers.push(path.relative(REPO_ROOT, file));
        }
      }
      expect(importers).toEqual([]);
    },
    SCAN_TIMEOUT_MS,
  );

  it('has importers of the render-free entry', () => {
    const formatEntry = '@/lib/fx/format';
    expect([...sources.values()].some((code) => code.includes(`'${formatEntry}'`))).toBe(true);
  });
});
