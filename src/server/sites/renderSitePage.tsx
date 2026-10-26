import 'server-only';

// src/server/sites/renderSitePage.tsx
//
// The server wiring that turns one matched published page into its body:
// analytics binding, per-site CMS and commerce tenancy, the render, and the
// consent banner that gates the analytics tracker. Shared by the page route (`(site)/[...slug]/page.tsx`) and
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
import { siteLookFromPages } from '@/lib/site/notFoundDefault';
import { findLegalPage } from '@/lib/legal/legalPages';
import { productPagePath } from '@/lib/pages/slug';

/** Path of the site's privacy policy page, or null when it has none. */
export function privacyPolicyHref(site: PublishedSite): string | null {
  const page = findLegalPage(
    site.pages.map((p) => ({
      slug: p.slug,
      metadata: (p.snapshot as { metadata?: { legalTemplate?: string } } | undefined)?.metadata ?? null,
    })),
    'privacy',
  );
  return page ? `/${page.slug}` : null;
}

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
  // is a platform constant from the env. With lumitraEnabled + a public key + an
  // endpoint, renderPublishedPage renders the consent banner, which loads the
  // tracker only after the visitor accepts (src/lib/consent/consent.ts).
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
  const { body } = await renderPublishedPage({
    root: adapted.root,
    pageParams: matched.params,
    cmsRepo: getPublishedCmsRepository(site.workspaceId),
    commerceRepo: await commerceRepoForSite(site, adapted.root),
    analytics,
    // The base of `{{product.href}}`: the site's product page, if it has one.
    productPagePath: productPagePath(site.pages.map((p) => p.slug)),
    breakpoints: adapted.breakpoints,
    // Lenis smooth scrolling, the site's setting (off by default; off for
    // visitors who ask for reduced motion, decided in the browser).
    smoothScroll: site.siteSettings.smoothScroll === true,
    // The consent banner (shown only when analytics needs consent) speaks the
    // site language, looks like the home page and links the privacy policy.
    consent: {
      language: site.siteSettings.language,
      look: siteLookFromPages(site.pages),
      privacyHref: privacyPolicyHref(site),
    },
  });

  return (
    <>
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
