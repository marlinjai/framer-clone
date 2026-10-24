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

import React from 'react';
import type { Metadata } from 'next';
import { getPrimaryHostForRequest, resolveSiteForRequest } from '@/server/sites/requestSite';
import { effectiveSiteName } from '@/lib/site/siteSettings';
import { siteLayoutMetadata } from '@/lib/site/publishedHead';
import { SYSTEM_FONT_STACK } from '@/lib/fonts/registry';

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

export default function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      {/* The root layout puts the editor's Geist on <html> (Tailwind preflight).
          A published page that sets no font family of its own falls back to the
          system stack instead, never to a face the editor chrome happens to use.
          Constant text from the font registry, never site data. */}
      <style data-fc-site-base="" dangerouslySetInnerHTML={{ __html: `body{font-family:${SYSTEM_FONT_STACK}}` }} />
      {children}
    </>
  );
}
