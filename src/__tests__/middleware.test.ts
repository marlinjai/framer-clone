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
//     `/editor`, `/api/sites`, `/api/admin` patterns are gone.
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../middleware';
import { HOME_REWRITE_SENTINEL } from '@/server/sites/homeSentinel';

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
      // A fetch client (PublishButton/SaveButton, cms-agent) must get a JSON 401,
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

describe('middleware: matcher reconciled to real routes (MT-16)', () => {
  it('gates `/`, `/projects/*`, and the authoring `/api/*` families', () => {
    expect(config.matcher).toEqual([
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
