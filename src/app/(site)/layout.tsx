// Dedicated layout for the PUBLISHED STOREFRONT route group `(site)` (MT-15).
//
// In the Next App Router only the ROOT layout (`src/app/layout.tsx`) may render
// `<html>`/`<body>`, and it wraps every route — so the storefront used to
// inherit the editor's "Create Next App" metadata and the data-table CMS-grid
// CSS. Those are now gone from the root layout; this layout owns the
// storefront's own metadata and carries NO editor chrome and NO data-table CSS.
//
// `generateMetadata` here is the storefront DEFAULT (and the metadata for the
// storefront 404). For a matched page, the per-page `generateMetadata` in
// `(site)/[...slug]/page.tsx` overrides this with the page's own SEO/OG. The
// neutral default below is intentionally generic; per-site title/description can
// be wired from the resolved Site row (host -> `resolvePublishedSite`) later
// without touching the storefront render path.

import React from 'react';
import type { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  return {
    // Neutral storefront default — explicitly NOT the editor's "Create Next App"
    // scaffolding. Per-page metadata overrides this for matched pages.
    title: 'Site',
    description: '',
    robots: { index: true, follow: true },
  };
}

export default function SiteLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <>{children}</>;
}
