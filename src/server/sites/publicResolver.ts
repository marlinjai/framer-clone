import 'server-only';

// publicResolver: the PUBLIC, anonymous host -> published-site resolver for the
// SSR render route. It is the read seam for `(site)/[[...slug]]`.
//
// This is deliberately a NEW file doing DIRECT Prisma reads, NOT a method on
// `SiteRepository`: that repository is workspace-scoped (every read filters by
// the verified session's workspace_id) and is owned by the parallel
// publish-write slice. The published storefront has NO session and is NOT
// workspace-scoped: the SUBDOMAIN identifies exactly one site (SiteDomain.subdomain
// is globally unique). So this resolver keys on subdomain, serves ONLY published
// sites, and never touches the tenant-scoped repository or its barrel.
//
// Resolution: Host header -> lookup key -> SiteDomain.siteId -> the published
// Site + its SitePage snapshots. A draft / archived / unknown host resolves to
// null (the route 404s). No write surface here.
//
// Two kinds of lookup key (hostLookupKeys):
//   - a SUBDOMAIN label of PUBLIC_SITE_BASE_HOST (`<label>.sites.lumitra.co`),
//     looked up on SiteDomain.subdomain;
//   - a CUSTOM hostname (plan 2026-06-25-framer-custom-domains): any other host
//     that passes the custom-domain contract (src/server/domains/hostname.ts),
//     looked up on SiteDomain.customHostname, the LIVE claim that is only set
//     once DNS ownership was verified. The row must also be `verified` or
//     `active`; a pending, failed or disconnected domain never serves a site.
// The host is normalized first: port and trailing dot dropped, lowercased, an
// internationalized name converted to punycode (browsers already send that).

import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '@/server/db';
import type { PageSnapshotOut } from '@/models/PageModel';
import { HOME_REWRITE_SENTINEL } from '@/server/sites/homeSentinel';
import { RFC1035_LABEL } from '@/server/sites/subdomain';
import {
  isClaimableHostname,
  normalizeRequestHost,
  platformZones,
} from '@/server/domains/hostname';

// Re-exported so resolver consumers can import the sentinel from one barrel; the
// canonical, dependency-free source is `homeSentinel.ts` (edge-safe for the
// middleware, which must NOT pull this server-only module).
export { HOME_REWRITE_SENTINEL };

/** A published page row: the MST page id, its slug, and the full page snapshot. */
export interface PublishedPageRow {
  pageId: string;
  slug: string;
  snapshot: PageSnapshotOut;
}

/** A resolved published site: the analytics binding (server-side refs only) plus
 *  every page snapshot, ready to hydrate per request. */
export interface PublishedSite {
  siteId: string;
  workspaceId: string;
  tenantGroupId: string;
  name: string;
  analyticsProjectId: string | null;
  ingestionEndpoint: string | null;
  /** A SERVER-SIDE ref (Infisical path / pointer), NEVER the literal key. */
  apiKeyRef: string | null;
  lumitraEnabled: boolean;
  pages: PublishedPageRow[];
}

/**
 * Parse the subdomain label out of a request Host header.
 *
 * - `baseHost` (default `process.env.PUBLIC_SITE_BASE_HOST`): when set, the host
 *   must end with `.<baseHost>` and the subdomain is the leftmost label of the
 *   remainder (e.g. base `lumitra.site`, host `demo.lumitra.site` -> `demo`).
 * - Unconfigured: the subdomain is the first label, but ONLY when the host has
 *   at least three labels (`sub.domain.tld`), so a bare apex (`example.com`) or
 *   `localhost` resolves to null rather than mis-claiming the first label.
 *
 * `www` is treated as "no subdomain" (null). The port is stripped. A host with
 * no usable subdomain returns null (the route 404s).
 *
 * The label must also have the SHAPE of a DNS label (`RFC1035_LABEL`, the same
 * contract the publish-time allocator in `subdomain.ts` generates against): a
 * malformed label (an underscore, a leading or trailing hyphen, over 63 chars)
 * can never be an allocated subdomain, so it returns null here, before any
 * cache or database work. The reserved-name list is deliberately NOT applied:
 * it is an allocation rule, and an operator-seeded site may legitimately live
 * on a reserved label (the hosted demo runs as `app`).
 */
export function parseSubdomain(
  host: string | null | undefined,
  baseHost: string | null | undefined = process.env.PUBLIC_SITE_BASE_HOST,
): string | null {
  if (!host) return null;
  // Strip a port and lowercase. IPv6 hosts are not a storefront target.
  const hostname = host.split(':')[0].trim().toLowerCase();
  if (!hostname) return null;

  const base = baseHost?.trim().toLowerCase();
  if (base) {
    if (hostname === base) return null;
    const suffix = `.${base}`;
    if (!hostname.endsWith(suffix)) return null;
    const remainder = hostname.slice(0, -suffix.length);
    if (!remainder) return null;
    return usableLabel(remainder.split('.')[0]);
  }

  const labels = hostname.split('.');
  if (labels.length < 3) return null;
  return usableLabel(labels[0]);
}

/** A parsed label is usable when it is present, not `www`, and DNS-label shaped. */
function usableLabel(label: string | undefined): string | null {
  if (!label || label === 'www') return null;
  if (!RFC1035_LABEL.test(label)) return null;
  return label;
}

/** One way a request host can name a site (see the file header). */
export type SiteHostKey =
  | { kind: 'subdomain'; value: string }
  | { kind: 'custom'; value: string };

/** The custom-domain statuses that serve a site (DNS ownership proven). */
export const SERVING_DOMAIN_STATUSES = ['verified', 'active'] as const;

/**
 * The lookup keys for a request Host, in the order they are tried.
 *
 * - With a base host (production): a host under it is a SUBDOMAIN (and only
 *   that); any other host is a CUSTOM hostname when it passes the custom-domain
 *   contract (which also excludes every platform zone), else nothing.
 * - Without a base host (local development, tests): a valid custom hostname is
 *   tried first, then the legacy first-label subdomain parse, so the
 *   unconfigured behaviour of `parseSubdomain` is unchanged.
 *
 * A host that yields no key resolves to null without any database work.
 */
export function hostLookupKeys(
  host: string | null | undefined,
  baseHost: string | null | undefined = process.env.PUBLIC_SITE_BASE_HOST,
): SiteHostKey[] {
  const hostname = normalizeRequestHost(host);
  if (!hostname) return [];
  const zones = platformZones();
  const base = baseHost?.trim().toLowerCase().replace(/\.$/, '');
  if (base) {
    if (hostname === base || hostname.endsWith(`.${base}`)) {
      // The label is parsed from the RAW host, exactly as before custom domains
      // existed: a non-ASCII label is refused, not converted to punycode, since
      // the allocator only ever hands out [a-z0-9] labels.
      const label = parseSubdomain(host, base);
      return label ? [{ kind: 'subdomain', value: label }] : [];
    }
    return isClaimableHostname(hostname, [...zones, base])
      ? [{ kind: 'custom', value: hostname }]
      : [];
  }
  const keys: SiteHostKey[] = [];
  if (isClaimableHostname(hostname, zones)) keys.push({ kind: 'custom', value: hostname });
  const label = parseSubdomain(host, null);
  if (label) keys.push({ kind: 'subdomain', value: label });
  return keys;
}

/** The site id a lookup key names, or null (custom: only a serving claim). */
async function siteIdForKey(key: SiteHostKey, prisma: PrismaClient): Promise<string | null> {
  if (key.kind === 'subdomain') {
    const domain = await prisma.siteDomain.findUnique({
      where: { subdomain: key.value },
      select: { siteId: true },
    });
    return domain?.siteId ?? null;
  }
  const domain = await prisma.siteDomain.findUnique({
    where: { customHostname: key.value },
    select: { siteId: true, verificationStatus: true },
  });
  if (!domain) return null;
  return (SERVING_DOMAIN_STATUSES as readonly string[]).includes(domain.verificationStatus)
    ? domain.siteId
    : null;
}

/**
 * Resolve the published site one lookup key names. Null when the key maps to no
 * (serving) SiteDomain or the site is not `published`.
 */
export async function resolvePublishedSiteByKey(
  key: SiteHostKey,
  prisma: PrismaClient = getPrismaClient(),
): Promise<PublishedSite | null> {
  const siteId = await siteIdForKey(key, prisma);
  if (!siteId) return null;

  const site = await prisma.site.findFirst({
    where: { id: siteId, status: 'published' },
    select: {
      id: true,
      workspaceId: true,
      tenantGroupId: true,
      name: true,
      analyticsProjectId: true,
      ingestionEndpoint: true,
      apiKeyRef: true,
      lumitraEnabled: true,
      pages: { select: { pageId: true, slug: true, snapshot: true } },
    },
  });
  if (!site) return null;

  return {
    siteId: site.id,
    workspaceId: site.workspaceId,
    tenantGroupId: site.tenantGroupId,
    name: site.name,
    analyticsProjectId: site.analyticsProjectId,
    ingestionEndpoint: site.ingestionEndpoint,
    apiKeyRef: site.apiKeyRef,
    lumitraEnabled: site.lumitraEnabled,
    pages: site.pages.map((p) => ({
      pageId: p.pageId,
      slug: p.slug,
      snapshot: p.snapshot as unknown as PageSnapshotOut,
    })),
  };
}

/**
 * Resolve the published site for a request Host: each lookup key in order
 * (hostLookupKeys), the first published site wins. Returns null when the host
 * yields no key, no key maps to a serving SiteDomain, or the site is not
 * `published` (draft / archived / missing). A public, anonymous read.
 */
export async function resolvePublishedSite(
  host: string | null | undefined,
  prisma: PrismaClient = getPrismaClient(),
  baseHost?: string | null,
): Promise<PublishedSite | null> {
  const keys = hostLookupKeys(host, baseHost === undefined ? process.env.PUBLIC_SITE_BASE_HOST : baseHost);
  for (const key of keys) {
    const site = await resolvePublishedSiteByKey(key, prisma);
    if (site) return site;
  }
  return null;
}

/** A page matched against a request path, with any dynamic params captured. */
export interface MatchedPage {
  page: PublishedPageRow;
  /** Captured dynamic segments, e.g. `{ handle: 'classic-tee' }` / `{ id: '42' }`. */
  params: Record<string, string>;
}

/** Strip leading/trailing slashes and split a slug into non-empty segments. */
function slugSegments(slug: string): string[] {
  return slug.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
}

/** A dynamic slug segment names a param via `:name` or `[name]`; returns the
 *  param name, or null for a static segment. */
function dynamicParamName(segment: string): string | null {
  if (segment.startsWith(':')) return segment.slice(1) || null;
  if (segment.startsWith('[') && segment.endsWith(']')) return segment.slice(1, -1) || null;
  return null;
}

/** Try to match one page's slug pattern against the request segments. Returns the
 *  captured params, or null when the pattern does not match. */
function matchOne(pattern: string[], request: string[]): Record<string, string> | null {
  if (pattern.length !== request.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const name = dynamicParamName(pattern[i]);
    if (name) {
      params[name] = request[i];
    } else if (pattern[i].toLowerCase() !== request[i].toLowerCase()) {
      return null;
    }
  }
  return params;
}

/**
 * Match the request slug (the catch-all segments) to a page. Empty segments
 * resolve the HOME page (a page whose slug is empty / `/` / `index` / `home`).
 * EXACT (static) matches win over dynamic (`:param`) matches, so a literal
 * `/products/sale` page beats a `/products/:handle` page. Returns null when no
 * page matches (the route 404s).
 */
export function matchPageBySlug(
  pages: PublishedPageRow[],
  requestSegments: string[],
): MatchedPage | null {
  const request = requestSegments.map((s) => s.trim()).filter((s) => s.length > 0);

  // Home: an empty request path OR the reserved home sentinel (the middleware
  // rewrites a published-site root `/` to `/<sentinel>`) resolves a page whose
  // slug is empty or a home alias. The sentinel resolves HOME, never a page
  // literally slugged `__home`.
  if (request.length === 1 && request[0] === HOME_REWRITE_SENTINEL) {
    request.length = 0;
  }

  if (request.length === 0) {
    const home = pages.find((p) => {
      const segs = slugSegments(p.slug);
      return segs.length === 0 || segs.join('/') === 'index' || segs.join('/') === 'home';
    });
    return home ? { page: home, params: {} } : null;
  }

  // Pass 1: exact static match (no dynamic segments).
  for (const page of pages) {
    const pattern = slugSegments(page.slug);
    if (pattern.some((seg) => dynamicParamName(seg) !== null)) continue;
    const params = matchOne(pattern, request);
    if (params) return { page, params };
  }

  // Pass 2: dynamic match (captures :param / [param]).
  for (const page of pages) {
    const pattern = slugSegments(page.slug);
    if (!pattern.some((seg) => dynamicParamName(seg) !== null)) continue;
    const params = matchOne(pattern, request);
    if (params) return { page, params };
  }

  return null;
}

/**
 * Resolve the PUBLIC `ap_live_` ingestion key from the snapshot's server-side
 * `apiKeyRef`. The literal key is resolved server-side, off the artifact: the
 * ref itself is NEVER returned or embedded.
 *
 * For the demo this reads the key from the deploy env (the ref names an env var,
 * else a single shared `ANALYTICS_PUBLIC_INGESTION_KEY`). The production
 * resolution (Infisical lookup by ref) is wired by the infra task (#7); this is
 * the seam it slots into. Returns null when no key is configured, so analytics
 * simply does not inject rather than failing the page.
 */
export function resolvePublicIngestionKey(apiKeyRef: string | null): string | null {
  if (apiKeyRef && process.env[apiKeyRef]) return process.env[apiKeyRef] ?? null;
  return process.env.ANALYTICS_PUBLIC_INGESTION_KEY ?? null;
}

/**
 * Resolve the analytics tracker LOADER script URL. This is the `<script async
 * src>` that actually READS `window.__AP_CONFIG` and emits events; without it the
 * snippet only publishes the config and the site emits nothing. It is a platform
 * constant (one tracker build for all sites), so it comes from the deploy env,
 * not the per-site row. Returns null when unset, so the snippet degrades to
 * config-only rather than emitting a broken `<script src>`.
 */
export function resolveTrackerScriptSrc(): string | null {
  return process.env.ANALYTICS_TRACKER_SCRIPT_URL ?? null;
}

/**
 * Resolve the ingestion endpoint: the per-site value when set, else the deploy
 * env fallback (`ANALYTICS_INGESTION_ENDPOINT`). The env fallback lets the single
 * demo site be configured without hand-editing its row. Returns null when neither
 * is set, so injection (gated on a non-null endpoint) simply does not happen.
 */
export function resolveIngestionEndpoint(siteEndpoint: string | null): string | null {
  return siteEndpoint ?? process.env.ANALYTICS_INGESTION_ENDPOINT ?? null;
}

/**
 * Resolve the analytics project id: the per-site value when set, else the deploy
 * env fallback (`ANALYTICS_PROJECT_ID`). Optional in the snippet; null is fine.
 */
export function resolveAnalyticsProjectId(siteProjectId: string | null): string | null {
  return siteProjectId ?? process.env.ANALYTICS_PROJECT_ID ?? null;
}
