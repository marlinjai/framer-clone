// src/app/projects/catalog/page.tsx
//
// /projects/catalog: the catalogue area of the editor (products, services and
// collections of the active company; docs/plans/2026-10-25-catalogue-design.md).
// The edge middleware already requires a session cookie for every /projects
// path; the authorization (active company with the `sites` grant, viewSite or
// editSite, a provisioned shop database) is enforced by every /api/catalog
// call the client makes, and the client renders a refusal as a page
// (CatalogHome). The address's query (tab, filters, open product) is handed
// down so the first render already shows the right screen.

import React from 'react';

import CatalogHome from './CatalogHome';

export const dynamic = 'force-dynamic';

export default async function CatalogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') query.set(key, first);
  }
  return <CatalogHome initialQuery={query.toString()} />;
}
