// src/lib/books/catalogueGroups.ts
//
// The invoice line picker's headings: the catalogue's items grouped by the site whose shop they belong to (the catalogue
// per project, migration 033; docs/plans/2026-11-27-agent-catalogue-tools.md, slice 2b part 3). After the assignment the
// same product can sit on two shops as two rows with the same title; the heading tells them apart.

/** One site of the company as the picker names it. */
export interface CatalogueSite {
  id: string;
  name: string;
}

/** A heading of the picker and the items under it, in the order they came. */
export interface CatalogueSiteGroup<T> {
  /** The site id, or null for the items without a site. */
  siteId: string | null;
  label: string;
  items: T[];
}

/**
 * One group per site the items name, in the order of the company's sites, then the items without a site. A site the
 * company no longer lists (a project just deleted, its catalogue not yet retired) is still a group, with a plain label,
 * so no item is hidden. The items without a site are "Company items" once the company is assigned to its sites, and
 * "All sites" before (they are on every shop then). The order within a group is the search's (title order).
 */
export function catalogueSiteGroups<T extends { siteId: string | null }>(items: T[], sites: CatalogueSite[], assigned: boolean): CatalogueSiteGroup<T>[] {
  const groups = new Map<string | null, CatalogueSiteGroup<T>>();
  for (const item of items) {
    let g = groups.get(item.siteId);
    if (!g) {
      const label =
        item.siteId === null ? (assigned ? 'Company items' : 'All sites') : (sites.find((s) => s.id === item.siteId)?.name ?? 'A site no longer listed');
      g = { siteId: item.siteId, label, items: [] };
      groups.set(item.siteId, g);
    }
    g.items.push(item);
  }
  const order = new Map(sites.map((s, i) => [s.id, i]));
  const rank = (id: string | null) => (id === null ? sites.length + 1 : (order.get(id) ?? sites.length));
  return [...groups.values()].sort((a, b) => rank(a.siteId) - rank(b.siteId));
}
