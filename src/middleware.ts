import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
// Import the sentinel from the dependency-free module, NOT from publicResolver:
// that pulls `server-only` + Prisma, which cannot run in the edge middleware.
import { HOME_REWRITE_SENTINEL } from '@/server/sites/homeSentinel';
import { isEditorHost as isEditorHostname } from '@/lib/editorHost';
import { publishedHostAllows, routeFor } from '@/lib/hostRoutes';
import { CSP_REPORT_ONLY_HEADER, MAPS_CONSENT_COOKIE, reportOnlyPolicy } from '@/lib/site/cspReportOnly';
// The dependency-free bearer test, NOT src/lib/auth-machine.ts: that pulls the
// auth-brain SDK and `server-only`, which cannot run in the edge middleware.
import { carriesBearer } from '@/lib/bearer';

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
/**
 * The machine door (docs/plans/2026-11-02-lumitra-sites-agent-plugin.md): the
 * only path a request authenticated by a company API key
 * (`Authorization: Bearer <key>`) may reach on the authoring plane.
 *
 * THIS GATE NEVER VERIFIES A KEY. It only decides which credential a path
 * accepts: any string after `Bearer` passes it. Every handler behind
 * `/api/mcp` (step 4 of the plan) MUST call `verifyCompanyKey`
 * (src/lib/auth-machine.ts) itself and refuse anything but a verified key;
 * the middleware is never the gate.
 */
const MACHINE_PATH = '/api/mcp';

/**
 * The path as the gates compare it: percent-decoded, lowercased, with repeated
 * slashes collapsed, so `/api/MCP`, `/api/%6Dcp` and `//api/mcp` fall under the
 * same rule as `/api/mcp` (and `/api/%70rojects` under `/api/projects`). A path
 * that does not decode is compared as it came.
 */
function normalizedPath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Malformed percent-encoding: keep the raw path.
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, '/');
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isMachinePath(pathname: string): boolean {
  return isUnder(normalizedPath(pathname), MACHINE_PATH);
}

/** Which editor-plane surface a path belongs to, or null for any other path. */
function isEditorPlanePath(pathname: string): 'api' | 'page' | null {
  const path = normalizedPath(pathname);
  const under = (prefix: string) => isUnder(path, prefix);
  if (under('/api/projects') || under('/api/ai') || under('/api/books') || under(MACHINE_PATH)) return 'api';
  if (under('/projects')) return 'page';
  return null;
}

/**
 * How a request is passed on. A bearer request goes on WITHOUT its cookies, on
 * every path and every host: it is judged by its key alone, and every session
 * reader downstream (`next/headers` cookies, src/lib/auth-api.ts) then finds
 * no `lumitra_session` to fall back to, so "bearer only" holds for every
 * route, not just the ones this gate names.
 */
function passInit(request: NextRequest, bearer: boolean): { request: { headers: Headers } } | undefined {
  if (!bearer) return undefined;
  const headers = new Headers(request.headers);
  headers.delete('cookie');
  return { request: { headers } };
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

/**
 * The 404 a published host answers for anything its allowlist
 * (src/lib/hostRoutes.ts) does not name, or null when the request may pass.
 * `routePath` is the path Next will route: the home sentinel for `/`. A server
 * action is refused on every path: Next runs one posted to ANY page path, and
 * every server action is the editor's. An `/api` path must name an allowlisted
 * API route, never fall through to the site catch-all.
 *
 * The editor-plane test of the machine door change (`isEditorPlanePath`, on the
 * normalized path) is kept as a second fence: the allowlist matches paths as
 * Next does (case-sensitive), so `/API/PROJECTS` or `//api/mcp` would already
 * miss every API entry, but whatever normalizes to an editor-plane path is
 * refused here regardless of what the table says. Whether a path is an API
 * path is decided on the normalized path too, so such a path gets the JSON 404.
 */
function refuseOnPublishedHost(request: NextRequest, routePath: string): NextResponse | null {
  const normalized = normalizedPath(routePath);
  const isApi = isUnder(normalized, '/api');
  const allowed =
    !request.headers.has('next-action') &&
    isEditorPlanePath(routePath) === null &&
    publishedHostAllows(routePath, request.method) &&
    (!isApi || (routeFor(routePath)?.route.startsWith('/api/') ?? false));
  if (allowed) return null;
  if (isApi) {
    return NextResponse.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
  }
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
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
  const bearer = carriesBearer(request);
  const machinePath = isMachinePath(request.nextUrl.pathname);
  const pass = passInit(request, bearer);

  // Before any routing: nothing on the editor host accepts a write from another
  // origin, and a published site is another origin. The one exception is a
  // bearer request to the machine door: the refusal protects the ambient
  // session cookie, and a bearer request never uses it (its cookies are
  // stripped below and the route reads only the key), so an MCP client that
  // sends an Origin header is not refused. A cookie-only cross-origin write to
  // the machine door is still refused here.
  if (isEditorHost && !(bearer && machinePath) && isCrossOriginWrite(request)) {
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
      // segment and resolves it as the home request. Only a read: a post or a
      // server action to the home page is refused like any other path. A
      // bearer request is rewritten without its cookies (`pass`).
      const refused = refuseOnPublishedHost(request, `/${HOME_REWRITE_SENTINEL}`);
      if (refused) return refused;
      return withReportOnlyPolicy(request, NextResponse.rewrite(new URL(`/${HOME_REWRITE_SENTINEL}`, request.url), pass));
    }
    // Editor host root: preserve EXACTLY today's behavior. The editor `/` is NOT
    // auth-bounced here; it loads client-only and owns its own auth. Do NOT start
    // gating `/`.
    return NextResponse.next(pass);
  }

  // D2 (resolved 2026-06-26): the `.lumitra.co` apex `lumitra_session` cookie is
  // INTENTIONAL suite-wide SSO and is NOT made host-only -- so the browser still
  // sends it to `*.sites.lumitra.co`. But the published-site plane derives
  // tenancy from the HOST and must NEVER be AUTHORIZED by that apex session. So
  // on a NON-editor (published) host the middleware never applies the editor
  // cookie gate (no login bounce) and serves only its allowlist (storefront
  // pages, reads and anonymous order POSTs, which flow through to host-based
  // tenant resolution); every other route answers 404 there. (No
  // auth-brain cookie-domain change is made; this is an authz decision, not a
  // cookie-transport one.)
  if (!isEditorHost) {
    // A published host is a customer's origin, so it is an ALLOWLIST
    // (src/lib/hostRoutes.ts): the site pages, the per-host files, and the few
    // platform endpoints a published page calls (form submit, the storefront
    // commerce reads, order and pay, the CSP report, the published CMS reads,
    // health), each for its listed methods. Every other route answers 404 here,
    // BEFORE any handler or page runs and regardless of any cookie: the editor
    // pages and its preview, the authoring, AI, Books, catalogue and payments
    // APIs (all of them authorize with the apex session the browser still sends
    // here, which D2 forbids on this plane), the webhook, the host timers, and
    // the machine door `/api/mcp` (it belongs to the editor host only, so it
    // has no published entry; a bearer changes nothing here). A 404, NOT a
    // login bounce, so nothing about the editor is revealed and anonymous
    // traffic is never sent to the login page. A server action is refused too:
    // Next runs one posted to ANY page path, and every server action is the
    // editor's (refuseOnPublishedHost). The handlers keep their own host checks
    // as defense in depth (src/server/commerce/editorTenant.ts and friends).
    const { pathname } = request.nextUrl;
    const refused = refuseOnPublishedHost(request, pathname);
    if (refused) return refused;
    // What the allowlist lets through still travels on without its cookies when
    // it carries a bearer (`pass`). The matcher also brings every API route here
    // (for the cross-origin check, which only runs on the editor host): those
    // are not pages, so they pass unmarked.
    if (pathname === '/api' || pathname.startsWith('/api/')) return NextResponse.next(pass);
    return withReportOnlyPolicy(request, NextResponse.next(pass));
  }

  // The matcher runs this for every API route so the cross-origin check above
  // covers them, and for page paths so a published page gets its policy; only
  // the editor plane has a session gate. A bearer request travels on without
  // its cookies (`pass`), wherever it goes.
  if (!isEditorPlanePath(request.nextUrl.pathname)) {
    return NextResponse.next(pass);
  }

  // The machine door accepts a bearer and nothing else: a browser session is
  // no credential there (401 with the challenge an MCP client understands).
  if (machinePath) {
    if (!bearer) {
      return NextResponse.json(
        { error: { code: 'unauthorized', message: 'a company API key is required' } },
        { status: 401, headers: { 'www-authenticate': 'Bearer realm="lumitra-sites"' } },
      );
    }
    return NextResponse.next(pass);
  }

  // Editor host, gated authoring surface (`/projects/*`, `/api/projects/*`,
  // `/api/ai/*`, `/api/books/*`): coarse cookie-PRESENCE gate. A bearer request
  // is judged as if it carried no cookie: a key opens only the machine door, so
  // it gets exactly the 401 (or login bounce) of a request without a session.
  const sessionCookie = bearer ? undefined : request.cookies.get('lumitra_session')?.value;

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

  return NextResponse.next(pass);
}

export const config = {
  // Reconciled to the REAL routes on disk. Gate the authoring surface only;
  // everything a logged-out visitor legitimately hits stays OPEN (unmatched, or
  // matched and passed through -> no login bounce):
  //   - the `(site)/[...slug]` storefront catch-all + the published-site root
  //     serve anonymous traffic: matched only so a published page gets the
  //     report-only policy, never gated on any host
  //   - /preview (and /projects/<id>/preview, reached via the gated dashboard)
  //     render the editor's previews: open on the editor host, 404 on a
  //     published host like every route its allowlist does not name
  //   - /api/health/* is the liveness probe
  //   - /api/cms + /api/commerce are LEFT OPEN here because they serve BOTH
  //     planes (on a published host only the methods src/lib/hostRoutes.ts
  //     lists, so CMS writes 404 there): on a published-site host their reads are scoped to the Host's
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
    // (`/api/projects`, `/api/ai`, `/api/books`) also get the session gate,
    // and `/api/mcp` the bearer-only gate of the machine door.
    '/api/:path*',
    // Published pages, for the report-only policy: any path except API routes,
    // build output, what is inside /images and /fonts, the per-host files and
    // the uploaded site images (an image response carries its own policy).
    // Other public files carry the header, where it does nothing. /preview is
    // matched too: the host decides, so the editor's preview stays unmarked on
    // the editor host, and a published host answers it with a 404.
    //
    // /site-images/* (like the per-host files) never reaches this middleware,
    // on purpose: its handler (src/app/site-images/[file]/route.ts) answers
    // GET only, reads no session or cookie, resolves the site from the Host
    // alone and serves only that published site's images (404 on the editor
    // host and on any host naming no published site), so neither the
    // allowlist, the cross-origin check nor the bearer cookie strip has
    // anything to guard there. Its entry in src/lib/hostRoutes.ts
    // (published: GET) records that classification.
    '/((?!(?:api|_next)(?:/|$)|(?:images|fonts|site-images)/.|(?:favicon\\.ico|robots\\.txt|sitemap\\.xml|site\\.webmanifest)$).+)',
  ],
};
