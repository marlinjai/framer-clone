// The published page's own stylesheet on a real build (docs/plans/2026-11-01-agent-fleet.md,
// fleet slice "published sheet"). A published page links the site sheet (src/app/(site)/site.css:
// Tailwind's reset, the theme tokens, the base layer) and never the editor's globals.css, whose
// utilities and `@property` registrations follow whatever the editor UI happens to use. Checked
// on what the browser actually loaded for every published surface: a page on each page base,
// the consent banner, the commerce islands, a dark site and the default 404. The editor's own
// route still links the editor sheet.
//
// With PUBLISHED_SHEET_SHOTS=<dir>, each surface is also saved as a screenshot there, so two
// builds can be compared pixel by pixel.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { PNG } from 'pngjs';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { EDITOR_SHEET_MARKERS } from '../score/lib/publishedBase';

const SCOPE: TenantScope = {
  workspaceId: `ws_sheet_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c4',
};

const SHOTS = process.env.PUBLISHED_SHEET_SHOTS;

const frames = Object.fromEntries(
  DEFAULT_VIEWPORTS.map((v) => [
    v.label.toLowerCase(),
    { id: v.label.toLowerCase(), type: 'div', componentType: 'host', canvasNodeType: 'viewport', breakpointId: v.label.toLowerCase(), breakpointMinWidth: v.minWidth, label: v.label, viewportWidth: v.width, viewportHeight: v.height, props: {}, children: [] },
  ]),
);

type Props = Record<string, unknown>;
interface StoredNode { id: string; type: string; componentType: 'host'; props: Props; children: StoredNode[] }
const node = (id: string, type: string, props: Props = {}, ...children: StoredNode[]): StoredNode => ({ id, type, componentType: 'host', props: { 'data-t': id, ...props }, children });

/**
 * A gradient written as Tailwind 3 writes `bg-gradient-to-r from-red-500 to-blue-500`: the
 * stops carry a position variable. Under Tailwind 4's strict `<color>` registration of
 * `--tw-gradient-from` this value is invalid at computed time and the gradient goes transparent.
 */
const TAILWIND3_GRADIENT = {
  backgroundImage: 'linear-gradient(to right, var(--tw-gradient-stops))',
  '--tw-gradient-from': '#ef4444 var(--tw-gradient-from-position)',
  '--tw-gradient-to': '#3b82f6 var(--tw-gradient-to-position)',
  '--tw-gradient-stops': 'var(--tw-gradient-from), var(--tw-gradient-to)',
  // Tailwind 3's base gives every element these, empty.
  '--tw-gradient-from-position': ' ',
  '--tw-gradient-to-position': ' ',
  height: '80px',
};

/** Elements the reset and the base layer decide the look of, and the gradient. */
const home = () =>
  node('page-root', 'div', { style: { padding: '24px' } },
    node('title', 'h1', { children: 'A published page' }),
    node('lead', 'p', { children: 'Body text with a link.' }),
    node('list', 'ul', {}, node('one', 'li', { children: 'First' }), node('two', 'li', { children: 'Second' })),
    node('field', 'input', { placeholder: 'Your email' }),
    node('press', 'button', { type: 'button', children: 'Press' }),
    node('box', 'div', { style: { borderWidth: '2px', padding: '8px' }, children: 'A bordered box' }),
    node('gradient', 'div', { style: TAILWIND3_GRADIENT }),
  );

/** The two commerce islands that render without a product: the cart and the checkout button. */
const shop = () =>
  node('page-root', 'div', { style: { padding: '24px' } },
    node('cart', 'div', { 'data-component-kind': 'cart-view' }),
    node('checkout', 'button', { 'data-component-kind': 'checkout-button', children: 'Checkout' }),
  );

const stored = (slug: string, tree: StoredNode) => ({ id: slug || 'home', slug, metadata: { title: slug || 'Home' }, appComponentTree: tree, canvasNodes: frames });

/** A published site with the home and shop pages; `analytics` shows the real consent banner. */
async function publish(port: string, { analytics = false, siteSettings }: { analytics?: boolean; siteSettings?: Record<string, unknown> } = {}): Promise<string> {
  const repo = getSiteRepository();
  const siteId = randomUUID();
  const project = {
    id: siteId,
    metadata: { title: 'Sheet', description: '', createdAt: 1, updatedAt: 2 },
    pages: { home: stored('', home()), shop: stored('shop', shop()) },
    ...(analytics ? { lumitra: { enabled: true } } : {}),
    ...(siteSettings ? { siteSettings } : {}),
  };
  const saved = await repo.saveProject(SCOPE, project as never);
  await repo.publishProject(SCOPE, project as never, { expectedVersion: saved.version });
  const { subdomain } = await repo.ensureSiteDomain(SCOPE, siteId);
  return `http://${subdomain}.sites.localhost:${port}`;
}

const DARK_THEME = {
  mode: 'dark',
  tokens: [{ id: 'gr000001', name: 'Ground', kind: 'color', light: '#ffffff', dark: '#030712' }],
  document: { backgroundColor: 'var(--fc-t-gr000001)' },
};

interface Surface {
  name: string;
  url: string;
  /** The response status the surface answers with. */
  status: number;
  /** Shown once the surface is ready. */
  ready: string;
}

let browser: Browser;
const surfaces: Surface[] = [];
let editorUrl: string;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const port = process.env.BEHAVIOUR_PORT as string;
  const reset = await publish(port, { analytics: true });
  const browserBase = await publish(port, { siteSettings: { pageBase: 'browser' } });
  const dark = await publish(port, { siteSettings: { theme: DARK_THEME } });
  surfaces.push(
    { name: 'page-reset-banner', url: `${reset}/`, status: 200, ready: '[data-fc-consent-accept]' },
    { name: 'page-browser-base', url: `${browserBase}/`, status: 200, ready: '[data-t="gradient"]' },
    { name: 'page-dark', url: `${dark}/`, status: 200, ready: '[data-t="gradient"]' },
    { name: 'commerce-islands', url: `${browserBase}/shop`, status: 200, ready: '[data-t="checkout"]:not([aria-busy="true"])' },
    { name: 'default-404', url: `${browserBase}/${randomBytes(4).toString('hex')}`, status: 404, ready: 'body' },
    { name: 'unknown-host-404', url: `http://nobody-${randomBytes(4).toString('hex')}.sites.localhost:${port}/`, status: 404, ready: 'body' },
  );
  editorUrl = `http://localhost:${port}/`;
  browser = await chromium.launch();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await getPrismaClient().$disconnect();
});

/** Opens a surface and returns the text of every stylesheet the browser loaded for it. */
async function open(surface: { name: string; url: string; status?: number; ready: string }): Promise<{ page: Page; sheets: Map<string, string> }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const sheets = new Map<string, string>();
  page.on('response', async (response) => {
    if (response.request().resourceType() !== 'stylesheet') return;
    sheets.set(new URL(response.url()).pathname, await response.text());
  });
  const response = await page.goto(surface.url, { waitUntil: 'networkidle' });
  if (surface.status !== undefined) expect(response?.status(), surface.name).toBe(surface.status);
  await page.locator(surface.ready).first().waitFor({ state: 'visible' });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${surface.name}.png`), fullPage: true });
  return { page, sheets };
}

const joined = (sheets: Map<string, string>) => [...sheets.values()].join('\n');

describe('a published page on a real build', () => {
  /** What each surface loaded, read once: every surface answers before any is judged. */
  const loaded = new Map<string, string>();

  it('answers on every published surface', async () => {
    for (const surface of surfaces) {
      const { page, sheets } = await open(surface);
      await page.close();
      expect(sheets.size, `${surface.name} loads stylesheets`).toBeGreaterThan(0);
      loaded.set(surface.name, joined(sheets));
    }
  }, 120_000);

  it('loads the site sheet on every published surface and never the editor sheet', () => {
    expect([...loaded.keys()]).toEqual(surfaces.map((surface) => surface.name));
    for (const [name, css] of loaded) {
      // The site sheet: the reset and the theme tokens of the base layer.
      expect(css, name).toContain('--background:');
      expect(css, name).toContain('@layer base');
      for (const marker of EDITOR_SHEET_MARKERS) expect(css, `${name} carries the editor rule ${marker}`).not.toContain(marker);
      expect(css, `${name} registers a gradient variable`).not.toMatch(/@property\s+--tw-gradient/);
    }
  });

  it('paints a Tailwind 3 style gradient', async () => {
    const { page } = await open(surfaces[1]);
    try {
      const image = await page.locator('[data-t="gradient"]').evaluate((el) => getComputedStyle(el).backgroundImage);
      expect(image).toBe('linear-gradient(to right, rgb(239, 68, 68), rgb(59, 130, 246))');
      // On screen: red at the left edge, blue at the right, not the page background.
      const png = PNG.sync.read(await page.locator('[data-t="gradient"]').screenshot());
      const at = (x: number) => [...png.data.subarray((Math.floor(png.height / 2) * png.width + x) * 4, (Math.floor(png.height / 2) * png.width + x) * 4 + 3)];
      const [r1, g1, b1] = at(1);
      const [r2, g2, b2] = at(png.width - 2);
      expect(r1).toBeGreaterThan(200);
      expect(g1 + b1).toBeLessThan(200);
      expect(b2).toBeGreaterThan(200);
      expect(r2 + g2).toBeLessThan(250);
    } finally {
      await page.close();
    }
  });

  it('keeps the editor sheet on the editor', async () => {
    const { page, sheets } = await open({ name: 'editor', url: editorUrl, ready: 'body' });
    try {
      const css = joined(sheets);
      for (const marker of EDITOR_SHEET_MARKERS) expect(css, `the editor carries ${marker}`).toContain(marker);
    } finally {
      await page.close();
    }
  });
});
