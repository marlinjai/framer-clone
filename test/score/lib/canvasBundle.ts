// Bundles the real editor for a plain Chromium page, so a contract can run on the
// mounted canvas with no Next.js server, database or sign-in. Stubbed: server
// actions and the framework's router, because nothing behind them is under test.
// Everything from EditorApp down to the DOM is the code the product ships.

import fs from 'node:fs';
import path from 'node:path';
import { build, type Plugin } from 'esbuild';
import type { Browser, Page } from 'playwright';
import { ComponentTypeEnum } from '@/models/ComponentModel';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { OUT_DIR } from './io';
import { readPublishedBase } from './publishedBase';

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

export async function bundleEditor(entry = 'test/score/canvas/entry.tsx', name = 'canvas-bundle'): Promise<string> {
  const outfile = path.join(OUT_DIR, `${name}.js`);
  await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
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

/** A tree as the model stores it. A child names its parent, which is what lets it take its own pointer press on the canvas. */
export const toSnapshot = (node: ComponentNode, parentId?: string): Record<string, unknown> => ({
  id: node.id,
  type: node.type,
  componentType: ComponentTypeEnum.HOST,
  props: node.props ?? {},
  ...(parentId ? { parentId } : {}),
  children: (node.children ?? []).map((child) => toSnapshot(child, node.id)),
});

export interface MountOptions {
  /** Keep every breakpoint frame, for a contract that compares them. */
  allFrames?: boolean;
  /** Placed on the canvas outside any frame. */
  floating?: ComponentNode[];
}

/** The editor, loaded with nothing placed. No server behind this page: every request it makes gets an empty answer. */
export async function openEditor(browser: Browser, bundle: string, contextOptions: Parameters<Browser['newPage']>[0] = {}): Promise<{ page: Page; crashes: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ...contextOptions });
  page.setDefaultTimeout(1500);
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.goto('http://canvas-probe.local/');
  // The bundle leaves CSS out, and the real editor sits under the same root layout as a
  // published page. Without this sheet a comparison would hold a page with a reset
  // against one without, and the overlays would take the pointer: their utilities are here.
  const { css, meta } = readPublishedBase();
  await page.setContent(`<!doctype html><html lang="en" class="${meta.htmlClass}"><head><meta charset="utf-8"><style>${css}</style></head><body class="${meta.bodyClass}"><div id="root"></div></body></html>`);
  await page.addScriptTag({ path: bundle });
  // The frames open under the left sidebar, as they do at this window size. A person
  // pans them out of it first, and so does a contract that clicks.
  await page.locator('[data-ground]').first().waitFor({ state: 'attached' });
  await page.mouse.move(1200, 500);
  await page.mouse.wheel(-280, 0);
  return { page, crashes };
}

interface PlaceWindow {
  __placeTree: (snapshot: unknown, options: { allFrames?: boolean; floating?: unknown[] }) => void;
}

/** Puts a tree on an open editor and waits for it. A broken mount throws: that is a harness error, not a score. */
export async function placeTree(page: Page, crashes: readonly string[], tree: ComponentNode, options: MountOptions = {}): Promise<void> {
  const placed = { allFrames: options.allFrames, floating: options.floating?.map((node) => toSnapshot(node)) };
  await page.evaluate(([snapshot, opts]) => (window as unknown as PlaceWindow).__placeTree(snapshot, opts as never), [toSnapshot(tree), placed] as const);
  await page.locator(`[data-viewport-content-id] [data-inner-component-id="${tree.id}"]`).first().waitFor({ state: 'attached' });
  if (crashes.length > 0) throw new Error(`the editor crashed on the canvas: ${crashes[0]}`);
}

/** The editor open with the tree in it. */
export async function mountOnCanvas(browser: Browser, bundle: string, tree: ComponentNode, options: MountOptions = {}): Promise<Page> {
  const { page, crashes } = await openEditor(browser, bundle);
  await placeTree(page, crashes, tree, options);
  return page;
}
