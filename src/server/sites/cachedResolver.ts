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
//
// CUSTOM DOMAINS (plan 2026-06-25-framer-custom-domains) follow exactly the same
// rules under their own namespace: the cache key and tag carry the full
// normalized hostname (`site-host:<hostname>`), and a remembered miss is stored
// under `host:<hostname>` (a subdomain label can never contain a colon, so the
// two namespaces cannot collide). Verifying, losing or disconnecting a domain
// calls revalidateCustomHostCache, and publish/unpublish revalidate every host
// of the site (revalidateCustomHostsForSiteId), so a custom domain never keeps
// serving an unpublished site from cache. Which keys a host yields, and in which
// order, is decided by `hostLookupKeys` in publicResolver.ts.

import { unstable_cache, revalidateTag } from 'next/cache';
import { getPrismaClient } from '@/server/db';
import {
  hostLookupKeys,
  resolvePublishedSiteByKey,
  type PublishedSite,
  type SiteHostKey,
} from './publicResolver';

/**
 * The cache tag for a site's cached resolution. Publish/unpublish call
 * {@link revalidateSiteCache} with the same subdomain to invalidate it.
 */
export function siteCacheTag(subdomain: string): string {
  return `site:${subdomain}`;
}

/** The cache tag for a custom hostname's cached resolution. */
export function customHostCacheTag(hostname: string): string {
  return `site-host:${hostname}`;
}

/** The miss-map / in-flight key of a lookup key (subdomains keep the bare label). */
function stateKey(key: SiteHostKey): string {
  return key.kind === 'subdomain' ? key.value : `host:${key.value}`;
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
 * Thrown inside the cached callback when the key resolves to no published
 * site, so `unstable_cache` stores nothing. Module-private: only this file
 * throws it and only this file catches it.
 */
class SiteMiss extends Error {
  constructor(key: string) {
    super(`no published site for ${key}`);
    this.name = 'SiteMiss';
  }
}

/**
 * Resolve the published site for a request Host, cached cross-request and keyed
 * by the host's lookup key: a subdomain label (tagged `site:<subdomain>`) or a
 * custom hostname (tagged `site-host:<hostname>`).
 *
 * The keys are computed (and shape-checked) up front: a host with no usable key
 * returns null immediately, touching neither the cache nor the database. A
 * resolved site is cached until its tag is revalidated; a miss is never written
 * to `unstable_cache`, only remembered in the bounded in-process negative cache
 * for NEGATIVE_CACHE_TTL_MS (see the file header). The cache KEY is the label or
 * hostname, so two hosts -> two entries and cross-tenant bleed is impossible.
 *
 * The Prisma client is constructed INSIDE the cached callback (via
 * `resolvePublishedSiteByKey`'s default), never captured as a closure arg, so
 * the cache stores only plain serializable data (the resolved `PublishedSite`).
 */
export async function getCachedPublishedSite(
  host: string | null | undefined,
): Promise<PublishedSite | null> {
  for (const key of hostLookupKeys(host)) {
    const site = await getCachedSiteForKey(key);
    if (site) return site;
  }
  return null;
}

/** The cached, coalesced, miss-remembering resolution of one lookup key. */
function getCachedSiteForKey(key: SiteHostKey): Promise<PublishedSite | null> {
  const id = stateKey(key);
  if (isRememberedMiss(id, Date.now())) return Promise.resolve(null);

  const { inFlight } = resolverState();
  const pending = inFlight.get(id);
  if (pending) return pending;

  const resolution = loadSite(key);
  inFlight.set(id, resolution);
  // Settle bookkeeping runs before any caller's continuation (registered first).
  // Both steps check that the entry is still OURS: a publish (or a domain
  // verification) that revalidated the key mid-lookup dropped it, and a stale
  // miss must then not be remembered (it would mask the fresh state for the TTL).
  const settle = (site: PublishedSite | null | undefined) => {
    if (inFlight.get(id) !== resolution) return;
    inFlight.delete(id);
    if (site === null) rememberMiss(id, Date.now());
  };
  resolution.then(settle, () => settle(undefined));
  return resolution;
}

/** One cached resolution for a key; a miss resolves to null and is never cached. */
async function loadSite(key: SiteHostKey): Promise<PublishedSite | null> {
  const load = unstable_cache(
    // No closure-captured Prisma client: resolvePublishedSiteByKey constructs it
    // itself. The cache KEY is the label or hostname in keyParts.
    async (): Promise<PublishedSite> => {
      const site = await resolvePublishedSiteByKey(key);
      if (!site) throw new SiteMiss(stateKey(key));
      return site;
    },
    key.kind === 'subdomain'
      ? ['published-site', key.value]
      : ['published-site-host', key.value],
    {
      tags: [
        key.kind === 'subdomain' ? siteCacheTag(key.value) : customHostCacheTag(key.value),
      ],
    },
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

/**
 * Invalidate a custom hostname's cached resolution (hit and remembered miss).
 * Called when a domain is verified (starts serving), loses its claim, or is
 * disconnected, and by revalidateCustomHostsForSiteId on publish/unpublish.
 */
export function revalidateCustomHostCache(hostname: string): void {
  const id = stateKey({ kind: 'custom', value: hostname });
  resolverState().misses.delete(id);
  resolverState().inFlight.delete(id);
  revalidateTag(customHostCacheTag(hostname));
}

/**
 * Invalidate every custom hostname of a site (requested and live claim alike),
 * so publish and unpublish are reflected on the site's custom domains on the
 * very next request, exactly like on its subdomain. Returns the hostnames
 * revalidated (for tests and logs).
 */
export async function revalidateCustomHostsForSiteId(
  siteId: string,
  prisma = getPrismaClient(),
): Promise<string[]> {
  const rows = await prisma.siteDomain.findMany({
    where: { siteId, OR: [{ hostname: { not: null } }, { customHostname: { not: null } }] },
    select: { hostname: true, customHostname: true },
  });
  const hostnames = new Set<string>();
  for (const row of rows) {
    if (row.hostname) hostnames.add(row.hostname);
    if (row.customHostname) hostnames.add(row.customHostname);
  }
  for (const hostname of hostnames) revalidateCustomHostCache(hostname);
  return [...hostnames];
}
