// A site's theme on the real route of a real build (slice T2 of
// docs/plans/2026-11-02-theme-and-head.md; T2 code review, finding 3). Raw HTML as the
// server sends it, so what is asserted is what Next itself writes: the theme sheet in the
// layout, the `html` class, and the viewport, where Next must keep its own
// `width=device-width, initial-scale=1` beside the layout's `color-scheme` and
// `theme-color`.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { getPrismaClient } from '@/server/db';
import { publishPages } from './site';

const ref = (id: string) => `var(--fc-t-${id})`;
const theme = (mode?: 'system' | 'light' | 'dark') => ({
  ...(mode ? { mode } : {}),
  tokens: [
    { id: 'gr000001', name: 'Ground', kind: 'color', light: '#ffffff', dark: '#030712' },
    { id: 'in000002', name: 'Ink', kind: 'color', light: '#111827', dark: '#f9fafb' },
  ],
  document: { backgroundColor: ref('gr000001'), color: ref('in000002') },
});

const origins: Record<string, string> = {};
let browser: Browser;

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const port = process.env.BEHAVIOUR_PORT as string;
  origins.none = await publishPages(port);
  origins.system = await publishPages(port, { siteSettings: { theme: theme('system') } });
  origins.dark = await publishPages(port, { siteSettings: { theme: theme('dark') } });
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await getPrismaClient().$disconnect();
});

/** The document as the server sent it, before any script ran. */
async function raw(origin: string): Promise<string> {
  const context = await browser.newContext();
  try {
    const response = await context.request.get(`${origin}/`);
    expect(response.status()).toBe(200);
    return await response.text();
  } finally {
    await context.close();
  }
}

const head = (html: string) => html.slice(0, html.indexOf('</head>'));
const VIEWPORT = /<meta name="viewport" content="width=device-width, initial-scale=1"\/?>/;

describe('the theme on a real build', () => {
  it('a site with no theme gets no sheet, no color-scheme, no theme-color, and Next\'s own viewport', async () => {
    const html = await raw(origins.none);
    expect(head(html)).toMatch(VIEWPORT);
    expect(html).not.toContain('data-fc-theme-sheet');
    expect(head(html)).not.toMatch(/name="color-scheme"|name="theme-color"/);
    expect(html).toMatch(/<html[^>]*class="light"/);
  });

  it('a system site keeps the default viewport beside color-scheme and a theme-color per scheme', async () => {
    const html = await raw(origins.system);
    const top = head(html);
    expect(top).toMatch(VIEWPORT);
    expect(top).toMatch(/<meta name="color-scheme" content="light dark"\/?>/);
    expect(top).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#ffffff"\/?>/);
    expect(top).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#030712"\/?>/);
    expect(html).toMatch(/<style data-fc-theme-sheet="">:root\{--fc-t-gr000001:#ffffff;--fc-t-in000002:#111827;color-scheme:light dark\}/);
    expect(html).toMatch(/<html[^>]*class="light"/);
  });

  it('a forced dark site writes the dark class, its dark values and one theme-color', async () => {
    const html = await raw(origins.dark);
    const top = head(html);
    expect(top).toMatch(VIEWPORT);
    expect(top).toMatch(/<meta name="color-scheme" content="dark"\/?>/);
    expect(top).toMatch(/<meta name="theme-color" content="#030712"\/?>/);
    expect(html).toMatch(/<html[^>]*class="dark"/);
    expect(html).toContain('--fc-t-in000002:#f9fafb');
  });
});
