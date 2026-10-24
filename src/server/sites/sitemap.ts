import 'server-only';

// src/server/sites/sitemap.ts
//
// The values that expand a site's dynamic pages in its sitemap.xml
// (src/lib/site/siteFiles.ts, dynamicPagePlan): published CMS row ids for a
// `:id` RecordView page, product handles for a `:handle` ProductDetail page.
// Read through the same per-site tenancy as the page render: the PUBLISHED CMS
// repository of the site's workspace, the site's commerce tenant (fail closed:
// no tenant, no product URLs). Bounded by SITEMAP_LIMITS.perDynamicPage. A
// failing read leaves that page out and is logged; the sitemap still answers.

import type { PublishedSite } from './publicResolver';
import { getPublishedCmsRepository } from '@/server/cms';
import { commerceRepoForSite } from '@/server/commerce/storefrontTenant';
import type { CmsReadRepository } from '@/server/cms';
import type { CommerceServerRepository, ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import { SITEMAP_LIMITS, dynamicPagePlan, isListablePage } from '@/lib/site/siteFiles';

/** Page size of each read; the per-page cap bounds the total. */
const READ_PAGE = 200;

export interface SitemapRepos {
  cmsRepo: CmsReadRepository;
  /** Resolved lazily, only when a page needs it (most sites have no product pages). */
  commerceRepo: (root: ComponentNode) => Promise<CommerceServerRepository | undefined>;
}

async function listRowIds(repo: CmsReadRepository, collectionId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await repo.listRows(collectionId, { limit: READ_PAGE, ...(cursor ? { cursor } : {}) });
    for (const row of page.rows) {
      if (ids.length >= SITEMAP_LIMITS.perDynamicPage) break;
      ids.push(String(row.id));
    }
    cursor = page.nextCursor;
  } while (cursor && ids.length < SITEMAP_LIMITS.perDynamicPage);
  return ids;
}

async function listHandles(repo: CommerceServerRepository): Promise<string[]> {
  const handles: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await repo.listProducts({ limit: READ_PAGE, ...(cursor ? { cursor } : {}) });
    for (const product of page.products) {
      if (handles.length >= SITEMAP_LIMITS.perDynamicPage) break;
      if (product.handle) handles.push(product.handle);
    }
    cursor = page.nextCursor;
  } while (cursor && handles.length < SITEMAP_LIMITS.perDynamicPage);
  return handles;
}

/** pageId -> the values of its single dynamic segment, for every expandable page. */
export async function loadSitemapExpansions(
  site: PublishedSite,
  repos: SitemapRepos = {
    cmsRepo: getPublishedCmsRepository(site.workspaceId),
    commerceRepo: (root) => commerceRepoForSite(site, root),
  },
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const page of site.pages) {
    if (!isListablePage(page, site.siteSettings)) continue;
    const plan = dynamicPagePlan(page);
    if (!plan) continue;
    try {
      if (plan.kind === 'cms-rows') {
        out.set(page.pageId, await listRowIds(repos.cmsRepo, plan.collectionId));
      } else {
        const root = snapshotToComponentNode(page.snapshot).root;
        const commerce = root ? await repos.commerceRepo(root) : undefined;
        if (commerce) out.set(page.pageId, await listHandles(commerce));
      }
    } catch (err) {
      console.error(`sitemap: could not list the values of dynamic page ${page.slug}; leaving it out.`, err);
    }
  }
  return out;
}
