// The two route layouts with a site's theme behind the request (slice T2 of
// docs/plans/2026-11-02-theme-and-head.md): the `(site)` layout writes the theme sheet
// and the viewport, the root layout writes `class="dark"` only for a forced dark site,
// and a site that cannot be resolved gets neither and still renders.

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SiteTheme } from '@/lib/site/theme';

const site = vi.hoisted(() => ({ current: null as null | { siteSettings: { theme: SiteTheme; language: string } } | Error }));

vi.mock('@/server/sites/requestSite', () => ({
  resolveSiteForRequest: async () => {
    if (site.current instanceof Error) throw site.current;
    return site.current;
  },
  getRequestLanguage: async () => 'en',
  getPrimaryHostForRequest: async () => null,
}));
vi.mock('next/font/google', () => ({ Geist: () => ({ variable: 'geist' }), Geist_Mono: () => ({ variable: 'geist-mono' }) }));
// The editor's sheet, which a build compiles; nothing here reads it.
vi.mock('../globals.css', () => ({}));

const theme = (mode?: SiteTheme['mode']): SiteTheme => ({
  ...(mode ? { mode } : {}),
  tokens: [{ id: 'gr000001', name: 'Ground', kind: 'color', light: '#ffffff', dark: '#030712' }],
  document: { backgroundColor: 'var(--fc-t-gr000001)' },
});
const withSite = (t: SiteTheme) => {
  site.current = { siteSettings: { theme: t, language: 'en' } };
};

afterEach(() => {
  site.current = null;
});

async function siteLayout(): Promise<string> {
  const { default: SiteLayout } = await import('@/app/(site)/layout');
  return renderToStaticMarkup(await SiteLayout({ children: <p>page</p> }));
}

async function rootClass(): Promise<string | undefined> {
  // The root layout leaves React to Next's automatic JSX runtime, which this transform does not apply.
  (globalThis as { React?: typeof React }).React = React;
  const { default: RootLayout } = await import('@/app/layout');
  return /<html[^>]*class="([^"]*)"/.exec(renderToStaticMarkup(await RootLayout({ children: null })))?.[1];
}

describe('the (site) layout', () => {
  it('writes the theme sheet after the base, before the page', async () => {
    withSite(theme('system'));
    const html = await siteLayout();
    expect(html).toMatch(/^<style data-fc-site-base="">[^<]*<\/style><style data-fc-theme-sheet="">:root\{--fc-t-gr000001:#ffffff;color-scheme:light dark\}@media \(prefers-color-scheme:dark\)\{:root\{--fc-t-gr000001:#030712\}\}body\{background-color:var\(--fc-t-gr000001\)\}<\/style><p>page<\/p>$/);
  });

  it('gives the viewport the chosen mode and the document background per scheme', async () => {
    const { generateViewport } = await import('@/app/(site)/layout');
    withSite(theme('system'));
    expect(await generateViewport()).toEqual({
      colorScheme: 'light dark',
      themeColor: [
        { media: '(prefers-color-scheme: light)', color: '#ffffff' },
        { media: '(prefers-color-scheme: dark)', color: '#030712' },
      ],
    });
    withSite(theme(undefined));
    expect(await generateViewport()).toEqual({});
  });

  it('writes no sheet and no viewport when the site cannot be resolved, and logs', async () => {
    const { generateViewport } = await import('@/app/(site)/layout');
    site.current = new Error('database down');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await siteLayout()).not.toContain('data-fc-theme-sheet');
    expect(await generateViewport()).toEqual({});
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('the root layout', () => {
  it('writes dark only for a forced dark site', async () => {
    withSite(theme('dark'));
    expect(await rootClass()).toBe('dark');
    for (const mode of ['system', 'light', undefined] as const) {
      withSite(theme(mode));
      expect(await rootClass()).toBe('light');
    }
    site.current = null;
    expect(await rootClass()).toBe('light');
  });

  it('stays light when the site cannot be resolved, and logs', async () => {
    site.current = new Error('database down');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await rootClass()).toBe('light');
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
