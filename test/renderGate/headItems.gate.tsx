// Head items in real browsers, through the real emission (slice H2 of
// docs/plans/2026-11-02-theme-and-head.md): every refused kind fed in as STORED data,
// `resolveHead` then `HeadItemTags`, the markup served as a document, Chromium and WebKit.
// What must hold: a refused item renders nothing (no navigation from an http-equiv, no request
// from a stylesheet in any spelling), hostile JSON-LD runs nothing and parses back to what was
// stored, and a page holding every allowed item asks no other host for anything. A detector
// canary runs with them: the same harness must see a request that really happens.

import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chromium, webkit, type Browser, type BrowserType } from 'playwright';
import { HeadItemTags } from '@/components/site/HeadItemTags';
import { META_NAMES, resolveHead } from '@/lib/site/headItems';

const SELF = 'https://gate.test/';
const FAR = 'https://other.test';

/** The page the real route would send for these stored items. */
function documentFor(site: unknown, page: unknown, extraHead = ''): string {
  const { items } = resolveHead(site, page);
  const markup = renderToString(
    <html>
      {/* eslint-disable-next-line @next/next/no-head-element -- a whole document is served here, not a Next page */}
      <head>
        <meta charSet="utf-8" />
      </head>
      <body>
        <HeadItemTags items={items} />
        <p id="ok">page</p>
      </body>
    </html>,
  );
  return `<!doctype html>${extraHead ? markup.replace('<head>', `<head>${extraHead}`) : markup}`;
}

interface Visit {
  others: string[];
  url: string;
  hostile: unknown;
  jsonld: unknown[];
  head: string;
}

async function visit(browser: Browser, html: string): Promise<Visit> {
  const context = await browser.newContext();
  const tab = await context.newPage();
  const others: string[] = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url === SELF) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    others.push(url);
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  try {
    await tab.goto(SELF, { waitUntil: 'networkidle' });
    // Long enough for a `refresh` under a second to have fired.
    await tab.waitForTimeout(1800);
    return {
      others,
      url: tab.url(),
      hostile: await tab.evaluate(() => (window as unknown as { pwned?: unknown }).pwned),
      jsonld: await tab.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((e) => JSON.parse(e.textContent ?? ''))),
      head: await tab.evaluate(() => document.head.innerHTML),
    };
  } finally {
    await context.close();
  }
}

const HOSTILE_STRINGS = [
  '</script><script>window.pwned=1</script>',
  '<!--<script>window.pwned=1</script>',
  '</SCRIPT\t><script>window.pwned=1</script>',
  'line separator here',
  '"></script><img src=https://other.test/pixel onerror=window.pwned=1>',
];

const everyAllowed = {
  site: [
    ...[...META_NAMES].map((name) => ({ kind: 'meta', name, content: `v ${name}` })),
    { kind: 'link', rel: 'alternate', href: `${FAR}/de`, hreflang: 'de' },
    { kind: 'link', rel: 'me', href: `${FAR}/me` },
    { kind: 'link', rel: 'author', href: `${FAR}/author` },
  ],
  page: [
    ...['article:tag', 'product:price:amount', 'profile:first_name', 'book:isbn', 'fb:app_id', 'og:locale:alternate', 'og:video', 'og:audio'].map((property) => ({
      kind: 'property',
      property,
      content: `${FAR}/${property}`,
    })),
    { kind: 'link', rel: 'license', href: `${FAR}/license` },
    { kind: 'link', rel: 'help', href: `${FAR}/help` },
    { kind: 'link', rel: 'privacy-policy', href: '/privacy' },
    { kind: 'link', rel: 'terms-of-service', href: '/terms' },
    { kind: 'link', rel: 'alternate', href: `${FAR}/feed`, type: 'application/rss+xml' },
    { kind: 'jsonld', data: { '@context': 'https://schema.org', '@type': 'Organization', name: HOSTILE_STRINGS[0], sameAs: [`${FAR}/profile`] } },
  ],
};

const refused = [
  { kind: 'meta', 'http-equiv': 'refresh', content: `0;url=${FAR}/refresh` },
  { kind: 'http-equiv', 'http-equiv': 'refresh', content: `0;url=${FAR}/refresh` },
  { kind: 'meta', name: 'http-equiv', content: `0;url=${FAR}/refresh` },
  { kind: 'meta', name: 'referrer', content: 'unsafe-url' },
  { kind: 'meta', name: 'viewport', content: 'width=1' },
  { kind: 'meta', name: 'color-scheme', content: 'dark' },
  ...['stylesheet', 'STYLESHEET', 'alternate stylesheet', ' stylesheet\t', 'preload', 'prefetch', 'modulepreload', 'preconnect', 'dns-prefetch', 'next', 'icon', 'manifest', 'compression-dictionary'].map((rel) => ({
    kind: 'link',
    rel,
    href: `${FAR}/${encodeURIComponent(rel)}`,
    as: 'script',
  })),
  ...['stylesheet', 'STYLESHEET', 'alternate stylesheet', ' stylesheet\t'].map((rel) => ({ kind: 'link', rel, href: `${FAR}/${encodeURIComponent(rel)}` })),
  { kind: 'link', rel: 'me', href: 'javascript:window.pwned=1' },
  { kind: 'link', rel: 'me', href: 'data:text/html,<script>window.pwned=1</script>' },
  { kind: 'link', rel: 'me', href: `//other.test/protocol-relative` },
  { kind: 'link', rel: 'me', href: `/\\other.test/backslash` },
  { kind: 'script', src: `${FAR}/x.js` },
  { kind: 'style', content: `@import "${FAR}/x.css"` },
];

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['webkit', webkit]];

describe.each(ENGINES)('head items in %s', (_name, type) => {
  it('the detector sees a request that really happens (canary)', async () => {
    const browser = await type.launch();
    try {
      const seen = await visit(browser, documentFor([], [], `<link rel="stylesheet" href="${FAR}/canary.css">`));
      expect(seen.others).toContain(`${FAR}/canary.css`);
    } finally {
      await browser.close();
    }
  });

  it('a page holding every allowed item asks no other host for anything, and keeps its items', async () => {
    const browser = await type.launch();
    try {
      const seen = await visit(browser, documentFor(everyAllowed.site, everyAllowed.page));
      expect(seen.others).toEqual([]);
      expect(seen.url).toBe(SELF);
      expect(seen.head).toContain('<meta name="author" content="v author">');
      expect(seen.head.match(/<link /g)?.length).toBe(8);
      expect(seen.hostile).toBeUndefined();
      expect(seen.jsonld).toEqual([(everyAllowed.page.at(-1) as { data: unknown }).data]);
    } finally {
      await browser.close();
    }
  });

  it('every refused kind, stored, renders nothing: no navigation, no request, no script', async () => {
    const browser = await type.launch();
    try {
      const seen = await visit(browser, documentFor([], refused));
      expect(seen.others).toEqual([]);
      expect(seen.url).toBe(SELF);
      expect(seen.hostile).toBeUndefined();
      expect(seen.head).not.toMatch(/http-equiv|refresh|stylesheet|preload|prefetch|preconnect|javascript:|pwned|x\.js|x\.css/i);
      expect(seen.head).not.toContain('name="viewport"');
    } finally {
      await browser.close();
    }
  });

  it('hostile JSON-LD runs nothing and parses back to what was stored', async () => {
    const browser = await type.launch();
    try {
      const data = HOSTILE_STRINGS.map((hostile, i) => ({ '@context': 'https://schema.org', '@type': 'Thing', name: hostile, [hostile]: `key ${i}` }));
      const seen = await visit(browser, documentFor([], data.map((d) => ({ kind: 'jsonld', data: d })).slice(0, 3)));
      expect(seen.hostile).toBeUndefined();
      expect(seen.others).toEqual([]);
      expect(seen.jsonld).toEqual(data.slice(0, 3));
      const rest = await visit(browser, documentFor([], data.slice(3).map((d) => ({ kind: 'jsonld', data: d }))));
      expect(rest.hostile).toBeUndefined();
      expect(rest.others).toEqual([]);
      expect(rest.jsonld).toEqual(data.slice(3));
    } finally {
      await browser.close();
    }
  });
});
