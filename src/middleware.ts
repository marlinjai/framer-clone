import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
// Import the sentinel from the dependency-free module, NOT from publicResolver:
// that pulls `server-only` + Prisma, which cannot run in the edge middleware.
import { HOME_REWRITE_SENTINEL } from '@/server/sites/homeSentinel';
import { isEditorHost as isEditorHostname } from '@/lib/editorHost';
import { CSP_REPORT_ONLY_HEADER, MAPS_CONSENT_COOKIE, reportOnlyPolicy } from '@/lib/site/cspReportOnly';

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
/** Which editor-plane surface a path belongs to, or null for any other path. */
function isEditorPlanePath(pathname: string): 'api' | 'page' | null {
  const under = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  if (under('/api/projects') || under('/api/ai') || under('/api/books')) return 'api';
  if (under('/projects')) return 'page';
  return null;
}

/**
 * True for a state-changing request that a page on another origin caused. The
 * `.lumitra.co` session cookie is sent from every published site (same site, so
 * SameSite=Lax does not stop it), and a stored form can post plain text that
 * parses as JSON, so the authoring API must know where a request came from.
 * Browsers state that in Sec-Fetch-Site; older ones send Origin. A request with
 * neither is not from a browser page (a webhook, the host timers) and carries
 * no ambient session.
 */
function isCrossOriginWrite(request: NextRequest): boolean {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return false;
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none';
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return new URL(origin).host.toLowerCase() !== (host ?? '').toLowerCase();
  } catch {
    return true;
  }
}

/**
 * A published page's response, carrying the report-only policy
 * (src/lib/site/cspReportOnly.ts). Only a document on a published host gets it:
 * the editor host never does, and it never blocks anything. Google Maps frames
 * are allowed only for a visitor whose maps consent the cookie records.
 */
function withReportOnlyPolicy(request: NextRequest, response: NextResponse): NextResponse {
  response.headers.set(CSP_REPORT_ONLY_HEADER, reportOnlyPolicy(request.cookies.get(MAPS_CONSENT_COOKIE)?.value === '1'));
  return response;
}

export async function middleware(request: NextRequest) {
  // Host-aware root routing. Next is host-agnostic, so without this `/` is the
  // editor (`app/page.tsx`) on EVERY host. The discriminator is the request Host:
  // the editor is ALWAYS served on the fixed lumitra-owned EDITOR_HOST; any other
  // host is a published site and its root `/` must serve the storefront home.
  // The shared editor-host test (src/lib/editorHost.ts): with no EDITOR_HOST,
  // or on localhost, EVERYTHING counts as the editor host so `/` stays the
  // editor and local dev is unchanged. The rewrite only activates in prod where
  // EDITOR_HOST is set and the request Host differs.
  const isEditorHost = isEditorHostname(request.headers.get('host'));

  // Before any routing: nothing on the editor host accepts a write from another
  // origin, and a published site is another origin.
  if (isEditorHost && isCrossOriginWrite(request)) {
    return NextResponse.json(
      { error: { code: 'cross_origin_refused', message: 'cross-origin request refused' } },
      { status: 403 },
    );
  }

  if (request.nextUrl.pathname === '/') {
    if (!isEditorHost) {
      // Published-site root -> storefront home. This returns BEFORE the cookie
      // check below, so an anonymous site visitor is served (NOT bounced to the
      // auth-brain login). A rewrite (NOT redirect): the visitor's URL stays `/`,
      // the required catch-all `(site)/[...slug]` route receives the sentinel
      // segment and resolves it as the home request.
      return withReportOnlyPolicy(request, NextResponse.rewrite(new URL(`/${HOME_REWRITE_SENTINEL}`, request.url)));
    }
    // Editor host root: preserve EXACTLY today's behavior. The editor `/` is NOT
    // auth-bounced here; it loads client-only and owns its own auth. Do NOT start
    // gating `/`.
    return NextResponse.next();
  }

  // D2 (resolved 2026-06-26): the `.lumitra.co` apex `lumitra_session` cookie is
  // INTENTIONAL suite-wide SSO and is NOT made host-only -- so the browser still
  // sends it to `*.sites.lumitra.co`. But the published-site plane derives
  // tenancy from the HOST and must NEVER be AUTHORIZED by that apex session. So
  // on a NON-editor (published) host the middleware never applies the editor
  // cookie gate (no login bounce) and REFUSES the session-authorized editor
  // surfaces outright (404); everything else (storefront pages, reads and
  // anonymous order POSTs) flows through to host-based tenant resolution. (No
  // auth-brain cookie-domain change is made; this is an authz decision, not a
  // cookie-transport one.)
  if (!isEditorHost) {
    // The editor plane (`/projects/*` pages, `/api/projects/*`, `/api/ai/*`)
    // must not run AT ALL on a published host: every one of them authorizes
    // with the apex session the browser still sends here, which D2 forbids on
    // the published plane. So they are refused with a 404 (as if the surface did
    // not exist on this host, revealing nothing about the editor), BEFORE any
    // handler or page runs and regardless of any cookie. A 404, NOT a login
    // bounce: anonymous published-site traffic is never sent to the login page.
    // In the current (inverted) deploy the editor is reached on its own
    // EDITOR_HOST, which this check recognizes, so no editor path relies on a
    // storefront host. The editor commerce handlers keep their own host check as
    // defense in depth (src/server/commerce/editorTenant.ts).
    const editorPlane = isEditorPlanePath(request.nextUrl.pathname);
    if (editorPlane === 'api') {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'not found' } },
        { status: 404 },
      );
    }
    if (editorPlane === 'page') {
      return new NextResponse('Not found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    // The matcher also brings every API route here (for the check above, which
    // only runs on the editor host): those are not pages, so they pass unmarked.
    const { pathname } = request.nextUrl;
    if (pathname === '/api' || pathname.startsWith('/api/')) return NextResponse.next();
    return withReportOnlyPolicy(request, NextResponse.next());
  }

  // The matcher runs this for every API route so the cross-origin check above
  // covers them, and for page paths so a published page gets its policy; only
  // the editor plane has a session gate.
  if (!isEditorPlanePath(request.nextUrl.pathname)) return NextResponse.next();

  // Editor host, gated authoring surface (`/projects/*`, `/api/projects/*`,
  // `/api/ai/*`): coarse cookie-PRESENCE gate.
  const sessionCookie = request.cookies.get('lumitra_session')?.value;

  if (!sessionCookie) {
    // API requests get a JSON 401 -- a fetch client (PublishButton/SaveButton,
    // the cms-agent) must NOT be 302-redirected to an HTML login page, or its
    // error handling breaks (e.g. an expired session mid-edit). Page requests
    // bounce to the auth-brain login. (Matched routes ALSO self-guard via
    // getVerifiedSession; this edge bounce is defense in depth.)
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: 'authentication required' } },
        { status: 401 },
      );
    }
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
  // Reconciled to the REAL routes on disk. Gate the authoring surface only;
  // everything a logged-out visitor legitimately hits stays OPEN (unmatched, or
  // matched and passed through -> no login bounce):
  //   - the `(site)/[...slug]` storefront catch-all + the published-site root
  //     serve anonymous traffic: matched only so a published page gets the
  //     report-only policy, never gated on any host
  //   - /preview/* (and /projects/<id>/preview, reached via the gated dashboard)
  //     render anonymous previews: matched only for the policy, as above
  //   - /api/health/* is the liveness probe
  //   - /api/cms + /api/commerce are LEFT OPEN here because they serve BOTH
  //     planes: on a published-site host their reads are scoped to the Host's
  //     site (never the session, D2/D4), on the editor host the CMS reads and
  //     all writes check the session themselves (src/server/cms/readScope.ts,
  //     the write guards, src/server/commerce/editorTenant.ts). Anonymous order
  //     POSTs to /api/commerce/orders must reach their handler too, so bouncing
  //     either prefix to a login page here would break storefront reads and
  //     checkout. Defense in depth lives in the handlers, not here.
  //   - _next static assets, favicon, robots and the uploaded site images
  //     (/site-images/*, served per host) are never gated
  //
  // The removed `/editor`, `/api/sites`, `/api/admin` patterns matched NO route
  // on disk (dead-matcher drift); the live authoring surfaces are `/projects`,
  // `/api/projects`, `/api/ai`.
  matcher: [
    // Root: host-aware routing (editor host -> editor; published-site host ->
    // storefront-home rewrite). Returns before the auth gate, so anonymous
    // site-root traffic is served, never bounced to login.
    '/',
    // Editor authoring dashboard (MT-09/MT-10) + its per-project sub-routes.
    '/projects/:path*',
    // Every API route, for the cross-origin check. The editor-plane families
    // (`/api/projects`, `/api/ai`, `/api/books`) also get the session gate.
    '/api/:path*',
    // Published pages, for the report-only policy: any path except API routes,
    // build output, what is inside /images and /fonts, the per-host files and
    // the uploaded site images (an image response carries its own policy).
    // Other public files carry the header, where it does nothing. /preview is
    // matched too: the host decides, so the editor's preview stays unmarked on
    // the editor host, and a published host marks whatever document it serves.
    '/((?!(?:api|_next)(?:/|$)|(?:images|fonts|site-images)/.|(?:favicon\\.ico|robots\\.txt|sitemap\\.xml|site\\.webmanifest)$).+)',
  ],
};
