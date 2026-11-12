// @vitest-environment node
//
// The edge auth gate + host-aware root routing, RECONCILED to the real routes
// on disk (MT-16). Asserts that:
//   - a published-site (non-editor) host `/` is REWRITTEN to the home sentinel
//     and is NOT bounced to login (anonymous site visitors must be served);
//   - the editor host `/` (and localhost / unset EDITOR_HOST) returns next()
//     with no rewrite and no bounce (today's editor behavior, unchanged);
//   - an unauthenticated `/projects` (and `/projects/<id>`, `/api/projects/*`,
//     `/api/ai/*`) on the EDITOR host bounces to the auth-brain login -- the
//     un-gated `/` exemption does NOT leak to the dashboard;
//   - an authenticated `/projects` passes through;
//   - D2 (resolved): a PUBLISHED-host request is NEVER gated on the apex
//     session (never bounced to login): storefront paths flow through to
//     host-based resolution, and the session-authorized editor surfaces
//     (`/projects/*`, `/api/projects/*`, `/api/ai/*`) are refused with a 404
//     whether or not the `.lumitra.co` cookie is present;
//   - the matcher gates only the real authoring surfaces and the dead
//     `/editor`, `/api/sites`, `/api/admin` patterns are gone;
//   - a published page carries the report-only policy and nothing else does:
//     a page path on the editor host is matched but never gated or marked.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../middleware';
import { HOME_REWRITE_SENTINEL } from '@/server/sites/homeSentinel';
import {
  ALLOWED_FRAME_ORIGIN,
  CSP_REPORT_ONLY_HEADER,
  MAPS_CONSENT_COOKIE,
  PUBLISHED_REPORT_ONLY_POLICY,
  PUBLISHED_REPORT_ONLY_POLICY_MAPS,
} from '@/lib/site/cspReportOnly';
import { CONSENT_MAPS_COOKIE } from '@/lib/consent/consent';
import { GOOGLE_MAPS_ORIGIN } from '@/lib/mapEmbed/mapEmbed';

const EDITOR = 'app.lumitra.co';
const PUBLISHED = 'acme.sites.lumitra.co';

function req(url: string, opts: { host?: string; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.host) headers.host = opts.host;
  if (opts.cookie) headers.cookie = opts.cookie;
  return new NextRequest(url, { headers });
}

const rewriteTarget = (res: Response) => res.headers.get('x-middleware-rewrite');
const isNext = (res: Response) => res.headers.get('x-middleware-next') === '1';

afterEach(() => {
  delete process.env.EDITOR_HOST;
});

describe('middleware: host-aware root routing', () => {
  it('rewrites a non-editor-host `/` to the home sentinel and does NOT bounce it', async () => {
    process.env.EDITOR_HOST = EDITOR;
    // Anonymous published-site visitor: NO session cookie.
    const res = await middleware(req('https://demo.base.lumitra.co/', { host: 'demo.base.lumitra.co' }));
    const target = rewriteTarget(res);
    expect(target).not.toBeNull();
    expect(new URL(target!).pathname).toBe(`/${HOME_REWRITE_SENTINEL}`);
    // It is a rewrite, never a redirect to the auth-brain login.
    expect(res.status).not.toBe(307);
  });

  it('serves the editor at `/` on the editor host (no rewrite, no bounce)', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(req(`https://${EDITOR}/`, { host: EDITOR }));
    expect(rewriteTarget(res)).toBeNull();
    expect(isNext(res)).toBe(true);
  });

  it('treats the editor host case-insensitively and ignores the port', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(req(`https://${EDITOR}/`, { host: 'APP.Lumitra.co:443' }));
    expect(rewriteTarget(res)).toBeNull();
    expect(isNext(res)).toBe(true);
  });

  it('localhost `/` stays the editor', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(req('http://localhost:3000/', { host: 'localhost:3000' }));
    expect(rewriteTarget(res)).toBeNull();
    expect(isNext(res)).toBe(true);
  });

  it('with EDITOR_HOST unset, every host `/` stays the editor (dev safety)', async () => {
    const res = await middleware(req('https://demo.base.lumitra.co/', { host: 'demo.base.lumitra.co' }));
    expect(rewriteTarget(res)).toBeNull();
    expect(isNext(res)).toBe(true);
  });
});

describe('middleware: editor-host auth gate (MT-16 reconciled surfaces)', () => {
  it('bounces an unauthenticated `/projects` to the auth-brain login', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(req(`https://${EDITOR}/projects`, { host: EDITOR }));
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin).toBe('https://auth.lumitra.co');
    expect(url.pathname).toBe('/login');
    // The `/` exemption must NOT leak to the dashboard: return_to is /projects.
    expect(url.searchParams.get('return_to')).toBe(`https://${EDITOR}/projects`);
  });

  it('bounces an unauthenticated `/projects/<id>` with a scoped return_to', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(req(`https://${EDITOR}/projects/proj_123`, { host: EDITOR }));
    expect(res.status).toBe(307);
    const url = new URL(res.headers.get('location')!);
    expect(url.searchParams.get('return_to')).toBe(`https://${EDITOR}/projects/proj_123`);
  });

  it('returns a JSON 401 (NOT a redirect) for unauthenticated authoring APIs (`/api/projects/*`, `/api/ai/*`)', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/api/projects/save', '/api/ai/edit']) {
      const res = await middleware(req(`https://${EDITOR}${path}`, { host: EDITOR }));
      // A fetch client (PublishButton/autosave, cms-agent) must get a JSON 401,
      // never a 302/307 redirect to an HTML login page.
      expect(res.status).toBe(401);
      expect(res.headers.get('location')).toBeNull();
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unauthorized');
    }
  });

  it('lets an authenticated `/projects` through', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(
      req(`https://${EDITOR}/projects`, { host: EDITOR, cookie: 'lumitra_session=abc' }),
    );
    expect(isNext(res)).toBe(true);
  });
});

describe('middleware: D2 published-host requests are never gated on the apex session', () => {
  it('a published-host storefront path without a session passes through, NOT bounced', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(req(`https://${PUBLISHED}/about`, { host: PUBLISHED }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
    expect(isNext(res)).toBe(true);
  });

  it('the editor dashboard (/projects/*) is REFUSED with a 404 on a published host, with or without the apex cookie, never bounced', async () => {
    process.env.EDITOR_HOST = EDITOR;
    // D2 is an authz decision: the `.lumitra.co` cookie is still SENT to the
    // published host by the browser, so a session-authorized editor page must
    // not run there at all. Same answer either way, and never a login bounce.
    for (const path of ['/projects', '/projects/p1', '/projects/p1/preview']) {
      for (const cookie of [undefined, 'lumitra_session=valid']) {
        const res = await middleware(req(`https://${PUBLISHED}${path}`, { host: PUBLISHED, cookie }));
        expect(res.status, `${path} cookie=${cookie}`).toBe(404);
        expect(res.headers.get('location')).toBeNull();
        expect(isNext(res)).toBe(false);
      }
    }
  });

  it('the editor dashboard still works on the editor host and on localhost (signed in)', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const host of [EDITOR, 'localhost:3000']) {
      const res = await middleware(
        req(`https://${host}/projects/p1`, { host, cookie: 'lumitra_session=valid' }),
      );
      expect(isNext(res)).toBe(true);
    }
  });
});

describe('middleware: the authoring and AI APIs are refused on a published host (D2)', () => {
  it.each([
    '/api/projects/p1/commerce/products',
    '/api/projects/p1/commerce/inventory?variantId=a&locationId=b',
    '/api/projects/save',
    '/api/projects',
    '/api/ai/cms-agent',
    '/api/ai/cms-agent/undo',
    '/api/ai/edit',
    '/api/books/documents',
    '/api/books/documents/d1/pdf',
  ])('404s %s on a published host EVEN WITH a session cookie', async (path) => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(
      req(`https://${PUBLISHED}${path}`, { host: PUBLISHED, cookie: 'lumitra_session=valid' }),
    );
    expect(res.status).toBe(404);
    expect(isNext(res)).toBe(false);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it.each(['/api/projects/p1/commerce/products', '/api/ai/edit', '/api/books/documents'])(
    'still lets %s through on the editor host (signed in)',
    async (path) => {
      process.env.EDITOR_HOST = EDITOR;
      const res = await middleware(
        req(`https://${EDITOR}${path}`, { host: EDITOR, cookie: 'lumitra_session=valid' }),
      );
      expect(isNext(res)).toBe(true);
    },
  );

  it('keeps localhost (dev) on the editor plane', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(
      req('http://localhost:3000/api/projects/p1/commerce/products', {
        host: 'localhost:3000',
        cookie: 'lumitra_session=valid',
      }),
    );
    expect(isNext(res)).toBe(true);
  });
});

/** The matcher's published-page entry: the only one that is not a plain path. */
const PUBLISHED_PAGES = config.matcher[config.matcher.length - 1];

describe('middleware: matcher reconciled to real routes (MT-16)', () => {
  it('gates `/`, `/projects/*`, and the authoring `/api/*` families', () => {
    expect(config.matcher.slice(0, -1)).toEqual([
      '/',
      '/projects/:path*',
      '/api/:path*',
    ]);
  });

  it('drops the dead `/editor`, `/api/sites`, `/api/admin` patterns', () => {
    expect(config.matcher).not.toContain('/editor/:path*');
    expect(config.matcher).not.toContain('/api/sites/:path*');
    expect(config.matcher).not.toContain('/api/admin/:path*');
  });

  it('leaves public page families out of the matcher', () => {
    for (const open of ['/preview/:path*', '/[...slug]']) {
      expect(config.matcher).not.toContain(open);
    }
  });

  it('runs on an open API route but does not gate it on a session', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/api/health', '/api/cms/collections', '/api/commerce/products']) {
      expect(isNext(await middleware(req(`https://${EDITOR}${path}`, { host: EDITOR })))).toBe(true);
    }
  });
});

describe('middleware: a write from another origin never reaches the editor host', () => {
  const write = (path: string, headers: Record<string, string>, host = EDITOR) =>
    new NextRequest(`https://${host}${path}`, { method: 'POST', headers: { host, cookie: 'lumitra_session=x', ...headers } });

  it.each(['same-site', 'cross-site'])('refuses Sec-Fetch-Site %s on every API family', async (site) => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/api/projects/save', '/api/projects/publish', '/api/books/invoices', '/api/ai/edit', '/api/cms/rows', '/api/commerce/orders']) {
      const res = await middleware(write(path, { 'sec-fetch-site': site, 'content-type': 'text/plain' }));
      expect(res.status).toBe(403);
    }
  });

  it('refuses a stored form on a published site, by Origin, in a browser without Sec-Fetch-Site', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(write('/api/projects/save', { origin: `https://${PUBLISHED}` }));
    expect(res.status).toBe(403);
  });

  it('refuses a null or malformed Origin', async () => {
    process.env.EDITOR_HOST = EDITOR;
    expect((await middleware(write('/api/projects/save', { origin: 'null' }))).status).toBe(403);
  });

  it('refuses a server action posted from another origin', async () => {
    process.env.EDITOR_HOST = EDITOR;
    expect((await middleware(write('/projects', { 'sec-fetch-site': 'same-site' }))).status).toBe(403);
  });

  it('lets the editor write to itself', async () => {
    process.env.EDITOR_HOST = EDITOR;
    expect(isNext(await middleware(write('/api/projects/save', { 'sec-fetch-site': 'same-origin' })))).toBe(true);
    expect(isNext(await middleware(write('/api/projects/save', { origin: `https://${EDITOR}` })))).toBe(true);
  });

  it('lets a webhook or host timer through: neither header means no browser page', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const stripe = new NextRequest(`https://${EDITOR}/api/payments/stripe/webhook`, { method: 'POST', headers: { host: EDITOR } });
    expect(isNext(await middleware(stripe))).toBe(true);
    const timer = new NextRequest(`https://${EDITOR}/api/internal/commerce/jobs/run`, { method: 'POST', headers: { host: EDITOR } });
    expect(isNext(await middleware(timer))).toBe(true);
  });

  it('does not touch a read, or a checkout on a published site', async () => {
    process.env.EDITOR_HOST = EDITOR;
    expect(isNext(await middleware(req(`https://${EDITOR}/api/cms/x`, { host: EDITOR })))).toBe(true);
    const checkout = new NextRequest(`https://${PUBLISHED}/api/commerce/orders`, {
      method: 'POST',
      headers: { host: PUBLISHED, 'sec-fetch-site': 'same-origin' },
    });
    expect(isNext(await middleware(checkout))).toBe(true);
  });
});

describe('middleware: the report-only policy of published pages', () => {
  const policy = (res: Response) => res.headers.get(CSP_REPORT_ONLY_HEADER);

  it('marks a published page and the published home, and never enforces', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const page = await middleware(req(`https://${PUBLISHED}/about`, { host: PUBLISHED }));
    const home = await middleware(req(`https://${PUBLISHED}/`, { host: PUBLISHED }));
    expect(policy(page)).toBe(PUBLISHED_REPORT_ONLY_POLICY);
    expect(policy(home)).toBe(PUBLISHED_REPORT_ONLY_POLICY);
    expect(rewriteTarget(home)).not.toBeNull();
    expect(page.headers.get('content-security-policy')).toBeNull();
    expect(home.headers.get('content-security-policy')).toBeNull();
  });

  it('measures images, fonts, media and frames, allows the site and Unsplash, and reports to the site itself', () => {
    expect(PUBLISHED_REPORT_ONLY_POLICY).toBe(
      "img-src 'self' data: blob: https://images.unsplash.com; font-src 'self' data:; media-src 'self' data: blob:; frame-src 'self'; report-uri /api/csp-report",
    );
    expect(PUBLISHED_REPORT_ONLY_POLICY_MAPS).toBe(
      "img-src 'self' data: blob: https://images.unsplash.com; font-src 'self' data:; media-src 'self' data: blob:; frame-src 'self' https://www.google.com; report-uri /api/csp-report",
    );
  });

  it('allows Google Maps frames only for a visitor whose maps consent the cookie records', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/', '/about']) {
      const without = await middleware(req(`https://${PUBLISHED}${path}`, { host: PUBLISHED }));
      const declined = await middleware(req(`https://${PUBLISHED}${path}`, { host: PUBLISHED, cookie: `${MAPS_CONSENT_COOKIE}=0` }));
      const consented = await middleware(req(`https://${PUBLISHED}${path}`, { host: PUBLISHED, cookie: `${MAPS_CONSENT_COOKIE}=1` }));
      expect(policy(without)).toBe(PUBLISHED_REPORT_ONLY_POLICY);
      expect(policy(declined)).toBe(PUBLISHED_REPORT_ONLY_POLICY);
      expect(policy(consented)).toBe(PUBLISHED_REPORT_ONLY_POLICY_MAPS);
    }
    // The consent runtime writes the same cookie name the middleware reads.
    expect(CONSENT_MAPS_COOKIE).toBe(MAPS_CONSENT_COOKIE);
    expect(ALLOWED_FRAME_ORIGIN).toBe(GOOGLE_MAPS_ORIGIN);
  });

  it('never marks the editor host, on any path, signed in or not', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/', '/about', '/projects', '/api/projects/x']) {
      for (const cookie of [undefined, 'lumitra_session=abc']) {
        const res = await middleware(req(`https://${EDITOR}${path}`, { host: EDITOR, cookie }));
        expect(policy(res)).toBeNull();
      }
    }
  });

  it('never marks localhost, or any host with EDITOR_HOST unset', async () => {
    process.env.EDITOR_HOST = EDITOR;
    expect(policy(await middleware(req('http://localhost:3000/about', { host: 'localhost:3000' })))).toBeNull();
    delete process.env.EDITOR_HOST;
    expect(policy(await middleware(req(`https://${PUBLISHED}/about`, { host: PUBLISHED })))).toBeNull();
  });

  it('does not mark the 404 that refuses the editor plane on a published host', async () => {
    process.env.EDITOR_HOST = EDITOR;
    expect(policy(await middleware(req(`https://${PUBLISHED}/projects`, { host: PUBLISHED })))).toBeNull();
    expect(policy(await middleware(req(`https://${PUBLISHED}/api/ai/edit`, { host: PUBLISHED })))).toBeNull();
  });

  it('does not mark an API answer on a published host, though the matcher brings API routes here', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const [method, path] of [
      ['GET', '/api/cms/collections/c1/rows'],
      ['GET', '/api/commerce/products'],
      ['POST', '/api/forms/submit'],
      ['GET', '/api/health'],
      ['POST', '/api/csp-report'],
    ]) {
      const res = await middleware(new NextRequest(`https://${PUBLISHED}${path}`, { method, headers: { host: PUBLISHED } }));
      expect(isNext(res), path).toBe(true);
      expect(policy(res), path).toBeNull();
    }
  });

  // The headers a report can arrive with. The gate must not depend on which of
  // them a browser sends, so a report passes with each.
  const REPORT_HEADERS: Record<string, string>[] = [
    { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'no-cors', origin: `https://${PUBLISHED}` },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'https://elsewhere.example' },
    { origin: 'null' },
    {},
  ];

  it.each(REPORT_HEADERS)('lets a report through on a published host, the cross-origin refusal does not run there: %j', async (headers) => {
    process.env.EDITOR_HOST = EDITOR;
    const report = new NextRequest(`https://${PUBLISHED}/api/csp-report`, {
      method: 'POST',
      headers: { host: PUBLISHED, 'content-type': 'application/csp-report', ...headers },
      body: '{}',
    });
    const res = await middleware(report);
    expect(res.status).toBe(200);
    expect(isNext(res)).toBe(true);
  });

  it('still refuses a cross-origin write first on the editor host, before any routing', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const write = new NextRequest(`https://${EDITOR}/about`, {
      method: 'POST',
      headers: { host: EDITOR, 'sec-fetch-site': 'cross-site' },
    });
    expect((await middleware(write)).status).toBe(403);
  });

  it('a page path on the editor host passes through ungated, though it is now matched', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(req(`https://${EDITOR}/about`, { host: EDITOR }));
    expect(isNext(res)).toBe(true);
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
  });

  // The entry is a regular expression source, as Next compiles it.
  const matchesPublishedPages = (path: string) => new RegExp(`^${PUBLISHED_PAGES}$`).test(path);

  it('matches page paths, also ones that only begin like an excluded path', () => {
    for (const path of [
      '/about',
      '/products/classic-tee',
      '/preview-sale',
      '/apitude',
      '/images-of-us',
      '/robots.txt/x',
      '/images',
      '/fonts',
      '/preview',
      '/preview/x',
    ]) {
      expect(matchesPublishedPages(path), path).toBe(true);
    }
  });

  it('matches other public files, which carry the header where it does nothing', () => {
    expect(matchesPublishedPages('/file.svg')).toBe(true);
  });

  it('refuses /preview on a published host with an unmarked 404, and serves it unmarked on the editor host', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const published = await middleware(req(`https://${PUBLISHED}/preview`, { host: PUBLISHED }));
    expect(published.status).toBe(404);
    expect(isNext(published)).toBe(false);
    expect(policy(published)).toBeNull();
    const editor = await middleware(req(`https://${EDITOR}/preview`, { host: EDITOR }));
    expect(policy(editor)).toBeNull();
    expect(isNext(editor)).toBe(true);
    expect(editor.headers.get('location')).toBeNull();
  });

  it('leaves API routes (matched by their own entry), build output, one site image and the per-host files out of this entry', () => {
    for (const path of [
      '/api/cms/x',
      '/api/commerce/orders',
      '/api/health',
      '/api/csp-report',
      '/api/forms/submit',
      '/_next/static/chunk.js',
      '/_next/image',
      `/site-images/${'a'.repeat(64)}.png`,
      '/favicon.ico',
      '/robots.txt',
      '/sitemap.xml',
      '/site.webmanifest',
    ]) {
      expect(matchesPublishedPages(path), path).toBe(false);
    }
  });

  it('matches /images/*, /fonts/* and deeper /site-images paths: a missing file there is a site catch-all page path', () => {
    for (const path of ['/fonts/inter/5/a.woff2', '/images/a.png', '/images/x', '/fonts/x', '/site-images/a/b', '/_nextx']) {
      expect(matchesPublishedPages(path), path).toBe(true);
    }
  });

  it('refuses a server action and a post on those paths on a published host, and lets a read through with the policy', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/images/x', '/fonts/x', '/site-images/a/b']) {
      for (const method of ['GET', 'POST']) {
        const action = await middleware(
          new NextRequest(`https://${PUBLISHED}${path}`, { method, headers: { host: PUBLISHED, 'next-action': 'a1b2c3' } }),
        );
        expect(action.status, `${method} ${path} with next-action`).toBe(404);
      }
      const post = await middleware(new NextRequest(`https://${PUBLISHED}${path}`, { method: 'POST', headers: { host: PUBLISHED } }));
      expect(post.status, `POST ${path}`).toBe(404);
      const read = await middleware(req(`https://${PUBLISHED}${path}`, { host: PUBLISHED }));
      expect(isNext(read), `GET ${path}`).toBe(true);
      expect(policy(read), `GET ${path}`).not.toBeNull();
    }
  });
});

describe('middleware: the machine door (a company API key reaches /api/mcp and /api/machine only)', () => {
  // A placeholder token: the middleware never verifies it (the route does,
  // src/lib/auth-machine.ts), it only decides which credential a path accepts.
  const BEARER = 'Bearer not-a-real-key';
  const call = (path: string, headers: Record<string, string> = {}, init: { method?: string; host?: string } = {}) => {
    const host = init.host ?? EDITOR;
    return new NextRequest(`https://${host}${path}`, { method: init.method ?? 'POST', headers: { host, ...headers } });
  };
  /** The request headers the middleware forwards (NextResponse.next({ request: { headers } })). */
  const forwarded = (res: Response) => (res.headers.get('x-middleware-override-headers') ?? '').split(',').filter(Boolean);

  it('lets a bearer request through to /api/mcp and its sub-paths (matcher covers it)', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/api/mcp', '/api/mcp/stream']) {
      expect(isNext(await middleware(call(path, { authorization: BEARER })))).toBe(true);
    }
    expect(config.matcher).toContain('/api/:path*');
  });

  it('refuses /api/mcp without a bearer with a 401 and a Bearer challenge, even with a session cookie', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const variants: Record<string, string>[] = [{}, { cookie: 'lumitra_session=valid' }, { authorization: 'Basic dXNlcjpwdw==' }];
    for (const headers of variants) {
      const res = await middleware(call('/api/mcp', { ...headers, 'sec-fetch-site': 'same-origin' }));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
  });

  it('refuses a bearer on every other authoring API with the 401 of a request without a session', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/api/projects/save', '/api/projects/publish', '/api/ai/edit', '/api/books/invoices']) {
      for (const method of ['GET', 'POST']) {
        const res = await middleware(call(path, { authorization: BEARER }, { method }));
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('unauthorized');
      }
    }
  });

  it('treats a request carrying both a cookie and a bearer as bearer only', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const both = { authorization: BEARER, cookie: 'lumitra_session=valid', 'sec-fetch-site': 'same-origin' };
    // The authoring API refuses it as if no cookie were there.
    expect((await middleware(call('/api/projects/save', both))).status).toBe(401);
    // A page bounces to the login, as without a session.
    const page = await middleware(call('/projects', both, { method: 'GET' }));
    expect(page.status).toBe(307);
    expect(page.headers.get('location')).toContain('/login');
    // The machine door gets it without its cookies, so nothing downstream can read the session.
    const mcp = await middleware(call('/api/mcp', both));
    expect(isNext(mcp)).toBe(true);
    expect(forwarded(mcp)).toContain('authorization');
    expect(forwarded(mcp)).not.toContain('cookie');
  });

  it('strips the cookies of a bearer request to any other API route, and leaves cookie requests alone', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const bearerCms = await middleware(
      call('/api/cms/rows', { authorization: BEARER, cookie: 'lumitra_session=valid' }, { method: 'GET' }),
    );
    expect(isNext(bearerCms)).toBe(true);
    expect(forwarded(bearerCms)).not.toContain('cookie');
    const cookieCms = await middleware(call('/api/cms/rows', { cookie: 'lumitra_session=valid' }, { method: 'GET' }));
    expect(isNext(cookieCms)).toBe(true);
    expect(cookieCms.headers.get('x-middleware-override-headers')).toBeNull();
  });

  it('lets a cross-origin bearer request reach /api/mcp, but still refuses a cross-origin cookie write to it', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const bearerCross = await middleware(
      call('/api/mcp', { authorization: BEARER, 'sec-fetch-site': 'cross-site', origin: 'https://claude.ai' }),
    );
    expect(isNext(bearerCross)).toBe(true);
    const cookieCross = await middleware(call('/api/mcp', { cookie: 'lumitra_session=valid', 'sec-fetch-site': 'cross-site' }));
    expect(cookieCross.status).toBe(403);
    expect((await cookieCross.json()).error.code).toBe('cross_origin_refused');
  });

  it('still refuses a cross-origin write with a bearer to any other route', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/api/projects/save', '/api/cms/rows']) {
      const res = await middleware(call(path, { authorization: BEARER, 'sec-fetch-site': 'cross-site' }));
      expect(res.status).toBe(403);
    }
  });

  it('answers 404 for /api/mcp on a published host, with or without a bearer', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const variants: Record<string, string>[] = [{ authorization: BEARER }, {}];
    for (const headers of variants) {
      const res = await middleware(call('/api/mcp', headers, { host: PUBLISHED }));
      expect(res.status).toBe(404);
    }
  });

  it('treats /api/machine/* (the Books read for the receipts mirror) as the machine door too', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const path = '/api/machine/books/documents';
    // A bearer passes, without the cookie that came along.
    const ok = await middleware(call(path, { authorization: BEARER, cookie: 'lumitra_session=valid' }, { method: 'GET' }));
    expect(isNext(ok)).toBe(true);
    expect(forwarded(ok)).not.toContain('cookie');
    // A session is no credential there.
    for (const headers of [{}, { cookie: 'lumitra_session=valid' }] as Record<string, string>[]) {
      const res = await middleware(call(path, { ...headers, 'sec-fetch-site': 'same-origin' }, { method: 'GET' }));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
    // Case and encoding variants fall under the same rule.
    for (const variant of ['/API/Machine/books/documents', '/api/%6Dachine/books/documents', '//api/machine/books/documents']) {
      const res = await middleware(call(variant, { 'sec-fetch-site': 'same-origin' }, { method: 'GET' }));
      expect(res.status).toBe(401);
    }
    // A published host never serves it.
    for (const headers of [{ authorization: BEARER }, {}] as Record<string, string>[]) {
      expect((await middleware(call(path, headers, { host: PUBLISHED, method: 'GET' }))).status).toBe(404);
    }
    // A prefix that only looks alike is no machine path: it keeps the session gate.
    expect((await middleware(call('/api/machinery', { authorization: BEARER }, { method: 'GET' }))).status).not.toBe(401);
  });

  it("keeps today's cookie gate unchanged for requests without a bearer", async () => {
    process.env.EDITOR_HOST = EDITOR;
    expect(
      isNext(await middleware(call('/api/projects/save', { cookie: 'lumitra_session=x', 'sec-fetch-site': 'same-origin' }))),
    ).toBe(true);
    expect((await middleware(call('/api/projects/save', { 'sec-fetch-site': 'same-origin' }))).status).toBe(401);
  });
});

describe('middleware: machine door hardening', () => {
  const BEARER = 'Bearer not-a-real-key';
  const call = (path: string, headers: Record<string, string> = {}, init: { method?: string; host?: string } = {}) => {
    const host = init.host ?? EDITOR;
    return new NextRequest(`https://${host}${path}`, { method: init.method ?? 'POST', headers: { host, ...headers } });
  };
  const forwarded = (res: Response) => (res.headers.get('x-middleware-override-headers') ?? '').split(',').filter(Boolean);

  it('treats case and percent-encoded variants of /api/mcp exactly like /api/mcp', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/api/MCP', '/api/%6Dcp', '/api/%6dcp/stream', '/API/Mcp']) {
      const withKey = await middleware(call(path, { authorization: BEARER, 'sec-fetch-site': 'cross-site' }));
      expect(isNext(withKey)).toBe(true);
      expect(forwarded(withKey)).not.toContain('cookie');
      const cookieOnly = await middleware(call(path, { cookie: 'lumitra_session=valid', 'sec-fetch-site': 'same-origin' }));
      expect(cookieOnly.status).toBe(401);
    }
  });

  it('applies the cookie gate to percent-encoded authoring paths too', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(call('/api/%70rojects/save', { authorization: BEARER, 'sec-fetch-site': 'same-origin' }));
    expect(res.status).toBe(401);
  });

  it('keeps a malformed percent-encoding on the raw path (no crash)', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(call('/api/%E0%A4%A', { authorization: BEARER }, { method: 'GET' }));
    expect(isNext(res)).toBe(true);
  });

  it('strips the cookies of a bearer request on the editor root and on published hosts too', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const both = { authorization: BEARER, cookie: 'lumitra_session=valid' };
    const root = await middleware(call('/', both, { method: 'GET' }));
    expect(isNext(root)).toBe(true);
    expect(forwarded(root)).not.toContain('cookie');

    const publishedRoot = await middleware(call('/', both, { method: 'GET', host: PUBLISHED }));
    expect(rewriteTarget(publishedRoot)).not.toBeNull();
    expect(forwarded(publishedRoot)).toContain('authorization');
    expect(forwarded(publishedRoot)).not.toContain('cookie');

    for (const path of ['/about', '/api/commerce/products']) {
      const res = await middleware(call(path, both, { method: 'GET', host: PUBLISHED }));
      expect(isNext(res)).toBe(true);
      expect(forwarded(res)).toContain('authorization');
      expect(forwarded(res)).not.toContain('cookie');
    }
  });

  it('on a published host, a bearer opens nothing the allowlist does not name, and spellings of the editor plane 404 as JSON', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const both = { authorization: BEARER, cookie: 'lumitra_session=valid' };
    for (const path of ['/api/mcp', '/api/MCP', '/API/Mcp', '//api/mcp', '/api/%6Dcp/stream', '/API/PROJECTS', '/api/%70rojects/save']) {
      const variants: Record<string, string>[] = [both, { cookie: 'lumitra_session=valid' }, {}];
      for (const headers of variants) {
        const res = await middleware(call(path, headers, { host: PUBLISHED }));
        expect(res.status, path).toBe(404);
        expect((await res.json()).error.code, path).toBe('not_found');
      }
    }
    for (const path of ['/Projects', '/PROJECTS/p1', '/%70rojects/p1/preview']) {
      const res = await middleware(call(path, both, { method: 'GET', host: PUBLISHED }));
      expect(res.status, path).toBe(404);
      expect(isNext(res)).toBe(false);
    }
    // A bearer on an editor-only route that is not in the editor-plane list is
    // refused by the allowlist all the same.
    for (const path of ['/api/catalog/products', '/api/payments/stripe/account', '/preview']) {
      const res = await middleware(call(path, both, { method: 'GET', host: PUBLISHED }));
      expect(res.status, path).toBe(404);
    }
    // What the allowlist does serve still goes on without the cookies.
    const form = await middleware(call('/api/forms/submit', both, { host: PUBLISHED }));
    expect(isNext(form)).toBe(true);
    expect(forwarded(form)).not.toContain('cookie');
  });

  it('forwards a cookie request on the editor host untouched', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(call('/about', { cookie: 'lumitra_session=valid' }, { method: 'GET' }));
    expect(isNext(res)).toBe(true);
    expect(res.headers.get('x-middleware-override-headers')).toBeNull();
  });
});

describe('framing: no editor page may be framed', () => {
  const EDITOR_HOST = 'app.lumitra.co';
  afterEach(() => {
    delete process.env.EDITOR_HOST;
  });

  it("sends frame-ancestors 'none' and X-Frame-Options DENY on the agent approval page and on every editor page", async () => {
    process.env.EDITOR_HOST = EDITOR_HOST;
    for (const path of ['/projects/site-1/confirm/abc', '/projects', '/projects/site-1', '/']) {
      const res = await middleware(req(`https://${EDITOR_HOST}${path}`, { host: EDITOR_HOST, cookie: 'lumitra_session=s1' }));
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
    // A signed-out visit bounced to the login carries it too.
    const bounced = await middleware(req(`https://${EDITOR_HOST}/projects/site-1/confirm/abc`, { host: EDITOR_HOST }));
    expect(bounced.headers.get('x-frame-options')).toBe('DENY');
  });

  it('leaves API responses and published hosts alone', async () => {
    process.env.EDITOR_HOST = EDITOR_HOST;
    const api = await middleware(req(`https://${EDITOR_HOST}/api/projects/list`, { host: EDITOR_HOST, cookie: 'lumitra_session=s1' }));
    expect(api.headers.get('x-frame-options')).toBeNull();
    const published = await middleware(req('https://bakery.sites.lumitra.co/menu', { host: 'bakery.sites.lumitra.co' }));
    expect(published.headers.get('x-frame-options')).toBeNull();
    expect(published.headers.get('content-security-policy')).toBeNull();
  });
});

describe('middleware: a forwarded server action (Host: localhost) fails closed in production', () => {
  // Next forwards a server action its own bundle lacks to the worker holding
  // it; Node 22's fetch drops the caller's Host, so that hop arrives as
  // `Host: localhost:<port>`. In production that is a published host, and the
  // action must get a 404, never run (src/lib/editorHost.ts).
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a next-action request with Host: localhost:<port> in production, on editor and page paths', async () => {
    process.env.EDITOR_HOST = EDITOR;
    vi.stubEnv('NODE_ENV', 'production');
    for (const host of ['localhost:3000', '127.0.0.1:3000']) {
      for (const path of ['/projects/p1', '/projects', '/about', '/']) {
        const res = await middleware(
          new NextRequest(`http://${host}${path}`, {
            method: 'POST',
            headers: { host, 'next-action': 'a1b2c3', cookie: 'lumitra_session=valid', 'sec-fetch-site': 'same-origin' },
          }),
        );
        expect(res.status, `${host} ${path}`).toBe(404);
        expect(isNext(res)).toBe(false);
      }
    }
  });

  it('still runs it on localhost outside production (development)', async () => {
    process.env.EDITOR_HOST = EDITOR;
    vi.stubEnv('NODE_ENV', 'development');
    const res = await middleware(
      new NextRequest('http://localhost:3000/projects/p1', {
        method: 'POST',
        headers: { host: 'localhost:3000', 'next-action': 'a1b2c3', cookie: 'lumitra_session=valid', 'sec-fetch-site': 'same-origin' },
      }),
    );
    expect(isNext(res)).toBe(true);
  });
});

describe('middleware: the cross-origin check compares the Origin with the Host header', () => {
  const post = (headers: Record<string, string>) =>
    new NextRequest(`https://${EDITOR}/api/projects/save`, {
      method: 'POST',
      headers: { host: EDITOR, cookie: 'lumitra_session=valid', ...headers },
    });

  it('refuses another origin even when X-Forwarded-Host claims to be that origin', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(post({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('cross_origin_refused');
  });

  it('lets the editor write to itself whatever X-Forwarded-Host says', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(post({ origin: `https://${EDITOR}`, 'x-forwarded-host': 'evil.example' }));
    expect(isNext(res)).toBe(true);
  });
});

describe('middleware: OPTIONS, RSC requests and trailing slashes on a published host', () => {
  const call = (path: string, method = 'GET', headers: Record<string, string> = {}) =>
    new NextRequest(`https://${PUBLISHED}${path}`, { method, headers: { host: PUBLISHED, ...headers } });

  it('answers OPTIONS with a 404 on a published host (no allowlisted route lists it) and passes it on the editor host', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const path of ['/', '/about', '/api/forms/submit', '/api/commerce/products', '/api/commerce/orders']) {
      expect((await middleware(call(path, 'OPTIONS'))).status, path).toBe(404);
    }
    const editor = await middleware(
      new NextRequest(`https://${EDITOR}/api/commerce/products`, { method: 'OPTIONS', headers: { host: EDITOR } }),
    );
    expect(isNext(editor)).toBe(true);
  });

  it('serves an RSC request (?_rsc= or RSC: 1) to an allowed page as a read, with the cookie filter, and refuses it on an editor page', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const cookie = 'lumitra_session=valid';
    for (const [path, headers] of [
      ['/about?_rsc=abc12', {}],
      ['/about', { rsc: '1' }],
      ['/products/classic-tee?_rsc=x', { rsc: '1', 'next-router-state-tree': '%5B%5D' }],
    ] as [string, Record<string, string>][]) {
      const res = await middleware(call(path, 'GET', { cookie, ...headers }));
      expect(isNext(res), path).toBe(true);
      expect((res.headers.get('x-middleware-override-headers') ?? '').split(','), path).not.toContain('cookie');
    }
    const home = await middleware(call('/?_rsc=abc12', 'GET', { rsc: '1' }));
    expect(rewriteTarget(home)).not.toBeNull();
    for (const [path, headers] of [
      ['/preview?_rsc=abc12', {}],
      ['/projects', { rsc: '1' }],
      ['/about?_rsc=abc12', { 'next-action': 'a1b2c3' }],
    ] as [string, Record<string, string>][]) {
      expect((await middleware(call(path, 'GET', headers))).status, path).toBe(404);
    }
  });

  it('treats a trailing slash on an API entry like the entry itself', async () => {
    process.env.EDITOR_HOST = EDITOR;
    expect(isNext(await middleware(call('/api/forms/submit/', 'POST')))).toBe(true);
    expect(isNext(await middleware(call('/api/commerce/products/', 'GET')))).toBe(true);
    expect(isNext(await middleware(call('/api/commerce/orders/o1/pay/', 'POST')))).toBe(true);
    for (const [path, method] of [
      ['/api/forms/submit/', 'GET'],
      ['/api/cms/collections/', 'POST'],
      ['/api/mcp/', 'POST'],
      ['/api/projects/', 'GET'],
      ['/api/catalog/products/', 'GET'],
      ['/api/payments/stripe/webhook/', 'POST'],
    ]) {
      const res = await middleware(call(path, method));
      expect(res.status, `${method} ${path}`).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
    }
  });
});

describe('middleware: a published host forwards only the cookies the published plane reads', () => {
  const call = (path: string, cookie: string | null, init: { method?: string } = {}) =>
    new NextRequest(`https://${PUBLISHED}${path}`, {
      method: init.method ?? 'GET',
      headers: cookie === null ? { host: PUBLISHED } : { host: PUBLISHED, cookie },
    });
  const overridden = (res: Response) => (res.headers.get('x-middleware-override-headers') ?? '').split(',').filter(Boolean);
  const forwardedCookie = (res: Response) => res.headers.get('x-middleware-request-cookie');
  const APEX = 'lumitra_session=valid; framer_company=t1; framer_ws=w1; lumitra_variants_pub=a';

  it('drops the apex session, the company selectors and every other cookie, on pages, the home and the allowlisted APIs', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const cases: [string, string][] = [
      ['/about', 'GET'],
      ['/', 'GET'],
      ['/api/forms/submit', 'POST'],
      ['/api/commerce/orders', 'POST'],
      ['/api/commerce/orders/o1/pay', 'POST'],
      ['/api/cms/collections', 'GET'],
      ['/api/commerce/products', 'GET'],
    ];
    for (const [path, method] of cases) {
      const res = await middleware(call(path, APEX, { method }));
      expect(isNext(res) || rewriteTarget(res) !== null, path).toBe(true);
      // The forwarded header set (x-middleware-override-headers) no longer has a cookie.
      expect(overridden(res), path).toContain('host');
      expect(overridden(res), path).not.toContain('cookie');
      expect(forwardedCookie(res), path).toBeNull();
    }
  });

  it(`keeps ${MAPS_CONSENT_COOKIE} and nothing else, and still reads it for the policy`, async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(call('/about', `lumitra_session=valid; ${MAPS_CONSENT_COOKIE}=1; framer_company=t1`));
    expect(forwardedCookie(res)).toBe(`${MAPS_CONSENT_COOKIE}=1`);
    expect(res.headers.get(CSP_REPORT_ONLY_HEADER)).toBe(PUBLISHED_REPORT_ONLY_POLICY_MAPS);
  });

  it('touches nothing when only kept cookies, or none, arrive', async () => {
    process.env.EDITOR_HOST = EDITOR;
    for (const cookie of [`${MAPS_CONSENT_COOKIE}=1`, null]) {
      const res = await middleware(call('/about', cookie));
      expect(isNext(res)).toBe(true);
      expect(res.headers.get('x-middleware-override-headers')).toBeNull();
    }
  });

  it('drops every cookie, the kept one too, from a bearer request', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(
      new NextRequest(`https://${PUBLISHED}/about`, {
        headers: { host: PUBLISHED, authorization: 'Bearer not-a-real-key', cookie: `${MAPS_CONSENT_COOKIE}=1; lumitra_session=v` },
      }),
    );
    expect(overridden(res)).toContain('authorization');
    expect(overridden(res)).not.toContain('cookie');
    expect(forwardedCookie(res)).toBeNull();
  });
});

describe('middleware: a preview host (the public preview link of a site branch, S8)', () => {
  const PREVIEW = `preview-${'a2'.repeat(16)}.sites.lumitra.co`;
  const use = () => {
    process.env.EDITOR_HOST = EDITOR;
    process.env.PUBLIC_SITE_BASE_HOST = 'sites.lumitra.co';
  };
  afterEach(() => {
    delete process.env.PUBLIC_SITE_BASE_HOST;
  });
  const marked = (res: Response) => {
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  };

  it('serves its home as the site home and its pages as reads, without any cookie or key travelling on', async () => {
    use();
    const home = await middleware(new NextRequest(`https://${PREVIEW}/`, { headers: { host: PREVIEW, cookie: 'lumitra_session=x; lumitra-consent-maps=1', authorization: 'Bearer k' } }));
    expect(rewriteTarget(home)).toBe(`https://${PREVIEW}/${HOME_REWRITE_SENTINEL}`);
    marked(home);
    const page = await middleware(new NextRequest(`https://${PREVIEW}/about`, { headers: { host: PREVIEW, cookie: 'lumitra_session=x' } }));
    expect(isNext(page)).toBe(true);
    marked(page);
    for (const res of [home, page]) {
      // Next lists the request headers it passes on; the session and the key are not among them.
      const passed = (res.headers.get('x-middleware-override-headers') ?? '').split(',');
      expect(passed).not.toContain('cookie');
      expect(passed).not.toContain('authorization');
      expect(res.headers.get('x-middleware-request-cookie')).toBeNull();
      expect(res.headers.get('x-middleware-request-authorization')).toBeNull();
    }
  });

  it('refuses every write, every server action, the editor and every other API, each answer marked the same', async () => {
    use();
    const attempts: Array<[string, { method: string; headers: Record<string, string> }]> = [
      ['/', { method: 'POST', headers: {} }],
      ['/about', { method: 'POST', headers: {} }],
      ['/about', { method: 'GET', headers: { 'next-action': 'abc' } }],
      ['/about', { method: 'DELETE', headers: {} }],
      ['/api/forms/submit', { method: 'POST', headers: {} }],
      ['/api/commerce/orders', { method: 'POST', headers: {} }],
      ['/api/commerce/orders/o1/pay', { method: 'POST', headers: {} }],
      ['/api/csp-report', { method: 'POST', headers: {} }],
      ['/api/commerce/products', { method: 'POST', headers: {} }],
      ['/api/cms/collections', { method: 'GET', headers: {} }],
      ['/api/mcp', { method: 'POST', headers: { authorization: 'Bearer k' } }],
      ['/api/projects/p1/branches/b1/preview-link', { method: 'POST', headers: {} }],
      ['/projects', { method: 'GET', headers: {} }],
      ['/projects/p1/preview', { method: 'GET', headers: {} }],
      ['/API/commerce/products', { method: 'GET', headers: {} }],
    ];
    for (const [path, init] of attempts) {
      const res = await middleware(new NextRequest(`https://${PREVIEW}${path}`, { method: init.method, headers: { host: PREVIEW, cookie: 'lumitra_session=x', ...init.headers } }));
      expect(res.status, `${init.method} ${path}`).toBe(404);
      expect(isNext(res)).toBe(false);
      marked(res);
    }
    const posted = await middleware(new NextRequest(`https://${PREVIEW}/about`, { method: 'POST', headers: { host: PREVIEW } }));
    expect(await posted.text()).toMatch(/This is a preview: nothing can be sent from it/);
  });

  it('lets a preview page read its site\'s catalogue, and only read it', async () => {
    use();
    for (const path of ['/api/commerce/products', '/api/commerce/products/tee', '/api/commerce/inventory']) {
      const res = await middleware(new NextRequest(`https://${PREVIEW}${path}`, { headers: { host: PREVIEW } }));
      expect(isNext(res), path).toBe(true);
      marked(res);
    }
  });

  it('is an ordinary published host while no sites base host is configured, and never the editor', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(new NextRequest(`https://${PREVIEW}/projects`, { headers: { host: PREVIEW, cookie: 'lumitra_session=x' } }));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-robots-tag')).toBeNull();
  });
});
