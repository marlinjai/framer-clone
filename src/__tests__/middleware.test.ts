// @vitest-environment node
//
// The edge auth gate + host-aware root routing. Asserts that:
//   - a published-site (non-editor) host `/` is REWRITTEN to the home sentinel
//     and is NOT bounced to login (anonymous site visitors must be served);
//   - the editor host `/` (and localhost / unset EDITOR_HOST) returns next()
//     with no rewrite and no bounce (today's editor behavior, unchanged);
//   - an unauthenticated /editor still bounces to the auth-brain login;
//   - an authenticated /editor passes through.
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from '../middleware';
import { HOME_REWRITE_SENTINEL } from '@/server/sites/homeSentinel';

const EDITOR = 'app.lumitra.co';

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

describe('middleware: auth gate (unchanged)', () => {
  it('bounces an unauthenticated /editor to the auth-brain login', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(req(`https://${EDITOR}/editor`, { host: EDITOR }));
    expect(res.status).toBe(307);
    const location = res.headers.get('location')!;
    expect(location).toContain('/login');
    expect(location).toContain('return_to=');
  });

  it('lets an authenticated /editor through', async () => {
    process.env.EDITOR_HOST = EDITOR;
    const res = await middleware(
      req(`https://${EDITOR}/editor`, { host: EDITOR, cookie: 'lumitra_session=abc' }),
    );
    expect(isNext(res)).toBe(true);
  });

  it('matcher gates the root and the authoring surface', () => {
    expect(config.matcher).toContain('/');
    expect(config.matcher).toContain('/editor/:path*');
    expect(config.matcher).toContain('/api/sites/:path*');
    expect(config.matcher).toContain('/api/admin/:path*');
  });
});
