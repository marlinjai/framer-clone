// The PUBLIC storefront route: SSR-on-request render of a published page.
//
// Resolves the site from the request Host (NOT a middleware rewrite: the P1
// middleware is an auth gate whose matcher leaves public render paths open),
// loads the matched page snapshot, hydrates CMS + commerce data LIVE per
// request via `hydrateBindings`, renders the primitive tree server-side, and
// emits the four interactive commerce kinds as client islands. SEO/OG come from
// the page metadata; the analytics snippet is injected when the Lumitra binding
// is enabled.
//
// Render mode is SSR-on-request (force-dynamic): the snapshot is loaded and
// hydrated on every request so CMS + commerce are always fresh. A missing site
// OR missing page -> notFound() (404); a malformed snapshot (no app tree) -> 404.
// Errors surface loudly, never a blank 200.
//
// This is a REQUIRED catch-all (`[...slug]`, NOT optional `[[...slug]]`): an
// optional catch-all would also match `/` and collide with the existing root
// `app/page.tsx` (the editor) -> a Next "two parallel pages resolve to /" build
// error. A required catch-all needs >=1 segment, so `/` stays the editor and the
// storefront serves every published page at its slug (`/about`,
// `/products/classic-tee`, ...). `(site)` is a route group (no URL segment), so
// the specific routes (`/`, `/preview`, `/api/*`) keep precedence. Serving the
// storefront HOME at the host root (`/`) is handled by host-aware root routing in
// `src/middleware.ts`: on a non-editor host it rewrites `/` to the reserved
// `HOME_REWRITE_SENTINEL` segment, which reaches THIS route as
// `params.slug = ['__home']` and `matchPageBySlug` resolves as the home request.

import React, { cache } from 'react';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import {
  matchPageBySlug,
  resolvePublicIngestionKey,
  resolveTrackerScriptSrc,
  resolveIngestionEndpoint,
  resolveAnalyticsProjectId,
  type PublishedSite,
  type MatchedPage,
} from '@/server/sites/publicResolver';
import { getCachedPublishedSite } from '@/server/sites/cachedResolver';
import { getCmsRepository } from '@/server/cms';
import { getCommerceServerRepository } from '@/server/commerce/repository/read';
import { resolveCommerceSchemaForSite } from '@/server/commerce/tenant';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import {
  renderPublishedPage,
  pageSeoToMetadata,
  type ResolvedAnalytics,
} from '@/lib/renderer/server/renderPublishedPage';

// SSR-on-request: never statically cached, always hydrated fresh. Node runtime
// (Prisma is server-only and not edge-safe).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SitePageProps {
  params: Promise<{ slug?: string[] }>;
}

/**
 * Resolve the published site for the current request Host. Two layers of
 * caching, complementary:
 *   - React `cache()` dedupes within ONE request so `generateMetadata` and the
 *     page body share a single resolution call.
 *   - `getCachedPublishedSite` (MT-17) caches CROSS-request, keyed by the host's
 *     subdomain and tagged `site:<subdomain>`, so the O(pages) DB read happens
 *     once per publish instead of on every storefront hit. Publish/unpublish
 *     invalidate that tag.
 */
const resolveSiteForRequest = cache(async (): Promise<PublishedSite | null> => {
  const host = (await headers()).get('host');
  return getCachedPublishedSite(host);
});

/** Match the published site + the requested slug to a single page (with params). */
function resolvePage(
  site: PublishedSite | null,
  slug: string[] | undefined,
): MatchedPage | null {
  if (!site) return null;
  return matchPageBySlug(site.pages, slug ?? []);
}

export async function generateMetadata({ params }: SitePageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await resolveSiteForRequest();
  const matched = resolvePage(site, slug);
  if (!matched) return {};
  const adapted = snapshotToComponentNode(matched.page.snapshot);
  return pageSeoToMetadata(adapted.metadata);
}

export default async function SitePage({ params }: SitePageProps) {
  const { slug } = await params;
  const site = await resolveSiteForRequest();
  const matched = resolvePage(site, slug);
  // A missing site OR no matching page -> 404 (never a blank 200).
  if (!site || !matched) notFound();

  const adapted = snapshotToComponentNode(matched.page.snapshot);
  // A published page with no app component tree is malformed -> 404.
  if (!adapted.root) notFound();

  // Analytics: resolve the PUBLIC ingestion key + endpoint + project + the
  // tracker loader URL server-side. The key comes from the server-side apiKeyRef
  // (the ref literal never reaches the artifact); the endpoint/project fall back
  // to the deploy env so the single demo site is env-configurable; the loader URL
  // is a platform constant from the env. Injection is gated on lumitraEnabled +
  // a public key + an endpoint inside renderPublishedPage. The loader is what
  // actually makes the page EMIT events (config alone does nothing).
  const analytics: ResolvedAnalytics = {
    enabled: site.lumitraEnabled,
    ingestionKey: resolvePublicIngestionKey(site.apiKeyRef),
    ingestionEndpoint: resolveIngestionEndpoint(site.ingestionEndpoint),
    projectId: resolveAnalyticsProjectId(site.analyticsProjectId),
    trackerScriptSrc: resolveTrackerScriptSrc(),
  };

  // Per-site tenancy (MT-13): BOTH engines must isolate by the RESOLVED site,
  // never a module constant. The two engines use DIFFERENT mechanisms, so each
  // carries its own value off the one Site row:
  //   - CMS isolates by a `workspace_id` COLUMN -> pass `site.workspaceId` so
  //     `listCollections`/reads see ONLY this site's workspace. Without this, N
  //     published sites on the wildcard would all render ONE global workspace's
  //     CMS collections (a hard cross-tenant isolation bug).
  //   - Commerce isolates by Postgres SCHEMA (`SET LOCAL search_path`) -> pass a
  //     schema DERIVED FROM THE SITE. Until MT-18 this maps every site to the
  //     single shared `commerce` schema (see resolveCommerceSchemaForSite):
  //     multi-tenant commerce is blocked to one tenant, but CMS-only sites are
  //     fully isolated and may ship now.
  const { body, headSnippet } = await renderPublishedPage({
    root: adapted.root,
    pageParams: matched.params,
    cmsRepo: getCmsRepository(site.workspaceId),
    commerceRepo: getCommerceServerRepository(
      undefined,
      resolveCommerceSchemaForSite(site),
    ),
    analytics,
  });

  return (
    <>
      {headSnippet ? (
        // SSR-emitted inline script: present in the server HTML, so it executes
        // on initial load (publishes window.__AP_CONFIG / __AP_VARIANTS, then the
        // tracker loader). Only the PUBLIC ap_live_ key is ever embedded.
        <div
          data-analytics-tracker
          style={{ display: 'none' }}
          dangerouslySetInnerHTML={{ __html: headSnippet }}
        />
      ) : null}
      {body}
    </>
  );
}
