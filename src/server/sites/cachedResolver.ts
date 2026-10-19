import 'server-only';

// cachedResolver: the ORIGIN page-cache layer for the public storefront (MT-17).
//
// The render route (`(site)/[...slug]`) is `force-dynamic` + React `cache()`,
// which dedupes ONLY within a single request — every cross-request storefront
// hit re-ran the full host -> published-site resolution (an O(pages) Postgres
// read + a full snapshot load). This module wraps that resolution in Next's
// `unstable_cache` so the DB work happens ONCE per publish, then the saved
// resolution is served to every later visitor until the site is re-published.
//
// TENANT SAFETY BY CONSTRUCTION: the cache key includes the request's SUBDOMAIN
// (the globally-unique label that identifies exactly one site). One subdomain ->
// one cache entry -> one tenant's content; a cached entry can NEVER serve another
// tenant. The matching tag `site:<subdomain>` is what publish/unpublish
// invalidate, so a re-publish is reflected on the very next request.
//
// The Cloudflare CDN edge (Wave 5) fronts THIS origin cache; this file is the
// origin layer only.
//
// HITS ONLY, NEVER MISSES (fix of 2026-10-19). Only a resolved site is written to
// `unstable_cache`. A miss (no SiteDomain for the label, or the site is not
// published) used to be cached as `null` with no expiry, so a site that appeared
// WITHOUT the publish route (the demo seed script, an operator script, a restore,
// an import) stayed 404 until the container restarted, and every random label on
// the `*.sites.lumitra.co` wildcard wrote a permanent cache entry. Now:
//
//   - A malformed label is rejected by `parseSubdomain` (DNS-label shape) before
//     any cache or database work.
//   - The cached callback THROWS a private sentinel on a miss; `unstable_cache`
//     only stores a value after the callback resolves, so a miss writes nothing.
//   - Misses are remembered in a small IN-PROCESS negative cache instead: a
//     bounded map (at most NEGATIVE_CACHE_MAX_ENTRIES labels, oldest evicted
//     first) whose entries expire after NEGATIVE_CACHE_TTL_MS. Not
//     `unstable_cache` with a short `revalidate`: self-hosted Next writes those
//     entries to `.next/cache` on disk and a `revalidate` only marks them stale,
//     it never deletes them, so a flood of random labels would still grow the
//     disk without bound.
//
// Load under a flood of random labels: memory is capped by the map size; each
// NEW label costs one lookup on the unique `subdomain` index (plus one primary
// key read when the label exists but is not published); a REPEATED missing label
// costs at most one such lookup per TTL. Rate limiting arbitrary hostnames is
// the Cloudflare edge's job, not this layer's.
//
// OPERATOR SCRIPTS need no secret and no endpoint: a site created out of band
// (seed, restore, import) is served within NEGATIVE_CACHE_TTL_MS of its rows
// landing, because its label was at worst remembered as a miss. The publish and
// unpublish routes stay instant: `revalidateSiteCache` clears both the hit entry
// (by tag) and any remembered miss for the label. A script that CHANGES an
// already-served published site must go through publish/unpublish (the seed
// creates on a fresh database and never changes one).
//
// SHARED PER PROCESS, NOT ACROSS REPLICAS. The miss map and the in-flight map
// live on `globalThis` (like the Prisma client in `src/server/db.ts`), so every
// module instance in one Node process (the publish route and the storefront
// page are bundled separately) sees the same state; with more than one replica,
// each keeps its own, so a publish clears a remembered miss only on the replica
// that served it and the others catch up within NEGATIVE_CACHE_TTL_MS.
//
// CONCURRENT LOOKUPS COALESCE. Requests that arrive together for the same label
// share one in-flight resolution (cleared when it settles), so a burst for one
// unknown label costs one database lookup, not one per request.

import { unstable_cache, revalidateTag } from 'next/cache';
import { getPrismaClient } from '@/server/db';
import {
  resolvePublishedSite,
  parseSubdomain,
  type PublishedSite,
} from './publicResolver';

/**
 * The cache tag for a site's cached resolution. Publish/unpublish call
 * {@link revalidateSiteCache} with the same subdomain to invalidate it.
 */
export function siteCacheTag(subdomain: string): string {
  return `site:${subdomain}`;
}

/** How long a miss is remembered before the database is asked again. */
export const NEGATIVE_CACHE_TTL_MS = 30_000;

/** The most labels remembered as misses at once; the oldest is evicted first. */
export const NEGATIVE_CACHE_MAX_ENTRIES = 1_000;

/**
 * The per-process resolver state, kept on `globalThis` so every module instance
 * in the process shares it (route handlers and pages are separate bundles, and
 * dev HMR re-evaluates modules):
 *   - `misses`: the negative cache, label -> expiry (epoch ms). A Map iterates
 *     in insertion order, so the first key is always the oldest entry, which
 *     makes eviction O(1) without an extra structure.
 *   - `inFlight`: label -> the resolution currently running for it, so
 *     concurrent requests for one label share a single lookup.
 */
interface SiteResolverState {
  misses: Map<string, number>;
  inFlight: Map<string, Promise<PublishedSite | null>>;
}

const globalForSites = globalThis as unknown as {
  __framerCloneSiteResolver?: SiteResolverState;
};

function resolverState(): SiteResolverState {
  if (!globalForSites.__framerCloneSiteResolver) {
    globalForSites.__framerCloneSiteResolver = {
      misses: new Map(),
      inFlight: new Map(),
    };
  }
  return globalForSites.__framerCloneSiteResolver;
}


function isRememberedMiss(subdomain: string, now: number): boolean {
  const missCache = resolverState().misses;
  const expiresAt = missCache.get(subdomain);
  if (expiresAt === undefined) return false;
  if (expiresAt > now) return true;
  missCache.delete(subdomain);
  return false;
}

function rememberMiss(subdomain: string, now: number): void {
  const missCache = resolverState().misses;
  // Re-insert so a refreshed entry moves to the young end of the order.
  missCache.delete(subdomain);
  while (missCache.size >= NEGATIVE_CACHE_MAX_ENTRIES) {
    const oldest = missCache.keys().next().value;
    if (oldest === undefined) break;
    missCache.delete(oldest);
  }
  missCache.set(subdomain, now + NEGATIVE_CACHE_TTL_MS);
}

/** Drop every remembered miss. A test seam; production code never needs it. */
export function clearSiteMissCache(): void {
  resolverState().misses.clear();
  resolverState().inFlight.clear();
}

/** How many labels are currently remembered as misses (for tests and metrics). */
export function siteMissCacheSize(): number {
  return resolverState().misses.size;
}

/**
 * Thrown inside the cached callback when the label resolves to no published
 * site, so `unstable_cache` stores nothing. Module-private: only this file
 * throws it and only this file catches it.
 */
class SiteMiss extends Error {
  constructor(subdomain: string) {
    super(`no published site for subdomain ${subdomain}`);
    this.name = 'SiteMiss';
  }
}

/**
 * Resolve the published site for a request Host, cached cross-request and keyed
 * by the host's subdomain (tagged `site:<subdomain>`).
 *
 * The subdomain is parsed (and shape-checked) up front: a host with no usable
 * subdomain returns null immediately, touching neither the cache nor the
 * database. A resolved site is cached until its tag is revalidated; a miss is
 * never written to `unstable_cache`, only remembered in the bounded in-process
 * negative cache for NEGATIVE_CACHE_TTL_MS (see the file header). The cache KEY
 * is the subdomain, so two hosts -> two entries and cross-tenant bleed is
 * impossible.
 *
 * The Prisma client is constructed INSIDE the cached callback (via
 * `resolvePublishedSite`'s default), never captured as a closure arg, so the
 * cache stores only plain serializable data (the resolved `PublishedSite`).
 */
export async function getCachedPublishedSite(
  host: string | null | undefined,
): Promise<PublishedSite | null> {
  const subdomain = parseSubdomain(host);
  if (!subdomain) return null;
  if (isRememberedMiss(subdomain, Date.now())) return null;

  const { inFlight } = resolverState();
  const pending = inFlight.get(subdomain);
  if (pending) return pending;

  const resolution = loadSite(host, subdomain);
  inFlight.set(subdomain, resolution);
  // Settle bookkeeping runs before any caller's continuation (registered first).
  // Both steps check that the entry is still OURS: a publish that revalidated
  // the label mid-lookup dropped it, and a stale miss must then not be
  // remembered (it would mask the fresh publish for the TTL).
  const settle = (site: PublishedSite | null | undefined) => {
    if (inFlight.get(subdomain) !== resolution) return;
    inFlight.delete(subdomain);
    if (site === null) rememberMiss(subdomain, Date.now());
  };
  resolution.then(settle, () => settle(undefined));
  return resolution;
}

/** One cached resolution for a label; a miss resolves to null and is never cached. */
async function loadSite(
  host: string | null | undefined,
  subdomain: string,
): Promise<PublishedSite | null> {
  const load = unstable_cache(
    // No closure-captured Prisma client: resolvePublishedSite constructs it
    // itself. `host` is captured for parsing only; the cache KEY is the
    // subdomain in keyParts, and one subdomain maps to exactly one host.
    async (): Promise<PublishedSite> => {
      const site = await resolvePublishedSite(host);
      if (!site) throw new SiteMiss(subdomain);
      return site;
    },
    ['published-site', subdomain],
    { tags: [siteCacheTag(subdomain)] },
  );

  try {
    return await load();
  } catch (err) {
    if (!(err instanceof SiteMiss)) throw err;
    return null;
  }
}

/**
 * Look up a site's currently-allocated subdomain by site id. Used by the
 * unpublish route to revalidate the right `site:<subdomain>` tag: the
 * `SiteDomain` row SURVIVES an unpublish (MT-06 decision D3), so the label is
 * still readable after the status flips to draft. Returns null when the site has
 * no allocated subdomain (nothing to invalidate).
 */
export async function resolveSubdomainForSiteId(
  siteId: string,
  prisma = getPrismaClient(),
): Promise<string | null> {
  const domain = await prisma.siteDomain.findFirst({
    where: { siteId, subdomain: { not: null } },
    select: { subdomain: true },
  });
  return domain?.subdomain ?? null;
}

/**
 * Invalidate a site's cached resolution so the NEXT request re-reads from the
 * DB. Called by publish (with the freshly-allocated/idempotent subdomain) and
 * unpublish (with the looked-up subdomain) after the write commits. Clears both
 * the cached hit (by tag) and a remembered miss, so a label that 404'd seconds
 * before its first publish serves the new site immediately.
 */
export function revalidateSiteCache(subdomain: string): void {
  resolverState().misses.delete(subdomain);
  resolverState().inFlight.delete(subdomain);
  revalidateTag(siteCacheTag(subdomain));
}
