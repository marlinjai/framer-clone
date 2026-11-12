// Head items on a real build (slice H2 of docs/plans/2026-11-02-theme-and-head.md): the real
// `(site)/[...slug]` route and the real `not-found`, a real Postgres, raw HTML as the server
// sends it to eight user agents, and real Chromium, Firefox and WebKit counting what a page
// holding every allowed item asks of another host. Each site is new, so its first visit reads
// the database as a restart or a second replica would.
//
// Forward: every tag stands in <head>, JSON-LD parses back. Backtrack: an item removed and
// republished is gone, and two pages never share items. Resume: a save after a publish does not
// reach the visitor. Re-entry: a designed and a default 404 carry the right items, and a tag that
// lands in the body (what a Suspense boundary would do) fails here.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { chromium, firefox, webkit, type Browser, type BrowserType } from 'playwright';
import { DEFAULT_VIEWPORTS } from '@/lib/canvas/defaultViewports';
import { getPrismaClient } from '@/server/db';
import { getSiteRepository, type TenantScope } from '@/server/sites';
import { META_NAMES } from '@/lib/site/headItems';

const SCOPE: TenantScope = {
  workspaceId: `ws_head_${randomUUID().slice(0, 8)}`,
  tenantGroupId: '018f9c10-0000-7000-8000-0000000051c4',
};

const frames = Object.fromEntries(
  DEFAULT_VIEWPORTS.map((v) => [
    v.label.toLowerCase(),
    { id: v.label.toLowerCase(), type: 'div', componentType: 'host', canvasNodeType: 'viewport', breakpointId: v.label.toLowerCase(), breakpointMinWidth: v.minWidth, label: v.label, viewportWidth: v.width, viewportHeight: v.height, props: {}, children: [] },
  ]),
);

const UAS: Record<string, string> = {
  browser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36',
  'google-site-verification': 'Mozilla/5.0 (compatible; Google-Site-Verification/1.0)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  facebook: 'facebookexternalhit/1.1',
  linkedin: 'LinkedInBot/1.0',
  bing: 'Mozilla/5.0 (compatible; bingbot/2.0)',
  ahrefs: 'Mozilla/5.0 (compatible; AhrefsBot/7.0)',
  pinterest: 'Pinterest/0.2',
};

/** Another host: it counts every connection and request made to it. */
const other = { connections: 0, requests: [] as string[], port: 0 };
let otherServer: http.Server;

const FEED = 'application/rss+xml';
const JSONLD = { '@context': 'https://schema.org', '@type': 'Organization', name: 'Bakery </script><script>window.pwned=1</script>' };

/** Everything a site may hold: 17 meta names, 3 links. */
function siteItems(far: string) {
  return [
    ...[...META_NAMES].map((name) => ({ kind: 'meta', name, content: `site ${name}` })),
    { kind: 'link', rel: 'alternate', href: `${far}/de`, hreflang: 'de' },
    { kind: 'link', rel: 'me', href: `${far}/me` },
    { kind: 'link', rel: 'author', href: `${far}/author` },
  ];
}

/** Everything a page may hold: 8 properties, the other 4 rels, a feed, one JSON-LD. */
function pageItems(far: string) {
  return [
    ...['article:tag', 'product:price:amount', 'profile:first_name', 'book:isbn', 'fb:app_id', 'og:locale:alternate', 'og:video', 'og:audio'].map((property) => ({
      kind: 'property',
      property,
      content: `page ${property}`,
    })),
    { kind: 'link', rel: 'license', href: `${far}/license` },
    { kind: 'link', rel: 'help', href: `${far}/help` },
    { kind: 'link', rel: 'privacy-policy', href: '/privacy' },
    { kind: 'link', rel: 'terms-of-service', href: '/terms' },
    { kind: 'link', rel: 'alternate', href: '/feed.xml', type: FEED },
    { kind: 'jsonld', data: JSONLD },
  ];
}

const tree = (id: string, text: string) => ({
  id: `root-${id}`, type: 'div', componentType: 'host', props: {},
  children: [{ id: `t-${id}`, type: 'h1', componentType: 'host', props: { children: text }, children: [] }],
});

interface PageSpec { slug: string; head?: unknown[]; ogType?: string }

function project(siteId: string, pages: PageSpec[], siteSettings: Record<string, unknown>) {
  return {
    id: siteId,
    metadata: { title: 'Head', description: '', createdAt: 1, updatedAt: 2 },
    pages: Object.fromEntries(
      pages.map((p) => [
        p.slug || 'home',
        {
          id: p.slug || 'home',
          slug: p.slug,
          metadata: { title: p.slug || 'Home', ...(p.head ? { head: p.head } : {}), ...(p.ogType ? { ogType: p.ogType } : {}) },
          appComponentTree: tree(p.slug || 'home', `page ${p.slug || 'home'}`),
          canvasNodes: frames,
        },
      ]),
    ),
    components: {},
    siteSettings,
  } as never;
}

async function publish(pages: PageSpec[], siteSettings: Record<string, unknown>) {
  const repo = getSiteRepository();
  const siteId = randomUUID();
  const saved = await repo.saveProject(SCOPE, project(siteId, pages, siteSettings));
  const published = await repo.publishProject(SCOPE, project(siteId, pages, siteSettings), { expectedVersion: saved.version });
  return { repo, siteId, published, origin: await origin(siteId) };
}

async function origin(siteId: string): Promise<string> {
  const { subdomain } = await getSiteRepository().ensureSiteDomain(SCOPE, siteId);
  return `http://${subdomain}.sites.localhost:${process.env.BEHAVIOUR_PORT}`;
}

async function raw(url: string, ua = UAS.browser): Promise<{ status: number; html: string }> {
  const res = await fetch(url, { headers: { 'user-agent': ua } });
  return { status: res.status, html: await res.text() };
}

/** The part of the document before `</head>`, and the part after it. */
function split(html: string): { head: string; body: string } {
  const at = html.indexOf('</head>');
  expect(at).toBeGreaterThan(0);
  return { head: html.slice(0, at), body: html.slice(at) };
}

const tag = (kind: 'meta' | 'link', attrs: Record<string, string>) => {
  const re = new RegExp(`<${kind}\\b[^>]*>`, 'g');
  return (html: string) =>
    (html.match(re) ?? []).filter((t) => Object.entries(attrs).every(([k, v]) => t.includes(` ${k}="${v}"`)));
};

beforeAll(async () => {
  otherServer = http.createServer((req, res) => {
    other.requests.push(req.url ?? '');
    res.end('');
  });
  otherServer.on('connection', (socket: net.Socket) => {
    other.connections += 1;
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
  other.port = (otherServer.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => otherServer?.close(resolve));
  await getPrismaClient().$disconnect();
});

const far = () => `https://127.0.0.1:${other.port}`;

describe('raw HTML as the server sends it', () => {
  it.each(Object.entries(UAS))('every tag stands in <head> and JSON-LD parses back, for %s', async (_name, ua) => {
    const { origin: base } = await publish([{ slug: '', head: pageItems(far()) }], { siteName: 'Bakery', head: siteItems(far()) });
    const { status, html } = await raw(`${base}/`, ua);
    expect(status).toBe(200);
    const { head, body } = split(html);
    for (const name of META_NAMES) expect(tag('meta', { name, content: `site ${name}` })(head), name).toHaveLength(1);
    for (const property of ['article:tag', 'product:price:amount', 'profile:first_name', 'book:isbn', 'fb:app_id', 'og:locale:alternate', 'og:video', 'og:audio']) {
      expect(tag('meta', { property, content: `page ${property}` })(head), property).toHaveLength(1);
    }
    for (const rel of ['me', 'author', 'license', 'help', 'privacy-policy', 'terms-of-service']) {
      expect(tag('link', { rel })(head), rel).toHaveLength(1);
    }
    expect(tag('link', { rel: 'alternate', hrefLang: 'de' })(head)).toHaveLength(1);
    expect(tag('link', { rel: 'alternate', type: FEED })(head)).toHaveLength(1);
    // None of them is in the body, where a Suspense boundary would have flushed it.
    expect(body).not.toMatch(/<meta name="(author|rating)"|<link rel="(me|license)"/);
    // JSON-LD stays where it is rendered, and parses back to the stored object.
    const blocks = [...html.matchAll(/<script type="application\/ld\+json" data-head-jsonld="">([\s\S]*?)<\/script>/g)];
    expect(blocks).toHaveLength(1);
    expect(blocks[0][1]).not.toContain('</script');
    expect(JSON.parse(blocks[0][1])).toEqual(JSONLD);
    expect(html).not.toContain('window.pwned=1</script>');
  });

  it('Next keeps writing its own tags beside the items', async () => {
    const { origin: base } = await publish([{ slug: '', head: pageItems(far()) }], { siteName: 'Bakery', head: siteItems(far()) });
    const { head } = split((await raw(`${base}/`)).html);
    expect(head).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1"\/?>/);
    expect(head).toMatch(/<title>[^<]*<\/title>/);
    expect(head).toMatch(/<meta property="og:type" content="website"\/?>/);
  });

  it('a page item replaces the site item with the same key, and two pages do not share items', async () => {
    const { origin: base } = await publish(
      [
        { slug: '', head: [{ kind: 'meta', name: 'author', content: 'page one' }] },
        { slug: 'two', head: [{ kind: 'meta', name: 'rating', content: 'general' }] },
        { slug: 'three' },
      ],
      { siteName: 'Bakery', head: [{ kind: 'meta', name: 'author', content: 'site' }, { kind: 'meta', name: 'rating', content: 'site rating' }] },
    );
    const one = split((await raw(`${base}/`)).html).head;
    expect(tag('meta', { name: 'author' })(one)).toEqual(['<meta name="author" content="page one"/>']);
    expect(tag('meta', { name: 'rating', content: 'site rating' })(one)).toHaveLength(1);
    const two = split((await raw(`${base}/two`)).html).head;
    expect(tag('meta', { name: 'author', content: 'site' })(two)).toHaveLength(1);
    expect(tag('meta', { name: 'rating' })(two)).toEqual(['<meta name="rating" content="general"/>']);
    const three = split((await raw(`${base}/three`)).html).head;
    expect(three).not.toContain('page one');
    expect(three).not.toContain('content="general"');
  });

  // Next writes its own metadata (title, Open Graph) into <head> for the home page and, as of Next 15.5
  // streaming metadata, into the body for other paths until the client moves it. Items are not
  // Next's metadata and stand in <head> everywhere; the og:type of the home page is read there.
  it('writes the chosen og:type, and a forged one as website', async () => {
    const article = await publish([{ slug: '', ogType: 'article' }], { siteName: 'Bakery' });
    expect(split((await raw(`${article.origin}/`)).html).head).toContain('<meta property="og:type" content="article"/>');
    const forged = await publish([{ slug: '', ogType: 'product' }], { siteName: 'Bakery' });
    const served = await raw(`${forged.origin}/`);
    expect(served.status).toBe(200);
    expect(split(served.html).head).toContain('<meta property="og:type" content="website"/>');
  });

  it('leaves out a refused item and renders its neighbours', async () => {
    const { origin: base } = await publish(
      [{ slug: '', head: [
        { kind: 'meta', name: 'viewport', content: 'width=1' },
        { kind: 'meta', name: 'http-equiv', content: 'x' },
        { kind: 'http-equiv', content: 'refresh' },
        { kind: 'link', rel: 'stylesheet', href: `${far()}/x.css` },
        { kind: 'link', rel: 'STYLESHEET', href: `${far()}/x.css` },
        { kind: 'link', rel: 'me', href: 'javascript:alert(1)' },
        JSON.parse('{"kind":"link","rel":"me","href":"/a","__proto__":{"kind":"link"}}'),
        { kind: 'meta', name: 'rating', content: 'general' },
      ] }],
      { siteName: 'Bakery' },
    );
    const { status, html } = await raw(`${base}/`);
    expect(status).toBe(200);
    const { head } = split(html);
    expect(head).toContain('<meta name="rating" content="general"/>');
    expect(head.match(/<meta name="viewport"/g)).toHaveLength(1);
    // Nothing the refused items held reaches the page (Next's own stylesheet links are not theirs).
    expect(html).not.toMatch(/http-equiv|javascript:alert|x\.css/i);
    expect(tag('link', { rel: 'stylesheet', href: `${far()}/x.css` })(html)).toHaveLength(0);
    // The forged item either went in as nothing or as exactly its own two fields, never with a
    // field the prototype supplied.
    expect(tag('link', { rel: 'me' })(head).filter((t) => t !== '<link rel="me" href="/a"/>')).toHaveLength(0);
    expect(html).not.toContain('polluted');
  });
});

describe('the published copy', () => {
  it('serves its own frozen items after a later save', async () => {
    const { repo, siteId, published, origin: base } = await publish([{ slug: '', head: [{ kind: 'meta', name: 'author', content: 'v1' }] }], { siteName: 'Bakery' });
    await repo.saveProject(SCOPE, project(siteId, [{ slug: '', head: [{ kind: 'meta', name: 'author', content: 'draft' }] }], { siteName: 'Bakery', head: [{ kind: 'meta', name: 'rating', content: 'draft site' }] }), { mustExist: true, expectedVersion: published.version });
    const frozen = split((await raw(`${base}/`)).html).head;
    expect(frozen).toContain('<meta name="author" content="v1"/>');
    expect(frozen).not.toContain('draft');
  });

  // The server caches a published site per host and drops the cache on publish through a tag the
  // test process cannot reach, so both publishes happen before the first read.
  it('a republish without an item takes its tag off the next read', async () => {
    const { repo, siteId, published, origin: base } = await publish([{ slug: '', head: [{ kind: 'meta', name: 'author', content: 'v1' }] }], { siteName: 'Bakery', head: [{ kind: 'meta', name: 'rating', content: 'site v1' }] });
    const saved = await repo.saveProject(SCOPE, project(siteId, [{ slug: '', head: [] }], { siteName: 'Bakery', head: [] }), { mustExist: true, expectedVersion: published.version });
    await repo.publishProject(SCOPE, project(siteId, [{ slug: '', head: [] }], { siteName: 'Bakery', head: [] }), { expectedVersion: saved.version });
    const after = split((await raw(`${base}/`)).html).head;
    expect(after).not.toContain('name="author"');
    expect(after).not.toContain('name="rating"');
  });
});

// A miss answers with the status 404 and Next's error document: the not-found tree reaches the page
// through the stream, so its tags are in the raw HTML as the stream's data and in <head> once
// the page has run, not in the raw <head>. A 404 is noindex and no crawler reads a head off it,
// so this is the contract for the 404: the right items, in the document a browser ends up with.
describe('the 404', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function visit(url: string) {
    const page = await browser.newPage();
    try {
      const response = await page.goto(url, { waitUntil: 'networkidle' });
      const head = await page.evaluate(() => document.head.innerHTML);
      const jsonld = await page.evaluate(() => [...document.querySelectorAll('script[data-head-jsonld]')].map((e) => e.textContent));
      return { status: response?.status(), head, jsonld };
    } finally {
      await page.close();
    }
  }

  it('a designed 404 carries its own items and the site\'s', async () => {
    const { origin: base } = await publish(
      [{ slug: '' }, { slug: 'lost', head: [{ kind: 'meta', name: 'rating', content: 'lost page' }] }],
      { siteName: 'Bakery', notFoundPageId: 'lost', head: [{ kind: 'meta', name: 'author', content: 'site' }] },
    );
    const served = await raw(`${base}/nowhere`);
    expect(served.status).toBe(404);
    expect(served.html).toContain('\\"name\\":\\"rating\\",\\"content\\":\\"lost page\\"');
    const { status, head } = await visit(`${base}/nowhere`);
    expect(status).toBe(404);
    expect(head).toContain('<meta name="rating" content="lost page">');
    expect(head).toContain('<meta name="author" content="site">');
  });

  it('the default 404 carries the site\'s items, JSON-LD included, and none of a page\'s', async () => {
    const { origin: base } = await publish([{ slug: '', head: [{ kind: 'meta', name: 'rating', content: 'home only' }] }], {
      siteName: 'Bakery',
      head: [{ kind: 'meta', name: 'author', content: 'site' }, { kind: 'link', rel: 'me', href: '/me' }, { kind: 'jsonld', data: JSONLD }],
    });
    const { status, head, jsonld } = await visit(`${base}/nowhere`);
    expect(status).toBe(404);
    expect(head).toContain('<meta name="author" content="site">');
    expect(head).toContain('<link rel="me" href="/me">');
    expect(head).not.toContain('home only');
    expect(jsonld.map((t) => JSON.parse(t as string))).toEqual([JSONLD]);
  });
});

const ENGINES: [string, BrowserType][] = [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]];

describe.each(ENGINES)('a page holding every allowed item, in %s', (_name, engine) => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await engine.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it('makes no connection and no request to another host', async () => {
    const { origin: base } = await publish([{ slug: '', head: pageItems(far()) }], { siteName: 'Bakery', head: siteItems(far()) });
    const connectionsBefore = other.connections;
    const requestsBefore = other.requests.length;
    const page = await browser.newPage();
    try {
      const response = await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      expect(response?.status()).toBe(200);
      // The head items are in the DOM the browser built, so the silence is not an absent tag.
      expect(await page.locator(`head link[href^="${far()}"]`).count()).toBe(5);
      expect(await page.locator('head meta[name="author"]').count()).toBe(1);
      await page.waitForTimeout(1500);
    } finally {
      await page.close();
    }
    expect(other.requests.length - requestsBefore).toBe(0);
    expect(other.connections - connectionsBefore).toBe(0);
  });

  it('the detector sees a request to another host (canary)', async () => {
    const { origin: base } = await publish([{ slug: '' }], { siteName: 'Bakery' });
    const requestsBefore = other.requests.length;
    const page = await browser.newPage();
    try {
      await page.goto(`${base}/`);
      await page.evaluate((href) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        document.head.appendChild(link);
      }, `${far()}/canary.css`);
      await page.waitForTimeout(1500);
    } finally {
      await page.close();
    }
    expect(other.requests.length - requestsBefore + other.connections).toBeGreaterThan(0);
  });
});
