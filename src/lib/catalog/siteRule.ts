// src/lib/catalog/siteRule.ts
//
// Whether a product may be in a collection, by the catalogues they belong to (the catalogue per project, migration 033;
// docs/plans/2026-11-27-agent-catalogue-tools.md, slice 2b part 2). Shared by the server's refusals (WRONG_SITE) and the
// editor's pickers, so the editor offers exactly what the server accepts.
//
//   - The same site, or both without one: always.
//   - One without a site, while the company is not yet assigned: also, because a row without a site is still on every site
//     of the company then (src/server/commerce/repository/siteCatalogue.ts). The assignment later places such a membership
//     on the right site (src/server/commerce/provisioning/assignSites.ts).
//   - Anything else (two different sites, or, once assigned, a company item with a site's row): never.

export function sameCatalogue(productSiteId: string | null, collectionSiteId: string | null, companyAssigned: boolean): boolean {
  if (productSiteId === collectionSiteId) return true;
  if (companyAssigned) return false;
  return productSiteId === null || collectionSiteId === null;
}
