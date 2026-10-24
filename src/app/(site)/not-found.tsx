// Storefront 404 for the published `(site)` route group (MT-15, plan
// docs/plans/2026-10-23-published-site-essentials.md decision 3).
//
// Next resolves `notFound()` thrown from `(site)/[...slug]/page.tsx` (an
// unknown host, an unmatched slug, or a visit to the site's 404 page itself)
// to this file, rendered with the status 404 and the (site) layout's metadata
// (Next adds robots noindex to every not-found render). Three cases:
//
//   1. The site has a designed 404 page (Site settings / Page settings, "Use as
//      404 page"): it renders exactly like any published page.
//   2. A known site without one: the default 404 in the site's language, with
//      its name and the look of its home page (src/lib/site/notFoundDefault.ts).
//   3. A host that names no published site: the same default in English.
//
// No editor chrome and no data-table CSS; styles are inline. A failure while
// rendering the designed page falls back to the default, so a broken 404 page
// can never turn a miss into a 500.

import React from 'react';
import { unstable_rethrow } from 'next/navigation';
import { DefaultNotFound } from '@/components/site/DefaultNotFound';
import { resolveSiteForRequest } from '@/server/sites/requestSite';
import { findNotFoundPage, renderSitePage } from '@/server/sites/renderSitePage';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import { effectiveSiteName, DEFAULT_LANGUAGE } from '@/lib/site/siteSettings';
import { DEFAULT_LOOK, siteLookFromPages } from '@/lib/site/notFoundDefault';

export default async function SiteNotFound() {
  let site = null;
  try {
    site = await resolveSiteForRequest();
  } catch (err) {
    unstable_rethrow(err);
    console.error('(site)/not-found: could not resolve the site; serving the generic 404.', err);
  }
  if (!site) {
    return <DefaultNotFound siteName="" language={DEFAULT_LANGUAGE} look={DEFAULT_LOOK} />;
  }

  const designed = findNotFoundPage(site);
  if (designed) {
    const adapted = snapshotToComponentNode(designed.snapshot);
    if (adapted.root) {
      try {
        return await renderSitePage({
          site,
          matched: { page: designed, params: {} },
          adapted: { ...adapted, root: adapted.root },
        });
      } catch (err) {
        unstable_rethrow(err);
        console.error('(site)/not-found: the designed 404 page failed to render; serving the default.', err);
      }
    }
  }

  return (
    <DefaultNotFound
      siteName={effectiveSiteName(site.siteSettings, site.name)}
      language={site.siteSettings.language}
      look={siteLookFromPages(site.pages)}
    />
  );
}
