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

/**
 * Resolve the published site for a request Host, cached cross-request and keyed
 * by the host's subdomain (tagged `site:<subdomain>`).
 *
 * The subdomain is parsed up front: a host with no usable subdomain is NOT
 * cacheable (it 404s) and returns null immediately, so a shared "null" entry is
 * never written. The cache KEY is the subdomain, so two hosts -> two entries and
 * cross-tenant bleed is impossible.
 *
 * The Prisma client is constructed INSIDE the cached callback (via
 * `resolvePublishedSite`'s default) — never captured as a closure arg — so the
 * cache stores only plain serializable data (the resolved `PublishedSite`).
 */
export async function getCachedPublishedSite(
  host: string | null | undefined,
): Promise<PublishedSite | null> {
  const subdomain = parseSubdomain(host);
  if (!subdomain) return null;

  const load = unstable_cache(
    // No closure-captured Prisma client: resolvePublishedSite constructs it
    // itself. `host` is captured for parsing only; the cache KEY is the
    // subdomain in keyParts, and one subdomain maps to exactly one host.
    async (): Promise<PublishedSite | null> => resolvePublishedSite(host),
    ['published-site', subdomain],
    { tags: [siteCacheTag(subdomain)] },
  );
  return load();
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
 * unpublish (with the looked-up subdomain) after the write commits.
 */
export function revalidateSiteCache(subdomain: string): void {
  revalidateTag(siteCacheTag(subdomain));
}
