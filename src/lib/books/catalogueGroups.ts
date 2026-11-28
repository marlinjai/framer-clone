// src/lib/books/catalogueGroups.ts
//
// The invoice line picker's headings: the catalogue's items grouped by the site whose shop they belong to (the catalogue
// per project, migration 033; docs/plans/2026-11-27-agent-catalogue-tools.md, slice 2b part 3). After the assignment the
// same product can sit on two shops as two rows with the same title; the heading tells them apart.

/** One site of the company as the picker names it. */
export interface CatalogueSite {
  id: string;
  name: string;
  /** What tells two sites of the same name apart (the published subdomain), when there is one. */
  detail?: string | null;
}

/** A heading of the picker and the items under it, in the order they came. */
export interface CatalogueSiteGroup<T> {
  /** Unique among the groups: the site id, `unlisted` or `none`. */
  key: string;
  /** The site id, or null for the items without a site and for the sites no longer listed. */
  siteId: string | null;
  label: string;
  items: T[];
}

/**
 * One group per site the items name, in the order of the company's sites, then the sites the company no longer lists
 * (a project just deleted, its catalogue not yet retired: one group, "A site no longer listed", so no item is hidden),
 * then the items without a site: "Company items" once the company is assigned to its sites, "All sites" before (they are
 * on every shop then). Two sites of the same name are told apart by their detail. The order within a group is the
 * search's (title order).
 */
export function catalogueSiteGroups<T extends { siteId: string | null }>(items: T[], sites: CatalogueSite[], assigned: boolean): CatalogueSiteGroup<T>[] {
  const byId = new Map(sites.map((s, i) => [s.id, { site: s, rank: i }]));
  const named = (site: CatalogueSite) =>
    site.detail && sites.some((o) => o.id !== site.id && o.name === site.name) ? `${site.name} (${site.detail})` : site.name;
  const groups = new Map<string, CatalogueSiteGroup<T>>();
  const rankOf = new Map<string, number>();
  for (const item of items) {
    const listed = item.siteId === null ? undefined : byId.get(item.siteId);
    const key = item.siteId === null ? 'none' : listed ? item.siteId : 'unlisted';
    let g = groups.get(key);
    if (!g) {
      g =
        key === 'none'
          ? { key, siteId: null, label: assigned ? 'Company items' : 'All sites', items: [] }
          : listed
            ? { key, siteId: listed.site.id, label: named(listed.site), items: [] }
            : { key, siteId: null, label: 'A site no longer listed', items: [] };
      groups.set(key, g);
      rankOf.set(key, key === 'none' ? sites.length + 1 : listed ? listed.rank : sites.length);
    }
    g.items.push(item);
  }
  return [...groups.values()].sort((a, b) => rankOf.get(a.key)! - rankOf.get(b.key)!);
}
