// @vitest-environment node
// src/lib/fx/__tests__/importGraph.test.ts
//
// The engine's render-free entry (../format) stays render-free. Lumitra Sites
// reads a stored FX scene on the server, in the editor's renderer and in
// validators; if that entry ever reached the renderer, every one of them would
// load three.js. Walks the value imports of format.ts with the TypeScript
// parser (type-only imports skipped, as the bundler drops them) and fails on:
//   - any package at all (the format needs none; three, the react-three
//     packages, postprocessing and react are named in the message);
//   - a `.tsx` file or a file that starts with "use client" (a component);
//   - a file of the renderer by name (the components, the layer files).
// And the render entry (../index) must reach the renderer: the check has to be
// able to fail.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FX_DIR = path.resolve(__dirname, '..');

function resolveLocal(spec: string, from: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (/\.(?:ts|tsx|json)$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** The value imports of a file: imports and re-exports that are not type-only, and dynamic imports. */
function valueImports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) out.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
      const arg = node.arguments[0];
      out.push(ts.isStringLiteral(arg) ? arg.text : '<computed>');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

interface Graph {
  files: string[];
  packages: string[];
  unresolved: string[];
}

function graphOf(entry: string): Graph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (file.endsWith('.json')) continue;
    for (const spec of valueImports(file)) {
      if (!spec.startsWith('.')) {
        packages.add(spec);
        continue;
      }
      const target = resolveLocal(spec, file);
      if (target) queue.push(target);
      else unresolved.push(`${path.relative(FX_DIR, file)} -> ${spec}`);
    }
  }
  return {
    files: [...files].map((f) => path.relative(FX_DIR, f)).sort(),
    packages: [...packages].sort(),
    unresolved,
  };
}

const RENDERER_FILES = /^(?:LumitraScene|FrameRateMonitor|createScene|builtins|interactivity)\.tsx?$|^(?:layers|effects)\//;

describe('the render-free entry (format.ts)', () => {
  const graph = graphOf(path.join(FX_DIR, 'format.ts'));

  it('resolves every import it follows', () => {
    expect(graph.unresolved).toEqual([]);
  });

  it('imports no package: not three, not the react-three packages, not postprocessing, not react', () => {
    expect(graph.packages).toEqual([]);
  });

  it('reaches no component: no .tsx file and no "use client" file', () => {
    const components = graph.files.filter((f) => f.endsWith('.tsx') || /^\s*["']use client["']/.test(readFileSync(path.join(FX_DIR, f), 'utf8')));
    expect(components).toEqual([]);
  });

  it('reaches no file of the renderer', () => {
    expect(graph.files.filter((f) => RENDERER_FILES.test(f))).toEqual([]);
  });

  it('is exactly the data files', () => {
    expect(graph.files).toEqual([
      'format.ts',
      'layerOps.ts',
      'presets/index.ts',
      'presets/preset-bokeh-focuspull.json',
      'presets/preset-godrays-hero.json',
      'presets/preset-gold-noise-gradient.json',
      'presets/preset-noise-gradient.json',
      'registry.ts',
      'schemas.ts',
      'serialize.ts',
      'types.ts',
    ]);
  });
});

describe('the render entry (index.ts), so the check above can fail', () => {
  const graph = graphOf(path.join(FX_DIR, 'index.ts'));

  it('reaches three.js and the renderer', () => {
    expect(graph.packages).toEqual(expect.arrayContaining(['three', '@react-three/fiber', '@react-three/postprocessing', 'postprocessing']));
    expect(graph.files.some((f) => RENDERER_FILES.test(f))).toBe(true);
  });

  it('holds none of the packages the plan keeps out of Sites', () => {
    expect(graph.packages.filter((p) => /^(?:leva|@react-three\/drei|gsap)(?:\/|$)/.test(p))).toEqual([]);
  });
});
