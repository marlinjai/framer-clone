// @vitest-environment node
//
// Every route under src/app is classified by host (src/lib/hostRoutes.ts), and
// the middleware answers each one as its class says: a published host reaches
// only its allowlist, with the listed methods; the editor host reaches all of
// them, as before. A new route without a table entry fails here, naming its
// file, so nothing reaches a customer's origin by default.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { HOST_ROUTES, publishedHostAllows, routeFor } from '@/lib/hostRoutes';
import { HOME_REWRITE_SENTINEL } from '@/server/sites/homeSentinel';

const APP_DIR = path.resolve(__dirname, '../../app');
const EDITOR = 'app.lumitra.co';
const PUBLISHED = 'acme.sites.lumitra.co';
const CUSTOM_DOMAIN = 'www.acme-shop.de';

/** The files that make a route: pages and route handlers, the harness build's included, in every extension Next reads. */
const ROUTE_FILE = /^(page|route)(\.harness)?\.(js|jsx|ts|tsx)$/;

/**
 * The metadata files, which Next also turns into routes: generated (js/jsx/ts/tsx)
 * or static. Icons and sharing images may be numbered (`icon1.png`).
 */
const METADATA_FILE =
  /^(?:(opengraph-image|twitter-image|icon|apple-icon)\d*\.(?:js|jsx|ts|tsx|ico|jpe?g|png|gif|svg)|(sitemap)\.(?:js|jsx|ts|tsx|xml)|(robots)\.(?:js|jsx|ts|tsx|txt)|(manifest)\.(?:js|jsx|ts|tsx|json|webmanifest)|(favicon)\.ico)$/;

/** The path a metadata file is served at, under its directory. */
function metadataRoute(name: string): string {
  const match = METADATA_FILE.exec(name)!;
  if (match[1]) return match[1];
  if (match[2]) return 'sitemap.xml';
  if (match[3]) return 'robots.txt';
  if (match[4]) return name.endsWith('.json') ? 'manifest.json' : 'manifest.webmanifest';
  return 'favicon.ico';
}

/**
 * Segments the route table cannot classify yet: an optional catch-all
 * (`[[...x]]`), a parallel route slot (`@x`) and an intercepting route
 * (`(.)x`, `(..)x`, `(..)(..)x`, `(...)x`). `parse` in src/lib/hostRoutes.ts
 * matches none of them as Next does, so one appearing fails the walk.
 */
const UNSUPPORTED_SEGMENT = /^(?:\[\[\.\.\..+\]\]|@.+|\((?:\.{1,3})\).*|\(\.\.\)\(\.\.\).*)$/;

interface RouteFile {
  route: string;
  file: string;
  kind: 'page' | 'route' | 'metadata';
}

const UNSUPPORTED: string[] = [];

function walk(dir: string, out: RouteFile[] = []): RouteFile[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // A private folder (`_x`, `__tests__` among them) is never a route.
    if (entry.isDirectory() && entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (UNSUPPORTED_SEGMENT.test(entry.name)) UNSUPPORTED.push(path.relative(process.cwd(), full));
      walk(full, out);
      continue;
    }
    const isRoute = ROUTE_FILE.test(entry.name);
    const isMetadata = !isRoute && METADATA_FILE.test(entry.name);
    if (!isRoute && !isMetadata) continue;
    const segments = path
      .relative(APP_DIR, dir)
      .split(path.sep)
      .filter((segment) => segment && !(segment.startsWith('(') && segment.endsWith(')') && !UNSUPPORTED_SEGMENT.test(segment)));
    if (isMetadata) segments.push(metadataRoute(entry.name));
    out.push({
      route: `/${segments.join('/')}`,
      file: path.relative(process.cwd(), full),
      kind: isMetadata ? 'metadata' : entry.name.startsWith('page') ? 'page' : 'route',
    });
  }
  return out;
}

const ROUTE_FILES = walk(APP_DIR);
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** The methods a route file answers: a page answers GET (and HEAD). */
function exportedMethods(routeFile: RouteFile): string[] {
  if (routeFile.kind !== 'route') return ['GET'];
  const source = readFileSync(routeFile.file, 'utf8');
  return [...source.matchAll(/export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
}

/** A concrete path for a route pattern. */
function samplePath(route: string): string {
  return route.replace(/\[\.\.\.[^\]]+\]/g, 'some/page').replace(/\[[^\]]+\]/g, 'x1');
}

function request(host: string, pathname: string, method: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://${host}${pathname}`, {
    method,
    headers: { host, cookie: 'lumitra_session=valid', ...headers },
  });
}

const isNext = (res: Response) => res.headers.get('x-middleware-next') === '1';
const rewriteTarget = (res: Response) => res.headers.get('x-middleware-rewrite');

afterEach(() => {
  delete process.env.EDITOR_HOST;
});

describe('host routes: every route under src/app is classified', () => {
  it('finds the routes (sanity: the walk sees pages, handlers and the site catch-all)', () => {
    const routes = ROUTE_FILES.map((r) => r.route);
    expect(routes).toContain('/[...slug]');
    expect(routes).toContain('/preview');
    expect(routes).toContain('/api/forms/submit');
    expect(ROUTE_FILES.length).toBeGreaterThan(100);
  });

  it('meets no optional catch-all, parallel slot or intercepting route (the table cannot classify them yet)', () => {
    expect(UNSUPPORTED, 'extend parse in src/lib/hostRoutes.ts (and this walk) before adding one').toEqual([]);
  });

  it('reads every route and metadata file name Next turns into a route', () => {
    for (const name of ['page.js', 'page.jsx', 'route.js', 'route.jsx', 'page.harness.tsx', 'route.ts']) {
      expect(ROUTE_FILE.test(name), name).toBe(true);
    }
    expect(
      [
        'opengraph-image.tsx',
        'opengraph-image.png',
        'twitter-image.jpg',
        'icon.svg',
        'icon1.png',
        'apple-icon.png',
        'sitemap.ts',
        'sitemap.xml',
        'robots.js',
        'robots.txt',
        'manifest.ts',
        'manifest.json',
        'manifest.webmanifest',
        'favicon.ico',
      ].map(metadataRoute),
    ).toEqual([
      'opengraph-image',
      'opengraph-image',
      'twitter-image',
      'icon',
      'icon',
      'apple-icon',
      'sitemap.xml',
      'sitemap.xml',
      'robots.txt',
      'robots.txt',
      'manifest.webmanifest',
      'manifest.json',
      'manifest.webmanifest',
      'favicon.ico',
    ]);
    for (const name of ['layout.tsx', 'loader.ts', 'icons.ts', 'page.module.css']) {
      expect(ROUTE_FILE.test(name) || METADATA_FILE.test(name), name).toBe(false);
    }
    for (const segment of ['[[...slug]]', '@modal', '(.)photo', '(..)photo', '(..)(..)photo', '(...)photo']) {
      expect(UNSUPPORTED_SEGMENT.test(segment), segment).toBe(true);
    }
    for (const segment of ['(site)', '[...slug]', '[id]', 'favicon.ico']) {
      expect(UNSUPPORTED_SEGMENT.test(segment), segment).toBe(false);
    }
  });

  it.each(ROUTE_FILES.map((r) => [r.file, r] as const))('%s has an entry', (_file, routeFile) => {
    const entry = HOST_ROUTES.find((e) => e.route === routeFile.route);
    expect(entry, `${routeFile.file} (${routeFile.route}) is not classified in src/lib/hostRoutes.ts`).toBeDefined();
  });

  it('has no entry for a route that does not exist, and none twice', () => {
    const onDisk = new Set(ROUTE_FILES.map((r) => r.route));
    expect(HOST_ROUTES.filter((e) => !onDisk.has(e.route)).map((e) => e.route)).toEqual([]);
    const seen = HOST_ROUTES.map((e) => e.route);
    expect(seen.filter((route, i) => seen.indexOf(route) !== i)).toEqual([]);
  });

  it.each(ROUTE_FILES.map((r) => [r.file, r] as const))(
    '%s: a published host may only use methods the route answers',
    (_file, routeFile) => {
      const entry = HOST_ROUTES.find((e) => e.route === routeFile.route);
      const answered = exportedMethods(routeFile);
      for (const method of entry?.published ?? []) expect(answered, routeFile.file).toContain(method);
    },
  );
});

describe('host routes: the middleware answers each route by its class', () => {
  const cases = HOST_ROUTES.filter((e) => e.route !== '/').flatMap((entry) =>
    METHODS.map((method) => [entry.route, method, entry] as const),
  );

  it.each(cases)('%s %s', async (route, method, entry) => {
    process.env.EDITOR_HOST = EDITOR;
    const pathname = samplePath(route);
    const verb = method === 'HEAD' ? 'GET' : method;
    const mayPublish = (entry.published as readonly string[] | undefined)?.includes(verb) ?? false;
    expect(publishedHostAllows(pathname, method)).toBe(mayPublish);

    for (const host of [PUBLISHED, CUSTOM_DOMAIN]) {
      const res = await middleware(request(host, pathname, method));
      if (mayPublish) {
        expect(isNext(res), `${host} ${method} ${pathname}`).toBe(true);
      } else {
        expect(res.status, `${host} ${method} ${pathname}`).toBe(404);
        expect(isNext(res)).toBe(false);
        expect(res.headers.get('location')).toBeNull();
      }
    }

    // The editor host is unchanged: signed in and same origin, everything passes.
    // The machine door is the one route a session never opens: it takes a
    // company API key (a bearer) and nothing else, so it is sent one here.
    const credential: Record<string, string> = route === '/api/mcp' ? { authorization: 'Bearer not-a-real-key' } : {};
    const editor = await middleware(request(EDITOR, pathname, method, { 'sec-fetch-site': 'same-origin', ...credential }));
    expect(isNext(editor), `${EDITOR} ${method} ${pathname}`).toBe(true);
  });

  it('serves a published home as the storefront home, never the editor page, and only for reads', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const method of ['GET', 'HEAD']) {
      const res = await middleware(request(PUBLISHED, '/', method));
      expect(new URL(rewriteTarget(res)!).pathname).toBe(`/${HOME_REWRITE_SENTINEL}`);
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await middleware(request(PUBLISHED, '/', method));
      expect(res.status, method).toBe(404);
      expect(rewriteTarget(res)).toBeNull();
    }
    const editor = await middleware(request(EDITOR, '/', 'GET'));
    expect(isNext(editor)).toBe(true);
    expect(rewriteTarget(editor)).toBeNull();
  });

  it('refuses a server action on a published host, on any page path and on the home', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const pathname of ['/', '/about', '/products/classic-tee']) {
      for (const method of ['POST', 'GET']) {
        const res = await middleware(request(PUBLISHED, pathname, method, { 'next-action': 'a1b2c3' }));
        expect(res.status, `${method} ${pathname}`).toBe(404);
      }
    }
    // The editor keeps its server actions (same origin).
    const editor = await middleware(
      request(EDITOR, '/projects', 'POST', { 'next-action': 'a1b2c3', 'sec-fetch-site': 'same-origin' }),
    );
    expect(isNext(editor)).toBe(true);
  });

  it('refuses an API path no allowlisted route names, rather than letting it fall to the site pages', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const pathname of ['/api', '/api/unknown', '/api/commerce', '/api/projects/x1/y/z', '/api/cms/rows']) {
      const res = await middleware(request(PUBLISHED, pathname, 'GET'));
      expect(res.status, pathname).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
    }
  });
});

describe('host routes: routeFor resolves a path as Next does', () => {
  it.each([
    ['/about', '/[...slug]'],
    ['/products/classic-tee', '/[...slug]'],
    ['/preview', '/preview'],
    ['/preview/x', '/[...slug]'],
    ['/preview-sale', '/[...slug]'],
    ['/projects', '/projects'],
    ['/projects/books', '/projects/books'],
    ['/projects/p1', '/projects/[projectId]'],
    ['/projects/p1/preview', '/projects/[projectId]/preview'],
    ['/projects/p1/other', '/[...slug]'],
    ['/api/books/documents/d1/lines/reorder', '/api/books/documents/[id]/lines/reorder'],
    ['/api/books/documents/d1/lines/l1', '/api/books/documents/[id]/lines/[lineId]'],
    ['/api/catalog/products/bulk', '/api/catalog/products/bulk'],
    ['/api/commerce/orders/o1/pay', '/api/commerce/orders/[orderId]/pay'],
    ['/%70review', '/preview'],
  ])('%s -> %s', (pathname, route) => {
    expect(routeFor(pathname)?.route).toBe(route);
  });

  it('a page path that Next serves from the site catch-all stays open on a published host', () => {
    expect(publishedHostAllows('/preview/x', 'GET')).toBe(true);
    expect(publishedHostAllows('/preview', 'GET')).toBe(false);
    expect(publishedHostAllows('/about', 'POST')).toBe(false);
    expect(publishedHostAllows('/%zz', 'GET')).toBe(false);
  });
});
