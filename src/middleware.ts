import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
// Import the sentinel from the dependency-free module, NOT from publicResolver:
// that pulls `server-only` + Prisma, which cannot run in the edge middleware.
import { HOME_REWRITE_SENTINEL } from '@/server/sites/homeSentinel';

/**
 * The coarse edge auth gate for framer-clone.
 *
 * framer-clone owns NO identity. The only thing this gate knows about a user is
 * whether they carry a valid auth-brain session cookie. It is the OUTER fence:
 * "may this request touch the editor / authoring API at all". Fine, per-resource
 * authorization (workspace + action via OpenFGA) is the INNER check, run inside
 * each guarded route via `src/lib/auth-api.ts` -- defense in depth.
 *
 * Unauthenticated authoring traffic is bounced to the auth-brain login with a
 * `return_to` that brings the user back to exactly where they were. `return_to`
 * is the param the auth-brain login page reads; it open-redirect-validates the
 * value (must be a *.lumitra.co https URL or a same-origin path), so we build an
 * absolute URL from the forwarded host -- which is first-party in prod.
 *
 * Edge-runtime constraint: the middleware does NOT call `verifySession` here.
 * The auth-brain SDK client transitively pulls Node-only modules and would not
 * run in the edge middleware runtime, and a network verify on every edge hit is
 * the wrong place for it. The cookie PRESENCE check is the cheap gate; the
 * cryptographic verify happens server-side in the guarded route / server
 * component (`auth()` / `authenticateRequest`), which is the boundary that
 * actually reads protected data. A forged-but-present cookie gets past this gate
 * and is rejected by that verify -- it never reaches data.
 */
export async function middleware(request: NextRequest) {
  // Host-aware root routing. Next is host-agnostic, so without this `/` is the
  // editor (`app/page.tsx`) on EVERY host. The discriminator is the request Host:
  // the editor is ALWAYS served on the fixed lumitra-owned EDITOR_HOST; any other
  // host is a published site and its root `/` must serve the storefront home.
  const editorHost = process.env.EDITOR_HOST;
  const host = (request.headers.get('host') ?? '').split(':')[0].toLowerCase();
  // Dev / unconfigured safety: with no EDITOR_HOST, or on localhost, treat
  // EVERYTHING as the editor host so `/` stays the editor and local dev is
  // unchanged. The rewrite only activates in prod where EDITOR_HOST is set and
  // the request Host differs.
  const isEditorHost =
    !editorHost ||
    host === editorHost.toLowerCase() ||
    host === 'localhost' ||
    host === '127.0.0.1';

  if (request.nextUrl.pathname === '/') {
    if (!isEditorHost) {
      // Published-site root -> storefront home. This returns BEFORE the cookie
      // check below, so an anonymous site visitor is served (NOT bounced to the
      // auth-brain login). A rewrite (NOT redirect): the visitor's URL stays `/`,
      // the required catch-all `(site)/[...slug]` route receives the sentinel
      // segment and resolves it as the home request.
      return NextResponse.rewrite(new URL(`/${HOME_REWRITE_SENTINEL}`, request.url));
    }
    // Editor host root: preserve EXACTLY today's behavior. The editor `/` is NOT
    // auth-bounced here; it loads client-only and owns its own auth. Do NOT start
    // gating `/`.
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get('lumitra_session')?.value;

  if (!sessionCookie) {
    // Rebuild the public URL the user hit (behind the proxy) so the post-login
    // bounce returns them to the same place. x-forwarded-* are set by the edge
    // proxy in prod; fall back to the request host for local/dev.
    const proto = request.headers.get('x-forwarded-proto') || 'https';
    const host =
      request.headers.get('x-forwarded-host') ||
      request.headers.get('host') ||
      '';
    const returnTo = `${proto}://${host}${request.nextUrl.pathname}${request.nextUrl.search}`;

    const authBrainUrl = process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co';
    const loginUrl = new URL('/login', authBrainUrl);
    loginUrl.searchParams.set('return_to', returnTo);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Gate the authoring surface only. Published/preview routes and public reads
  // stay open (visitors are not logged-in users):
  //   - /preview/* and the storefront render paths serve anonymous traffic
  //   - /api/health/* is the liveness probe
  //   - /api/cms, /api/commerce reads are public (v1 read-open contract) and
  //     their writes carry their own guard; do not bounce them to a login page
  //   - _next static assets, favicon, robots are never gated
  matcher: [
    // Root: host-aware routing (editor host -> editor; published-site host ->
    // storefront-home rewrite). Returns before the auth gate, so anonymous
    // site-root traffic is served, never bounced to login.
    '/',
    '/editor/:path*',
    '/api/sites/:path*',
    '/api/admin/:path*',
  ],
};
