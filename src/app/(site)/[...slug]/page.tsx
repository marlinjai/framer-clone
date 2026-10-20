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
import { notFound, permanentRedirect } from 'next/navigation';
import { findRedirectTarget } from '@/lib/pages/redirects';
import { isDynamicSegment } from '@/lib/pages/slug';

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
import { getPublishedCmsRepository } from '@/server/cms';
import { commerceRepoForSite } from '@/server/commerce/storefrontTenant';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import {
  renderPublishedPage,
  pageSeoToMetadata,
  type ResolvedAnalytics,
} from '@/lib/renderer/server/renderPublishedPage';

// SSR-on-request: never statically cached, always hydrated fresh. Node runtime
// (Prisma is server-only and not edge-safe).
/** True when a page slug has a dynamic (`:param`) segment. */
function hasDynamicSegment(slug: string): boolean {
  return slug.split('/').some(isDynamicSegment);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SitePageProps {
  params: Promise<{ slug?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The query string of the request, rebuilt from Next's parsed search params so
 * an old-slug redirect keeps it (`/old?ref=x` -> `/new?ref=x`). Empty or `?...`.
 * A page component never sees the raw URL, and the edge middleware does not
 * run on storefront paths (its matcher is the editor plane plus `/`), so the
 * parsed form is the one available: every key and value survives, with
 * repeated keys grouped together and a bare `?flag` written as `flag=`, which
 * every query parser reads the same way.
 */
async function queryStringOf(
  searchParams: SitePageProps['searchParams'],
): Promise<string> {
  const parsed = (await searchParams) ?? {};
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) for (const v of value) query.append(key, v);
    else if (value !== undefined) query.append(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : '';
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

export default async function SitePage({ params, searchParams }: SitePageProps) {
  const { slug } = await params;
  const site = await resolveSiteForRequest();
  const matched = resolvePage(site, slug);
  // A page used to live at this path (its slug changed after the site was
  // published): a permanent redirect (308) to the page's current path,
  // relative so a custom domain stays on its own host. Precedence: a STATIC
  // page that owns the path wins (the save path also drops such redirects),
  // the redirect beats a DYNAMIC page (`/:handle` would otherwise swallow every
  // old path), and only then does a dynamic page or the 404 answer.
  if (site && (!matched || hasDynamicSegment(matched.page.slug))) {
    const target = findRedirectTarget(site.redirects ?? [], site.pages, slug ?? []);
    if (target !== null) permanentRedirect(`${target}${await queryStringOf(searchParams)}`);
  }
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

  // Per-site tenancy: BOTH engines must isolate by the RESOLVED site (resolved
  // from the request HOST, never a session), never a module constant. The two
  // engines use DIFFERENT mechanisms, so each carries its own value off the one
  // Site row:
  //   - CMS isolates by a `workspace_id` COLUMN -> pass `site.workspaceId` so
  //     `listCollections`/reads see ONLY this site's workspace, and through the
  //     PUBLISHED repository so only published, non-archived rows render (the
  //     same rule as the published-site /api/cms reads,
  //     src/server/cms/publishedVisibility.ts).
  //   - Commerce isolates by a Postgres SCHEMA per tenant group (CM-10): the
  //     scoped Kysely handle `commerceTenantDb(resolveTenantGroupForSite(site))`
  //     reaches only this site's `tg_<id>` schema. A site with no valid tenant
  //     group fails CLOSED: `commerceRepoForSite` returns undefined, so the page
  //     still renders its CMS content and every commerce slot renders the
  //     unbound placeholder (no shared-schema fallback, no foreign catalog).
  //     A page with NO bound commerce source never touches the commerce
  //     connection at all; one that has them runs the startup backstop first and
  //     fails loudly on a misconfigured COMMERCE_APP_DATABASE_URL.
  const { body, headSnippet } = await renderPublishedPage({
    root: adapted.root,
    pageParams: matched.params,
    cmsRepo: getPublishedCmsRepository(site.workspaceId),
    commerceRepo: await commerceRepoForSite(site, adapted.root),
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
