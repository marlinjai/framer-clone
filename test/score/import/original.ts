// The original side of an import fixture: the real component, bundled with esbuild and
// run in the page, styled by real Tailwind compiled over its theme. It sits on the same
// page a visitor gets, the published base with its classes on `html` and `body`, so under
// the repo's theme it is the component in this app, and under the foreign theme it is the
// component in an app of that theme. An original is code we pinned, so running it here is
// the same as running any test: the importer never runs it.
//
// Candidates are every word of every string in the fixture's files, which is how the
// contract's probes read them. Tailwind drops what is no class.

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { compile } from 'tailwindcss';
import ts from 'typescript';
import { publishedDocument } from '../lib/published';

const ROOT = path.resolve(__dirname, '../../..');
const MODULES = path.join(ROOT, 'node_modules');

/** Tailwind's two packages, from `node_modules`, and relative imports inside them. */
async function loadStylesheet(id: string, base: string): Promise<{ path: string; base: string; content: string }> {
  const file = id === 'tailwindcss'
    ? path.join(MODULES, 'tailwindcss/index.css')
    : id === 'tw-animate-css'
      ? path.join(MODULES, 'tw-animate-css/dist/tw-animate.css')
      : id.startsWith('.') ? path.resolve(base, id) : '';
  if (!file || !file.startsWith(MODULES)) throw new Error(`the original compile loads only Tailwind's own files, not ${id}`);
  return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
}

/** Every word of every string and template piece in a source file. */
function candidatesOf(text: string, name: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const words: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      words.push(...node.text.split(/\s+/).filter(Boolean));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return words;
}

/** The theme and every class the fixture's files name, as real Tailwind compiles them. */
export async function originalCss(theme: string, files: readonly string[]): Promise<string> {
  const compiler = await compile(theme, { base: ROOT, loadStylesheet, loadModule: async () => { throw new Error('no plugin runs here'); } });
  const candidates = new Set(files.flatMap((file) => candidatesOf(fs.readFileSync(file, 'utf8'), file)));
  return compiler.build([...candidates]);
}

/** The mount script of an entry, bundled as the page runs it. */
export async function mountScript(entry: string): Promise<string> {
  const { outputFiles } = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    jsx: 'automatic',
    tsconfig: path.join(ROOT, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  return outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
}

/** The original page: the published base, the fixture's own sheet, and its component mounted in `#root`. */
export function originalDocument(css: string, script: string): string {
  return publishedDocument({ html: `<div id="root"></div><script>${script}</script>`, css });
}
