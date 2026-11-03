// src/lib/hostRoutes.ts
//
// Which host may reach which route under src/app. A published host
// (`*.sites.lumitra.co`, a custom domain) is a customer's origin: it serves the
// customer's pages and the few platform endpoints a published page calls, and
// nothing of the editor. The editor host serves everything, as before. This is
// an ALLOWLIST: a published host reaches a route only when the table below says
// so, for the methods it names, and every other route (the editor's pages, its
// preview, its APIs, the operator and webhook endpoints) answers 404 there.
//
// Every route under src/app has exactly one entry; src/lib/__tests__/
// hostRoutes.test.ts walks the directory (pages, route handlers and the
// metadata files such as `opengraph-image` or `robots`, in every extension) and
// fails on a route without one, so a new route must be classified before it
// ships. It also fails on an optional catch-all, a parallel slot or an
// intercepting route, which `parse` below does not match as Next does yet.
//
// Dependency-free on purpose: the edge middleware imports it.

/** A Next route: its path pattern, as the app directory names it (route groups dropped). */
export interface HostRoute {
  /** `/api/commerce/orders/[orderId]/pay`, `/[...slug]`, `/`. */
  route: string;
  /**
   * The methods a PUBLISHED host may use on it; absent means editor host only.
   * HEAD is implied wherever GET is listed.
   */
  published?: readonly ('GET' | 'POST')[];
  /** Why it is classified so, for the reader of this table. */
  why: string;
}

export const HOST_ROUTES: readonly HostRoute[] = [
  // Published pages. `/` on a published host never reaches the editor page:
  // the middleware rewrites it to the home sentinel, a path of the catch-all.
  { route: '/[...slug]', published: ['GET'], why: 'the published site pages (src/app/(site))' },
  { route: '/', why: 'the editor; a published host rewrites `/` to its home page instead' },
  // Per-host files. The matcher leaves them out, so the middleware never runs
  // on them; each answers for the requesting host itself.
  { route: '/favicon.ico', published: ['GET'], why: 'the site favicon, per host' },
  { route: '/robots.txt', published: ['GET'], why: 'the site robots file, per host' },
  { route: '/sitemap.xml', published: ['GET'], why: 'the site sitemap, per host' },
  { route: '/site.webmanifest', published: ['GET'], why: 'the site manifest, per host' },
  {
    route: '/site-images/[file]',
    published: ['GET'],
    why: 'uploaded favicon and sharing images, per host (src/app/site-images/[file]/route.ts); outside the matcher like the files above',
  },

  // What a published page calls.
  { route: '/api/forms/submit', published: ['POST'], why: 'a published form posts here (src/lib/forms/sendForm.ts)' },
  { route: '/api/commerce/products', published: ['GET'], why: 'the storefront islands read the catalog' },
  { route: '/api/commerce/products/[handle]', published: ['GET'], why: 'the storefront islands read one product' },
  { route: '/api/commerce/inventory', published: ['GET'], why: 'the storefront islands read availability' },
  { route: '/api/commerce/orders', published: ['POST'], why: 'the checkout island places the order (CheckoutButton.tsx)' },
  { route: '/api/commerce/orders/[orderId]/pay', published: ['POST'], why: 'the checkout pays the order (storefrontGateway.ts)' },
  { route: '/api/csp-report', published: ['POST'], why: 'the report-only policy of a published page reports to its own host' },
  {
    route: '/api/cms/collections',
    published: ['GET'],
    why: 'the published-plane CMS read, scoped to the host site (src/server/cms/readScope.ts); writes are editor only',
  },
  { route: '/api/cms/collections/[id]', published: ['GET'], why: 'published-plane CMS read, as above' },
  { route: '/api/cms/collections/[id]/rows', published: ['GET'], why: 'published-plane CMS read, as above' },
  { route: '/api/cms/collections/[id]/rows/[rowId]', published: ['GET'], why: 'published-plane CMS read, as above' },
  { route: '/api/health', published: ['GET'], why: 'liveness; a container probe names no editor host' },
  { route: '/api/health/db', published: ['GET'], why: 'readiness, as above' },

  // The editor's pages.
  { route: '/preview', why: 'the editor preview of a draft' },
  { route: '/projects', why: 'the editor dashboard' },
  { route: '/projects/[projectId]', why: 'the editor' },
  { route: '/projects/[projectId]/preview', why: 'the editor preview' },
  {
    route: '/projects/[projectId]/confirm/[approvalId]',
    why: 'a person approves an agent publish or rollback (src/server/mcp/approvals.ts); signed-in editor only, never framed',
  },
  { route: '/projects/books', why: 'Books' },
  { route: '/projects/books/documents/[id]', why: 'Books' },
  { route: '/projects/books/import', why: 'Books' },
  { route: '/projects/books/templates/[id]', why: 'Books' },
  { route: '/projects/catalog', why: 'the catalogue' },
  { route: '/projects/payments', why: 'payments settings' },
  { route: '/projects/migrate-company', why: 'the company switch' },
  // The Books engine harness: only a BOOKS_ENGINE_HARNESS=1 build has these.
  { route: '/dev/books-engine', why: 'the Books engine browser harness' },
  { route: '/dev/books-engine/cases', why: 'the Books engine browser harness' },
  { route: '/dev/books-engine/files/[kind]/[sha256]', why: 'the Books engine browser harness' },

  // The editor's APIs.
  { route: '/api/projects', why: 'authoring' },
  { route: '/api/projects/list', why: 'authoring' },
  { route: '/api/projects/save', why: 'authoring' },
  { route: '/api/projects/publish', why: 'authoring' },
  { route: '/api/projects/unpublish', why: 'authoring' },
  { route: '/api/projects/[projectId]', why: 'authoring' },
  { route: '/api/projects/[projectId]/revisions', why: 'authoring' },
  { route: '/api/projects/[projectId]/revisions/[number]', why: 'authoring' },
  { route: '/api/projects/[projectId]/confirmations/[approvalId]', why: 'the approval page records a decision (session cookie only)' },
  { route: '/api/mcp', why: 'the Lumitra Sites MCP endpoint, company API keys only (src/server/mcp/handler.ts)' },
  { route: '/api/projects/[projectId]/domains', why: 'authoring' },
  { route: '/api/projects/[projectId]/domains/[domainId]', why: 'authoring' },
  { route: '/api/projects/[projectId]/domains/[domainId]/verify', why: 'authoring' },
  { route: '/api/projects/[projectId]/erasures', why: 'authoring' },
  { route: '/api/projects/[projectId]/erasures/search', why: 'authoring' },
  { route: '/api/projects/[projectId]/forms/submissions', why: 'authoring' },
  { route: '/api/projects/[projectId]/forms/submissions/[submissionId]', why: 'authoring' },
  { route: '/api/projects/[projectId]/forms/submissions/export', why: 'authoring' },
  { route: '/api/projects/[projectId]/images', why: 'authoring' },
  { route: '/api/projects/[projectId]/images/[sha256]', why: 'authoring' },
  { route: '/api/projects/[projectId]/commerce/products', why: 'the editor commerce reads' },
  { route: '/api/projects/[projectId]/commerce/products/[handle]', why: 'the editor commerce reads' },
  { route: '/api/projects/[projectId]/commerce/inventory', why: 'the editor commerce reads' },
  { route: '/api/ai/edit', why: 'AI authoring' },
  { route: '/api/ai/cms-agent', why: 'AI authoring' },
  { route: '/api/ai/cms-agent/undo', why: 'AI authoring' },
  { route: '/api/ai/generate-page', why: 'AI authoring' },
  { route: '/api/ai/generate-page/[id]', why: 'AI authoring' },
  { route: '/api/ai/review-page', why: 'AI authoring' },
  { route: '/api/ai/review-page/[id]', why: 'AI authoring' },
  { route: '/api/books/assets', why: 'Books' },
  { route: '/api/books/assets/[sha256]', why: 'Books' },
  { route: '/api/books/catalogue', why: 'Books' },
  { route: '/api/books/contacts', why: 'Books' },
  { route: '/api/books/customers', why: 'Books' },
  { route: '/api/books/customers/[id]', why: 'Books' },
  { route: '/api/books/documents', why: 'Books' },
  { route: '/api/books/documents/[id]', why: 'Books' },
  { route: '/api/books/documents/[id]/cancel', why: 'Books' },
  { route: '/api/books/documents/[id]/correct', why: 'Books' },
  { route: '/api/books/documents/[id]/customer', why: 'Books' },
  { route: '/api/books/documents/[id]/issue', why: 'Books' },
  { route: '/api/books/documents/[id]/lines', why: 'Books' },
  { route: '/api/books/documents/[id]/lines/[lineId]', why: 'Books' },
  { route: '/api/books/documents/[id]/lines/reorder', why: 'Books' },
  { route: '/api/books/documents/[id]/pdf', why: 'Books' },
  { route: '/api/books/documents/[id]/render-input', why: 'Books' },
  { route: '/api/books/fonts/[sha256]', why: 'Books' },
  { route: '/api/books/imports', why: 'Books' },
  { route: '/api/books/imports/[id]', why: 'Books' },
  { route: '/api/books/imports/[id]/by-hand', why: 'Books' },
  { route: '/api/books/imports/[id]/confirm', why: 'Books' },
  { route: '/api/books/imports/[id]/confirm-number', why: 'Books' },
  { route: '/api/books/imports/[id]/discard', why: 'Books' },
  { route: '/api/books/imports/[id]/extract', why: 'Books' },
  { route: '/api/books/imports/[id]/pdf', why: 'Books' },
  { route: '/api/books/imports/[id]/recheck', why: 'Books' },
  { route: '/api/books/settings', why: 'Books' },
  { route: '/api/books/templates', why: 'Books' },
  { route: '/api/books/templates/[id]', why: 'Books' },
  { route: '/api/books/templates/[id]/versions', why: 'Books' },
  { route: '/api/books/templates/preview', why: 'Books' },
  { route: '/api/catalog/collections', why: 'the catalogue' },
  { route: '/api/catalog/collections/[id]', why: 'the catalogue' },
  { route: '/api/catalog/collections/[id]/products', why: 'the catalogue' },
  { route: '/api/catalog/images', why: 'the catalogue' },
  { route: '/api/catalog/images/[sha256]', why: 'the catalogue' },
  { route: '/api/catalog/meta', why: 'the catalogue' },
  { route: '/api/catalog/products', why: 'the catalogue' },
  { route: '/api/catalog/products/bulk', why: 'the catalogue' },
  { route: '/api/catalog/products/samples', why: 'the catalogue' },
  { route: '/api/catalog/products/[id]', why: 'the catalogue' },
  { route: '/api/catalog/products/[id]/collections', why: 'the catalogue' },
  { route: '/api/catalog/products/[id]/images', why: 'the catalogue' },
  { route: '/api/catalog/products/[id]/images/[imageId]', why: 'the catalogue' },
  { route: '/api/catalog/products/[id]/options', why: 'the catalogue' },
  { route: '/api/catalog/products/[id]/sites', why: 'the catalogue' },
  { route: '/api/catalog/products/[id]/variants/[variantId]', why: 'the catalogue' },
  { route: '/api/catalog/products/[id]/variants/[variantId]/stock', why: 'the catalogue' },
  { route: '/api/payments/mail', why: 'payments settings' },
  { route: '/api/payments/mail/senders', why: 'payments settings' },
  { route: '/api/payments/receipts', why: 'payments settings' },
  { route: '/api/payments/stripe/account', why: 'payments settings' },
  { route: '/api/payments/stripe/onboarding', why: 'payments settings' },
  { route: '/api/payments/stripe/oauth/start', why: 'payments settings' },
  { route: '/api/payments/stripe/oauth/callback', why: 'Stripe returns the shop owner to the editor' },
  { route: '/api/payments/stripe/return', why: 'Stripe returns the shop owner to the editor' },
  { route: '/api/payments/stripe/webhook', why: 'Stripe delivers to the platform, never to a customer origin' },
  { route: '/api/receipts/[token]', why: 'the receipt link in the confirmation mail names the editor host' },
  { route: '/api/internal/commerce/expired-payments', why: 'host timer, bearer token' },
  { route: '/api/internal/commerce/jobs/run', why: 'host timer, bearer token' },
  { route: '/api/internal/custom-domains/hostnames', why: 'host timer, bearer token' },
  { route: '/api/internal/custom-domains/recheck', why: 'host timer, bearer token' },
];

type Segment = { kind: 'static'; name: string } | { kind: 'dynamic' } | { kind: 'catchAll' };

function parse(route: string): Segment[] {
  return route
    .split('/')
    .filter(Boolean)
    .map((part): Segment => {
      if (part.startsWith('[...') && part.endsWith(']')) return { kind: 'catchAll' };
      if (part.startsWith('[') && part.endsWith(']')) return { kind: 'dynamic' };
      return { kind: 'static', name: part };
    });
}

const COMPILED = HOST_ROUTES.map((entry) => ({ entry, segments: parse(entry.route) }));

/** True when `segments` match the path parts, as Next matches a route. */
function matches(segments: Segment[], parts: string[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.kind === 'catchAll') return parts.length > i;
    if (i >= parts.length) return false;
    if (segment.kind === 'static' && segment.name !== parts[i]) return false;
  }
  return parts.length === segments.length;
}

const RANK = { static: 3, dynamic: 2, catchAll: 1 } as const;

/** Next prefers, segment by segment, a static name over a dynamic one over a catch-all. */
function moreSpecific(a: Segment[], b: Segment[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ra = a[i] ? RANK[a[i].kind] : 0;
    const rb = b[i] ? RANK[b[i].kind] : 0;
    if (ra !== rb) return ra > rb;
  }
  return false;
}

/** The route Next would serve `pathname` with, or null when none matches. */
export function routeFor(pathname: string): HostRoute | null {
  let parts: string[];
  try {
    parts = pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  let best: (typeof COMPILED)[number] | null = null;
  for (const candidate of COMPILED) {
    if (!matches(candidate.segments, parts)) continue;
    if (!best || moreSpecific(candidate.segments, best.segments)) best = candidate;
  }
  return best?.entry ?? null;
}

/**
 * May a published host serve `method pathname`? Only an allowlisted route, with
 * one of its listed methods (HEAD where GET is listed). A path no route matches
 * is refused: Next would answer it with a 404 anyway.
 */
export function publishedHostAllows(pathname: string, method: string): boolean {
  const route = routeFor(pathname);
  if (!route?.published) return false;
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return (route.published as readonly string[]).includes(verb);
}
