import 'server-only';

// src/server/sites/requestSite.ts
//
// The published site of the CURRENT request, shared by everything that renders
// a published page in one request: the root layout (`<html lang>`), the (site)
// layout's metadata, the page route, its metadata, the 404 page, and the
// robots / sitemap / manifest / favicon routes.
//
//   - React `cache()` dedupes within one request, so the layouts, the page and
//     its metadata share ONE resolution.
//   - getCachedPublishedSite caches across requests (tagged per host, revalidated
//     on publish), so this costs no database read on a warm host.
//   - The editor host resolves to null without a database read: it is a
//     platform host, so hostLookupKeys yields no lookup key for it. (No
//     isEditorHost short-circuit here: with EDITOR_HOST unset, in development
//     and tests, every host counts as the editor host, and published pages on
//     `<label>.localhost` must still resolve.)

import { cache } from 'react';
import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import { getPrismaClient } from '@/server/db';
import { normalizeRequestHost } from '@/server/domains/hostname';
import { DEFAULT_LANGUAGE } from '@/lib/site/siteSettings';
import { getCachedPublishedSite } from './cachedResolver';
import { loadSitePrimaryHost } from './primaryHost';
import type { PublishedSite } from './publicResolver';

/** The raw Host header of the current request. */
export const getRequestHost = cache(async (): Promise<string | null> => {
  return (await headers()).get('host');
});

/** The published site the request's host names, or null (editor host, unknown, draft). */
export const resolveSiteForRequest = cache(async (): Promise<PublishedSite | null> => {
  return getCachedPublishedSite(await getRequestHost());
});

/**
 * The primary host of the request's site (src/server/sites/primaryHost.ts),
 * falling back to the request's own host. Null without a site.
 */
export const getPrimaryHostForRequest = cache(async (): Promise<string | null> => {
  const site = await resolveSiteForRequest();
  if (!site) return null;
  const requestHost = normalizeRequestHost(await getRequestHost());
  return loadSitePrimaryHost(getPrismaClient(), site.siteId, requestHost);
});

/**
 * The `<html lang>` of the request: the published site's language, else `en`
 * (the editor, and any host that names no published site). A failed lookup
 * never takes the page down: the language falls back, the error is logged.
 */
export async function getRequestLanguage(): Promise<string> {
  try {
    const site = await resolveSiteForRequest();
    return site?.siteSettings.language ?? DEFAULT_LANGUAGE;
  } catch (err) {
    // Next's own control flow (the dynamic-rendering bailout) must pass through.
    unstable_rethrow(err);
    console.error('requestSite: could not resolve the site for <html lang>; using the default.', err);
    return DEFAULT_LANGUAGE;
  }
}

/**
 * For route handlers (robots.txt, sitemap.xml, the manifest, the favicon),
 * which read the Host from their Request: the published site of `host` and its
 * primary host, or null when the host names no published site.
 */
export async function resolveSiteAndPrimaryHost(
  host: string | null,
): Promise<{ site: PublishedSite; primaryHost: string | null } | null> {
  const site = await getCachedPublishedSite(host);
  if (!site) return null;
  const primaryHost = await loadSitePrimaryHost(getPrismaClient(), site.siteId, normalizeRequestHost(host));
  return { site, primaryHost };
}
