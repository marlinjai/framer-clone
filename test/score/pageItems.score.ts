// The page-level item rows that can be measured so far: a site's theme, in the format
// column and the published column (docs/plans/2026-11-02-theme-and-head.md, slice T2).
// Every check runs the real code: a theme goes through normalizeSiteSettings, JSON and
// the reader again, and a page through renderPublishedPage and the layout's sheets, then
// Chromium computes what a visitor sees. The canvas, panel and AI columns are slices T3
// to T5: nothing measures them here, so report.ts fails them under the theme gap.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import { normalizeSiteSettings } from '@/lib/site/siteSettings';
import type { SiteTheme, ThemeMode } from '@/lib/site/theme';
import { pageItemEntries } from './lib/universe';
import { BREAKPOINTS, publishedDocument } from './lib/published';
import { writeOut } from './lib/io';
import { rowKey, type Cell, type SurfaceResults } from './lib/types';

const ORIGIN = 'https://page-items.test';
const FONTS = path.resolve(process.cwd(), 'public/fonts');
const cmsRepo = { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository;

const ID = { ink: 'in000001', ground: 'gr000002', font: 'fo000003' };
const ref = (id: string) => `var(--fc-t-${id})`;
const INK = { light: 'rgb(17, 24, 39)', dark: 'rgb(249, 250, 251)' };
const GROUND = { light: 'rgb(255, 255, 255)', dark: 'rgb(3, 7, 18)' };
const DARK_RULE = 'rgb(1, 2, 3)';

function theme(mode: ThemeMode | undefined, document: SiteTheme['document'] = {}): SiteTheme {
  return {
    ...(mode ? { mode } : {}),
    tokens: [
      { id: ID.ink, name: 'Ink', kind: 'color', light: '#111827', dark: '#f9fafb' },
      { id: ID.ground, name: 'Ground', kind: 'color', light: '#ffffff', dark: '#030712' },
      { id: ID.font, name: 'Display', kind: 'font', family: 'fraunces' },
    ],
    document,
  };
}
const DOCUMENT = { backgroundColor: ref(ID.ground), color: ref(ID.ink), fontFamily: ref(ID.font) };

const TREE: ComponentNode = {
  id: 'root',
  type: 'div',
  props: {},
  children: [
    { id: 'plain', type: 'p', props: { id: 'plain', children: 'Inherits' } },
    { id: 'token', type: 'p', props: { id: 'token', children: 'Token', style: { color: ref(ID.ink) } } },
    { id: 'font', type: 'p', props: { id: 'font', children: 'Display face', style: { fontFamily: ref(ID.font) } } },
    {
      id: 'rule',
      type: 'p',
      props: { id: 'rule', children: 'Dark rule', style: { color: ref(ID.ink) }, rules: [{ id: 'd', selector: '&', at: ['@media (prefers-color-scheme: dark)'], style: { color: DARK_RULE } }] as never },
    },
  ],
};

async function documentFor(siteTheme: SiteTheme): Promise<string> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { body } = await renderPublishedPage({ root: TREE, pageParams: {}, cmsRepo, breakpoints: BREAKPOINTS, theme: siteTheme });
    return publishedDocument({ html: renderToStaticMarkup(React.createElement(React.Fragment, null, body)), css: '', theme: siteTheme });
  } finally {
    warn.mockRestore();
  }
}

interface Seen {
  htmlScheme: string;
  htmlClass: string;
  body: { background: string; color: string; font: string };
  plain: string;
  token: string;
  rule: string;
  font: string;
  fontLoaded: boolean;
}

const pass = (): Cell => ({ status: 'pass' });
const fail = (note: string): Cell => ({ status: 'fail', gap: 'theme', note });
const cell = (ok: boolean, note: string): Cell => (ok ? pass() : fail(note));

async function probe(check: () => Promise<Cell> | Cell): Promise<Cell> {
  try {
    return await check();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const key = (id: string) => rowKey('page-item', `theme:${id}`);

/** Format: a theme survives Site settings, JSON and the reader, as a save and a load do. */
function formatCells(): SurfaceResults {
  const trip = (t: SiteTheme) => normalizeSiteSettings(JSON.parse(JSON.stringify(normalizeSiteSettings({ theme: t })))).theme;
  const kept = (t: SiteTheme, read: (r: SiteTheme) => unknown, want: unknown) => JSON.stringify(read(trip(t))) === JSON.stringify(want);
  const token = (t: SiteTheme, id: string) => t.tokens.find((x) => x.id === id);
  return {
    [key('color-token')]: cell(kept(theme(undefined), (t) => token(t, ID.ink), theme(undefined).tokens[0]), 'a colour token did not survive'),
    [key('font-token')]: cell(kept(theme(undefined), (t) => token(t, ID.font), theme(undefined).tokens[2]), 'a font token did not survive'),
    [key('dark-value')]: cell(kept(theme(undefined), (t) => (token(t, ID.ink) as { dark?: string } | undefined)?.dark, '#f9fafb'), 'a dark value did not survive'),
    [key('mode-system')]: cell(kept(theme('system'), (t) => t.mode, 'system'), 'the system mode did not survive'),
    [key('mode-light')]: cell(kept(theme('light'), (t) => t.mode, 'light'), 'the light mode did not survive'),
    [key('mode-dark')]: cell(kept(theme('dark'), (t) => t.mode, 'dark'), 'the dark mode did not survive'),
    [key('document-background')]: cell(kept(theme(undefined, DOCUMENT), (t) => t.document.backgroundColor, DOCUMENT.backgroundColor), 'the document background did not survive'),
    [key('document-color')]: cell(kept(theme(undefined, DOCUMENT), (t) => t.document.color, DOCUMENT.color), 'the document colour did not survive'),
    [key('document-font')]: cell(kept(theme(undefined, DOCUMENT), (t) => t.document.fontFamily, DOCUMENT.fontFamily), 'the document font did not survive'),
  };
}

describe('page-level item rows', () => {
  let browser: Browser;
  beforeAll(async () => {
    // The self-hosted faces a font token loads, copied from the pinned packages.
    if (!existsSync(path.join(FONTS, 'fraunces'))) execFileSync('pnpm', ['fonts:sync'], { stdio: 'ignore' });
    browser = await chromium.launch();
  }, 120_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function see(siteTheme: SiteTheme, scheme: 'light' | 'dark'): Promise<Seen> {
    const html = await documentFor(siteTheme);
    const context = await browser.newContext({ colorScheme: scheme });
    try {
      const tab = await context.newPage();
      await tab.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.href === `${ORIGIN}/`) return route.fulfill({ status: 200, contentType: 'text/html', body: html });
        const file = path.join(FONTS, url.pathname.replace(/^\/fonts\//, ''));
        if (url.pathname.startsWith('/fonts/') && file.startsWith(FONTS) && existsSync(file)) {
          return route.fulfill({ status: 200, contentType: 'font/woff2', body: readFileSync(file) });
        }
        return route.fulfill({ status: 404, body: '' });
      });
      await tab.goto(`${ORIGIN}/`);
      await tab.evaluate(() => document.fonts.load('16px Fraunces'));
      return await tab.evaluate(() => {
        const style = (el: Element) => getComputedStyle(el);
        const byId = (id: string) => style(document.getElementById(id)!);
        return {
          htmlScheme: style(document.documentElement).colorScheme,
          htmlClass: document.documentElement.className,
          body: { background: style(document.body).backgroundColor, color: style(document.body).color, font: style(document.body).fontFamily },
          plain: byId('plain').color,
          token: byId('token').color,
          rule: byId('rule').color,
          font: byId('font').fontFamily,
          fontLoaded: [...document.fonts].some((face) => /fraunces/i.test(face.family) && face.status === 'loaded'),
        };
      });
    } finally {
      await context.close();
    }
  }

  /** Published: what Chromium computes on the page a visitor gets, under both system settings where it matters. */
  async function publishedCells(): Promise<SurfaceResults> {
    const out: SurfaceResults = {};
    out[key('color-token')] = await probe(async () => {
      const seen = await see(theme(undefined), 'light');
      return cell(seen.token === INK.light, `a reference computed ${seen.token}`);
    });
    out[key('font-token')] = await probe(async () => {
      const seen = await see(theme(undefined), 'light');
      return cell(seen.font.startsWith('Fraunces') && seen.fontLoaded, `the font token gave ${seen.font}, loaded ${seen.fontLoaded}`);
    });
    out[key('dark-value')] = await probe(async () => {
      const dark = await see(theme('system'), 'dark');
      const light = await see(theme('system'), 'light');
      return cell(dark.token === INK.dark && light.token === INK.light, `the token computed ${light.token} and ${dark.token}`);
    });
    out[key('mode-system')] = await probe(async () => {
      const dark = await see(theme('system'), 'dark');
      const light = await see(theme('system'), 'light');
      const ok = dark.htmlScheme === 'light dark' && dark.rule === DARK_RULE && light.rule === INK.light && dark.htmlClass === 'light';
      return cell(ok, `color-scheme ${dark.htmlScheme}, the dark rule gave ${light.rule} and ${dark.rule}`);
    });
    out[key('mode-light')] = await probe(async () => {
      // On a dark system: the light values, and a node's dark rule stays out.
      const seen = await see(theme('light'), 'dark');
      return cell(seen.htmlScheme === 'light' && seen.token === INK.light && seen.rule === INK.light, `color-scheme ${seen.htmlScheme}, token ${seen.token}, rule ${seen.rule}`);
    });
    out[key('mode-dark')] = await probe(async () => {
      // On a light system: the dark values, the dark class, and a node's dark rule on.
      const seen = await see(theme('dark'), 'light');
      const ok = seen.htmlScheme === 'dark' && seen.htmlClass === 'dark' && seen.token === INK.dark && seen.rule === DARK_RULE;
      return cell(ok, `color-scheme ${seen.htmlScheme}, class ${seen.htmlClass}, token ${seen.token}, rule ${seen.rule}`);
    });
    const withDocument = await see(theme('system', DOCUMENT), 'dark');
    out[key('document-background')] = cell(withDocument.body.background === GROUND.dark, `body background ${withDocument.body.background}`);
    out[key('document-color')] = cell(withDocument.body.color === INK.dark && withDocument.plain === INK.dark, `body colour ${withDocument.body.color}, text ${withDocument.plain}`);
    out[key('document-font')] = cell(withDocument.body.font.startsWith('Fraunces') && withDocument.fontLoaded, `body font ${withDocument.body.font}`);
    return out;
  }

  it('measures what is built, and names nothing that is not a row', async () => {
    const results = { format: formatCells(), renderer: await publishedCells() };
    const rows = new Set(pageItemEntries().map((e) => rowKey(e.kind, e.id)));
    for (const surface of Object.values(results)) {
      for (const name of Object.keys(surface)) expect(rows.has(name), name).toBe(true);
    }
    writeOut('page-items', results);
  });
});
