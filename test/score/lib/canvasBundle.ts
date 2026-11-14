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
import { editorSheet } from './editorSheet';
import { withoutEditorSurfaceProps } from '@/lib/renderer/blockedNodes';

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

/** What of a tree the editor surfaces drop on purpose (blockedNodes.ts), named in a canvas cell's note. */
export function droppedOnEditor(root: ComponentNode): string[] {
  const out = new Set<string>();
  const walk = (node: ComponentNode) => {
    const props = (node.props ?? {}) as Record<string, unknown>;
    const kept = withoutEditorSurfaceProps(node.type, props);
    for (const name of Object.keys(props)) if (!(name in kept)) out.add(name.toLowerCase());
    node.children?.forEach(walk);
  };
  walk(root);
  return [...out].sort();
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

/**
 * The cascade layer order the built editor's own stylesheet opens with (`@layer properties;` then
 * theme, base, components, utilities), stated first. The published base sheet below declares the
 * four without `properties`, and a layer takes its place at its first mention, so the editor sheet's
 * `@layer properties` block would otherwise come last and win over every utility. That block is
 * Tailwind's fallback for browsers without `margin-trim: inline`, which includes the WebKit build
 * Playwright ships and Safari: it sets `--tw-translate-x: 0` and its kin on every element, and there
 * the editor's dialogs came out uncentred, below the window (found in slice H3, measured against the
 * real build, where the order is right and a dialog sits where it should).
 */
const LAYER_ORDER = '@layer properties, theme, base, components, utilities;';

export interface MountOptions {
  /** Keep every breakpoint frame, for a contract that compares them. */
  allFrames?: boolean;
  /** Placed on the canvas outside any frame. */
  floating?: ComponentNode[];
}

/**
 * The editor, loaded with nothing placed. No server behind this page: every request it makes
 * gets an empty answer. `beforeLoad` runs on the new page before anything is loaded into it,
 * for an init script or a route of its own, which Playwright tries before the empty answer.
 */
export async function openEditor(
  browser: Browser,
  bundle: string,
  contextOptions: Parameters<Browser['newPage']>[0] = {},
  beforeLoad?: (page: Page) => Promise<void>,
): Promise<{ page: Page; crashes: string[] }> {
  const { page, crashes } = await openBundle(browser, bundle, contextOptions, beforeLoad);
  // The frames open under the left sidebar, as they do at this window size. A person
  // pans them out of it first, and so does a contract that clicks. A phone has no
  // sidebar beside the canvas, and mobile WebKit has no wheel.
  await page.locator('[data-ground]').first().waitFor({ state: 'attached' });
  if (!contextOptions.isMobile) {
    await page.mouse.move(1200, 500);
    await page.mouse.wheel(-280, 0);
  }
  return { page, crashes };
}

/** A bundle on the editor's document (its sheets, fonts and viewport line), for a screen with no canvas. */
export async function openBundle(
  browser: Browser,
  bundle: string,
  contextOptions: Parameters<Browser['newPage']>[0] = {},
  beforeLoad?: (page: Page) => Promise<void>,
): Promise<{ page: Page; crashes: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, ...contextOptions });
  page.setDefaultTimeout(1500);
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await beforeLoad?.(page);
  await page.goto('http://canvas-probe.local/');
  // The bundle leaves CSS out. The real editor sits under the same root layout as a
  // published page (its fonts and html and body classes, from the published base) and
  // links the editor sheet, globals.css. Without that sheet a comparison would hold a page
  // with a reset against one without, and the overlays would take the pointer: their
  // utilities are there. The published base's own sheet is the editor sheet's reset,
  // tokens and base layer again, so the two together cascade as the editor's alone.
  // The viewport line is the one Next writes into the editor's document. Without it a phone
  // lays the page out at 980 pixels and scales it down, so 390 would not be 390. A desktop
  // window ignores it.
  const { css, meta } = readPublishedBase();
  const editorCss = await editorSheet();
  await page.setContent(`<!doctype html><html lang="en" class="${meta.htmlClass}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${LAYER_ORDER}</style><style>${css}</style><style>${editorCss}</style></head><body class="${meta.bodyClass}"><div id="root"></div></body></html>`);
  await page.addScriptTag({ path: bundle });
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

/**
 * The Interact tool, entered with the toolbar's own button, as a person does it. Resolves
 * once every frame runs its page (`data-surface-running`, set by useSurfaceRuntime).
 */
export async function enterInteract(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Interact' }).click();
  await page.waitForFunction(() => {
    const frames = [...document.querySelectorAll('[data-viewport-content-id]')];
    return frames.length > 0 && frames.every((frame) => frame.hasAttribute('data-surface-running'));
  });
}

/** The editor open with the tree in it. */
export async function mountOnCanvas(browser: Browser, bundle: string, tree: ComponentNode, options: MountOptions = {}): Promise<Page> {
  const { page, crashes } = await openEditor(browser, bundle);
  await placeTree(page, crashes, tree, options);
  return page;
}
