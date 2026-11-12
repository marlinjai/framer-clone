import 'server-only';

// src/server/sites/renderSitePage.tsx
//
// The server wiring that turns one matched published page into its body:
// analytics binding, per-site CMS and commerce tenancy, the render, and the
// consent banner that gates the analytics tracker. Shared by the page route (`(site)/[...slug]/page.tsx`) and
// the site's designed 404 page (`(site)/not-found.tsx`), so both render a page
// exactly the same way.

import { previewSafeTree } from '@/lib/renderer/server/previewSafe';
import type { PreviewOf } from '@/lib/sites/previewHost';
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
import { findLegalPage, legalLanguage } from '@/lib/legal/legalPages';
import { productPagePath } from '@/lib/pages/slug';
import { treesHoldMapEmbed } from '@/lib/mapEmbed/mapEmbed';

type TreeLike = Parameters<typeof treesHoldMapEmbed>[0] extends Iterable<infer T> ? T : never;

/**
 * Whether any page or reusable component of the site embeds a Google Map. Read from
 * the stored trees: a definition holding one counts even where it is not placed, so
 * the answer can only err towards offering withdrawal.
 */
export function siteHoldsMap(site: PublishedSite): boolean {
  const trees = [
    ...site.pages.map((p) => (p.snapshot as { appComponentTree?: TreeLike } | undefined)?.appComponentTree),
    ...Object.values(site.components ?? {}).map((d) => (d.page as { appComponentTree?: TreeLike } | undefined)?.appComponentTree),
  ];
  return treesHoldMapEmbed(trees);
}

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

/** What a form and the checkout say on a branch's public preview instead of sending anything, in English. */
export const PREVIEW_UNAVAILABLE = 'This is a preview: nothing is sent or ordered from it.';

/**
 * The words a preview adds to a page, in the site's language as the consent banner picks it (German for a
 * German site, English for every other): the band, and what a form and the checkout say instead of sending.
 * The visitor is the site owner's client, who reads the site in its language.
 */
const PREVIEW_COPY = {
  en: {
    unavailable: PREVIEW_UNAVAILABLE,
    locale: 'en-GB',
    band: (branch: string, until: string) =>
      `Preview of the branch “${branch}”. This is not the live site: forms and checkout are switched off. The link works until ${until} UTC.`,
  },
  de: {
    unavailable: 'Dies ist eine Vorschau: Von hier wird nichts gesendet und nichts bestellt.',
    locale: 'de-DE',
    band: (branch: string, until: string) =>
      `Vorschau des Entwurfs „${branch}“. Dies ist nicht die veröffentlichte Website: Formulare und Kasse sind abgeschaltet. Der Link gilt bis ${until} UTC.`,
  },
} as const;

/** What a form and the checkout say on a preview, in the site's language. */
export function previewUnavailableText(language: string): string {
  return PREVIEW_COPY[legalLanguage(language)].unavailable;
}

const BAND_STYLE: React.CSSProperties = {
  padding: '8px 16px',
  background: '#111111',
  color: '#ffffff',
  font: '500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif',
  textAlign: 'center',
  boxSizing: 'border-box',
};

/**
 * The band every page of a branch's public preview carries (site branches, slice S8): it says that this is not
 * the live site, which branch it shows and until when the link works. Plain markup with its own inline styles,
 * outside the page's design, so no page style can hide what the visitor is looking at.
 *
 * It sits at the bottom edge of the window, not the top: a site's own header is very often fixed or sticky at
 * the top, and a band there lay over it. So that it never covers the end of the page either, the same text is
 * laid out once more, unseen, after the page: exactly as tall as the band at every width, however it wraps.
 */
export function PreviewBand({ preview, language = 'en' }: { preview: PreviewOf; language?: string }): React.ReactElement {
  const copy = PREVIEW_COPY[legalLanguage(language)];
  const until = new Intl.DateTimeFormat(copy.locale, { dateStyle: 'long', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(preview.expiresAt));
  const text = copy.band(preview.branchName, until);
  return (
    <>
      <div aria-hidden="true" data-fc-preview-band-space="" style={{ ...BAND_STYLE, visibility: 'hidden' }}>
        {text}
      </div>
      <div role="note" data-fc-preview-band="" style={{ ...BAND_STYLE, position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 2147483000 }}>
        {text}
      </div>
    </>
  );
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
  // A preview sends nothing and tells no other site its address: stored attributes and map frames that would
  // are taken out before anything reads the tree (src/lib/renderer/server/previewSafe.ts).
  const root = site.preview ? previewSafeTree(adapted.root) : adapted.root;
  const { body } = await renderPublishedPage({
    root,
    budget: adapted.budget,
    pageParams: matched.params,
    cmsRepo: getPublishedCmsRepository(site.workspaceId),
    commerceRepo: await commerceRepoForSite(site, root),
    analytics,
    unavailable: site.preview ? previewUnavailableText(site.siteSettings.language) : null,
    // The base of `{{product.href}}`: the site's product page, if it has one.
    productPagePath: productPagePath(site.pages.map((p) => p.slug)),
    breakpoints: adapted.breakpoints,
    // Lenis smooth scrolling, the site's setting (off by default; off for
    // visitors who ask for reduced motion, decided in the browser).
    smoothScroll: site.siteSettings.smoothScroll === true,
    pageBase: site.siteSettings.pageBase,
    // The site's theme: a forced light or dark mode answers `prefers-color-scheme` in
    // the page's rules, and the banner reads token references through it.
    theme: site.siteSettings.theme,
    // The consent banner (shown only when analytics needs consent) speaks the
    // site language, looks like the home page and links the privacy policy.
    consent: {
      language: site.siteSettings.language,
      look: siteLookFromPages(site),
      privacyHref: privacyPolicyHref(site),
      // No map loads on a preview, so nothing there asks for maps consent.
      siteHasMap: site.preview ? false : siteHoldsMap(site),
    },
  });

  return (
    <>
      {jsonLd && !site.preview ? (
        // schema.org data for search engines; `<` is escaped (jsonLdScriptText).
        <script
          type="application/ld+json"
          data-site-jsonld=""
          dangerouslySetInnerHTML={{ __html: jsonLdScriptText(jsonLd) }}
        />
      ) : null}
      {body}
      {site.preview ? <PreviewBand preview={site.preview} language={site.siteSettings.language} /> : null}
    </>
  );
}
