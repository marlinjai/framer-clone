// Bundles the real editor for a plain Chromium page, so a contract can run on the
// mounted canvas with no Next.js server, database or sign-in. Stubbed: server
// actions and the framework's router, because nothing behind them is under test.
// Everything from EditorApp down to the DOM is the code the product ships.

import fs from 'node:fs';
import path from 'node:path';
import { build, type Plugin } from 'esbuild';
import { OUT_DIR } from './io';

const ROOT = process.cwd();

/** A `'use server'` module's exports as functions that say so, in place of its server code. */
function serverActionStub(source: string): string {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function\s*\*?|const|let)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const exported = part.trim().split(/\s+as\s+/).pop();
      if (exported && !exported.startsWith('type ')) names.add(exported);
    }
  }
  const stubs = [...names].map(
    (name) => `export const ${name} = async () => { throw new Error('server action ${name} does not run in the score harness'); };`,
  );
  return stubs.join('\n');
}

const serverEdge: Plugin = {
  name: 'score-server-edge',
  setup(b) {
    b.onResolve({ filter: /^@\// }, (args) => {
      const base = path.join(ROOT, 'src', args.path.slice(2));
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { path: candidate };
      }
      return undefined;
    });
    b.onResolve({ filter: /^server-only$/ }, () => ({ path: path.join(ROOT, 'test/stubs/server-only.ts') }));
    b.onResolve({ filter: /^next\/(navigation|headers|cache)$/ }, () => ({ path: path.join(ROOT, 'test/score/canvas/nextStub.ts') }));
    b.onLoad({ filter: /[/\\]src[/\\].*\.tsx?$/ }, (args) => {
      const source = fs.readFileSync(args.path, 'utf8');
      if (!/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*|\s)*['"]use server['"]/.test(source)) return undefined;
      return { contents: serverActionStub(source), loader: 'ts' };
    });
  },
};

export async function bundleEditor(): Promise<string> {
  const outfile = path.join(OUT_DIR, 'canvas-bundle.js');
  await build({
    absWorkingDir: ROOT,
    entryPoints: ['test/score/canvas/entry.tsx'],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'empty', '.ttf': 'empty' },
    define: { 'process.env.NODE_ENV': '"development"', global: 'globalThis' },
    banner: { js: 'globalThis.process = { env: {} };' },
    plugins: [serverEdge],
  });
  return outfile;
}
