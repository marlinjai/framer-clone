// @vitest-environment node
// src/lib/books/engine/__tests__/importGraph.test.ts
//
// The browser's draft render imports nothing Node-only (WYSIWYG invoice editor
// plan, phase 4 constraint "The engine stays browser-safe"). Walks the value
// imports of the worker entry (render.worker.ts) and of the page entry
// (index.ts) with the TypeScript parser, type-only imports skipped, `@/`
// resolved to src, and fails on:
//   - a `node:` import, or a Node built-in without the prefix (fs, path, ...);
//   - the server's font loader (render/fonts.ts, reads files with node:fs) or
//     the upload checks (render/logoImage.ts, node:zlib);
//   - any package outside the allowlist (pdf-lib, @pdf-lib/fontkit, qrcode,
//     zod): a new one is a decision, checked in a real browser first;
//   - a value use of `Buffer`, `process` or `require` in any file of the graph.
// And the page entry must not reach the engine at all (pdf-lib stays in the
// worker's chunk, out of the editor's page bundle).

import { readFileSync, existsSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../..');
const ENGINE_DIR = path.join(SRC, 'lib', 'books', 'engine');
const ALLOWED_PACKAGES = new Set(['pdf-lib', '@pdf-lib/fontkit', 'qrcode', 'zod']);
const FORBIDDEN_FILES = [path.join(SRC, 'server/books/render/fonts.ts'), path.join(SRC, 'server/books/render/logoImage.ts')];
const BUILTINS = new Set(builtinModules.flatMap((m) => [m, m.split('/')[0]]));

interface Graph {
  files: string[];
  packages: Set<string>;
  problems: string[];
}

function resolveLocal(spec: string, from: string): string | null {
  const base = spec.startsWith('@/') ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (candidate.endsWith('.ts') || candidate.endsWith('.tsx') || candidate.endsWith('.json')) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** The value imports of a file (import declarations and re-exports that are not type-only, and dynamic imports). */
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
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
      out.push((node.arguments[0] as ts.StringLiteral).text);
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0] && ts.isStringLiteral(node.arguments[0])) {
      // new URL('./render.worker.ts', import.meta.url): the bundler follows it into the worker's chunk.
      const spec = (node.arguments[0] as ts.StringLiteral).text;
      if (spec.startsWith('./') && node.arguments[1]?.getText(sf) === 'import.meta.url') out.push(spec);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Value uses of Node globals (type positions such as `as Buffer` do not count). */
function nodeGlobals(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && ['Buffer', 'process', 'require', '__dirname'].includes(node.text)) {
      const parent = node.parent;
      const inType = ts.isTypeReferenceNode(parent) || ts.isExpressionWithTypeArguments(parent);
      const isProperty = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (!inType && !isProperty) found.push(`${path.relative(SRC, file)}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function walk(entry: string, opts: { followWorker: boolean }): Graph {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const problems: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.json')) continue;
    if (FORBIDDEN_FILES.includes(file)) problems.push(`imports ${path.relative(SRC, file)}`);
    problems.push(...nodeGlobals(file));
    for (const spec of valueImports(file)) {
      if (spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0])) {
        problems.push(`${path.relative(SRC, file)} imports the Node built-in ${spec}`);
        continue;
      }
      if (spec.startsWith('.') || spec.startsWith('@/')) {
        if (!opts.followWorker && spec.endsWith('.worker.ts')) continue;
        const target = resolveLocal(spec, file);
        if (!target) problems.push(`${path.relative(SRC, file)}: cannot resolve ${spec}`);
        else queue.push(target);
        continue;
      }
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      packages.add(pkg);
      if (!ALLOWED_PACKAGES.has(pkg)) problems.push(`${path.relative(SRC, file)} imports the package ${spec}`);
    }
  }
  return { files: [...seen].map((f) => path.relative(SRC, f)).sort(), packages, problems };
}

describe('the browser draft render imports nothing Node-only', () => {
  it('the worker entry and everything it imports', () => {
    const g = walk(path.join(ENGINE_DIR, 'render.worker.ts'), { followWorker: true });
    expect(g.problems).toEqual([]);
    // The walk really reaches the engine, the model and the draft path.
    expect(g.files).toEqual(
      expect.arrayContaining([
        'server/books/render/engine/index.ts',
        'server/books/render/model.ts',
        'server/books/render/draftRender.ts',
        'server/books/render/previewSafe.ts',
        'server/books/render/fontPins.ts',
        'server/books/render/epcQr.ts',
      ]),
    );
    expect([...g.packages].sort()).toEqual(['@pdf-lib/fontkit', 'pdf-lib', 'qrcode', 'zod']);
  });

  it('the page entry, worker included', () => {
    expect(walk(path.join(ENGINE_DIR, 'index.ts'), { followWorker: true }).problems).toEqual([]);
  });

  it('the page entry without the worker reaches no engine (pdf-lib stays in the worker chunk)', () => {
    const g = walk(path.join(ENGINE_DIR, 'index.ts'), { followWorker: false });
    expect(g.problems).toEqual([]);
    expect(g.files.filter((f) => f.startsWith('server/books/render/engine'))).toEqual([]);
    expect(g.packages.has('pdf-lib')).toBe(false);
    expect(g.packages.has('@pdf-lib/fontkit')).toBe(false);
  });

  it('the walk catches what it must (a self-check on the server loader)', () => {
    const g = walk(path.join(SRC, 'server/books/render/store.ts'), { followWorker: false });
    expect(g.problems.some((p) => p.includes('node:crypto'))).toBe(true);
    expect(g.problems.some((p) => p.includes('imports server/books/render/fonts.ts'))).toBe(true);
    expect(g.problems.some((p) => p.endsWith(': Buffer'))).toBe(true);
  });
});
