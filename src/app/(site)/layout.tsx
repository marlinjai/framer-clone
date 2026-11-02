// Dedicated layout for the PUBLISHED STOREFRONT route group `(site)` (MT-15).
//
// In the Next App Router only the ROOT layout (`src/app/layout.tsx`) may render
// `<html>`/`<body>`, and it wraps every route, so the storefront used to
// inherit the editor's "Create Next App" metadata and the data-table CMS-grid
// CSS. Those are gone from the root layout; this layout owns the storefront's
// own metadata and carries NO editor chrome and NO data-table CSS. The
// published `<html lang>` is set by the root layout from the same site
// (src/server/sites/requestSite.ts, getRequestLanguage).
//
// `generateMetadata` here is the site-wide BASE every published page and the
// 404 page inherit (src/lib/site/publishedHead.ts, siteLayoutMetadata): the
// title template from Site settings, metadataBase on the primary host, the
// favicon set, the web manifest, Open Graph site name and default image, the
// twitter card. A matched page's own `generateMetadata` in
// `(site)/[...slug]/page.tsx` adds its title, canonical and sharing data. A
// host that names no published site gets a neutral default.
//
// The site's theme (src/lib/site/theme.ts, docs/plans/2026-11-02-theme-and-head.md)
// is written here, once, as one sheet on `:root`, right after the base: here and not
// in the page renderer, because the consent banner and the default 404 sit outside
// the page tree and read the same tokens. It stands before the page's own sheet
// (`data-fc-responsive`), at equal specificity, so a page's rule on `:root` beats the
// theme. `generateViewport` gives the browser's own surfaces the chosen mode
// (`color-scheme`) and, when the document has a background, `theme-color`.

import React from 'react';
import type { Metadata, Viewport } from 'next';
import { unstable_rethrow } from 'next/navigation';
import { getPrimaryHostForRequest, resolveSiteForRequest } from '@/server/sites/requestSite';
import { effectiveSiteName } from '@/lib/site/siteSettings';
import { siteLayoutMetadata } from '@/lib/site/publishedHead';
import { SiteSheets, themeViewport } from '@/lib/site/siteSheets';

/** The neutral default for a host with no published site (never editor scaffolding). */
const NEUTRAL_METADATA: Metadata = {
  title: 'Site',
  description: '',
  robots: { index: true, follow: true },
};

export async function generateMetadata(): Promise<Metadata> {
  const site = await resolveSiteForRequest();
  if (!site) return NEUTRAL_METADATA;
  return siteLayoutMetadata({
    settings: site.siteSettings,
    siteName: effectiveSiteName(site.siteSettings, site.name),
    primaryHost: await getPrimaryHostForRequest(),
  });
}

export async function generateViewport(): Promise<Viewport> {
  const site = await siteForLayout();
  return themeViewport(site?.siteSettings.theme);
}

/** The request's site, or null; a failure is logged and the page gets no theme, as the 404 does. */
async function siteForLayout() {
  try {
    return await resolveSiteForRequest();
  } catch (err) {
    unstable_rethrow(err);
    console.error('(site)/layout: could not resolve the site; the page gets no theme sheet.', err);
    return null;
  }
}

export default async function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const site = await siteForLayout();
  return (
    <>
      <SiteSheets theme={site?.siteSettings.theme} />
      {children}
    </>
  );
}
