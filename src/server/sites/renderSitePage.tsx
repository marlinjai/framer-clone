import 'server-only';

// src/server/sites/renderSitePage.tsx
//
// The server wiring that turns one matched published page into its body:
// analytics binding, per-site CMS and commerce tenancy, the render, the
// analytics snippet. Shared by the page route (`(site)/[...slug]/page.tsx`) and
// the site's designed 404 page (`(site)/not-found.tsx`), so both render a page
// exactly the same way.

import React from 'react';
import {
  resolvePublicIngestionKey,
  resolveTrackerScriptSrc,
  resolveIngestionEndpoint,
  resolveAnalyticsProjectId,
  type PublishedSite,
  type MatchedPage,
} from '@/server/sites/publicResolver';
import { getPublishedCmsRepository } from '@/server/cms';
import { commerceRepoForSite } from '@/server/commerce/storefrontTenant';
import type { AdaptedPage } from '@/lib/renderer/server/snapshotToComponentNode';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import {
  renderPublishedPage,
  type ResolvedAnalytics,
} from '@/lib/renderer/server/renderPublishedPage';
import { jsonLdScriptText } from '@/lib/site/publishedHead';

/** True when `pageId` is the site's designed 404 page. */
export function isNotFoundPage(site: PublishedSite, pageId: string): boolean {
  return site.siteSettings.notFoundPageId !== '' && site.siteSettings.notFoundPageId === pageId;
}

/** The site's designed 404 page row, or null (none chosen, or the page is gone). */
export function findNotFoundPage(site: PublishedSite) {
  const id = site.siteSettings.notFoundPageId;
  if (!id) return null;
  return site.pages.find((p) => p.pageId === id) ?? null;
}

export interface RenderSitePageInput {
  site: PublishedSite;
  matched: MatchedPage;
  /** The adapted page (snapshotToComponentNode); its root must be non-null. */
  adapted: AdaptedPage & { root: ComponentNode };
  /** schema.org data to embed (the home page's business JSON-LD), if any. */
  jsonLd?: Record<string, unknown> | null;
}

export async function renderSitePage({ site, matched, adapted, jsonLd }: RenderSitePageInput): Promise<React.ReactElement> {
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
    breakpoints: adapted.breakpoints,
    // Lenis smooth scrolling, the site's setting (off by default; off for
    // visitors who ask for reduced motion, decided in the browser).
    smoothScroll: site.siteSettings.smoothScroll === true,
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
      {jsonLd ? (
        // schema.org data for search engines; `<` is escaped (jsonLdScriptText).
        <script
          type="application/ld+json"
          data-site-jsonld=""
          dangerouslySetInnerHTML={{ __html: jsonLdScriptText(jsonLd) }}
        />
      ) : null}
      {body}
    </>
  );
}
