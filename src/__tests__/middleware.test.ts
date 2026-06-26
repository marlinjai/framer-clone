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
//     session -- with or without the `.lumitra.co` cookie it flows through to
//     host-based resolution, never bounced;
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
  it('a published-host non-root request without a session passes through, NOT bounced', async () => {
    process.env.EDITOR_HOST = EDITOR;
    // Even a path that WOULD be gated on the editor host is open here: the
    // published plane resolves tenancy from the HOST in the route handler.
    const res = await middleware(req(`https://${PUBLISHED}/projects`, { host: PUBLISHED }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get('location')).toBeNull();
    expect(isNext(res)).toBe(true);
  });

  it('a present apex cookie does NOT authorize a published-host request (same result either way)', async () => {
    process.env.EDITOR_HOST = EDITOR;
    // D2 is an authz decision: the `.lumitra.co` cookie is still SENT to the
    // published host by the browser, but the middleware ignores it for authz.
    const withCookie = await middleware(
      req(`https://${PUBLISHED}/projects`, { host: PUBLISHED, cookie: 'lumitra_session=abc' }),
    );
    const withoutCookie = await middleware(
      req(`https://${PUBLISHED}/projects`, { host: PUBLISHED }),
    );
    expect(isNext(withCookie)).toBe(true);
    expect(isNext(withoutCookie)).toBe(true);
  });
});

describe('middleware: matcher reconciled to real routes (MT-16)', () => {
  it('gates `/`, `/projects/*`, and the authoring `/api/*` families', () => {
    expect(config.matcher).toEqual([
      '/',
      '/projects/:path*',
      '/api/projects/:path*',
      '/api/ai/:path*',
    ]);
  });

  it('drops the dead `/editor`, `/api/sites`, `/api/admin` patterns', () => {
    expect(config.matcher).not.toContain('/editor/:path*');
    expect(config.matcher).not.toContain('/api/sites/:path*');
    expect(config.matcher).not.toContain('/api/admin/:path*');
  });

  it('leaves public read/render families out of the matcher (open, never bounced)', () => {
    // The storefront catch-all, /preview, /api/health, and the public
    // /api/cms + /api/commerce read/order paths must NOT be matched.
    for (const open of [
      '/api/cms/:path*',
      '/api/commerce/:path*',
      '/api/health/:path*',
      '/preview/:path*',
    ]) {
      expect(config.matcher).not.toContain(open);
    }
  });
});
