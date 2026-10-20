// src/lib/pages/redirects.ts
//
// Old-slug redirects for published sites. When a page of a site that has been
// published changes its slug, the old path keeps working: the published router
// answers it with a permanent redirect (308) to the page's CURRENT path.
//
// Storage: `sites.redirects` (JSON), a list of { from, pageId, createdAt }.
// The target is deliberately a page id, not a path: the router resolves it to
// that page's slug at request time, so renaming a page twice never builds a
// chain (A to B, then B to C leaves A and B both pointing at the page, which
// lives at C), and a loop is impossible by construction (an entry whose `from`
// is a live page's path is dropped: the page wins).
//
// The list is maintained server side by SiteRepository.saveProject, which diffs
// the stored slugs against the incoming ones, and it reaches visitors with the
// next publish (the published-site cache is revalidated on publish). Pure and
// dependency-free so the repository, the router and the tests share it.

import { isDynamicSegment, slugKey } from './slug';

/** The most redirects one site keeps; the oldest are dropped first. */
export const MAX_SITE_REDIRECTS = 100;

export interface SiteRedirect {
  /** The old path, without the leading slash (always a static slug). */
  from: string;
  /** The page the old path now leads to. */
  pageId: string;
  /** When the redirect was recorded (ISO 8601). */
  createdAt: string;
}

/** A page as the redirect logic sees it. */
export interface RedirectPage {
  pageId: string;
  slug: string;
}

/**
 * Read a stored redirects value defensively: anything that is not a list of
 * well-formed entries is ignored rather than trusted, so a hand-edited or
 * corrupted row can never take the published router down.
 */
export function parseSiteRedirects(value: unknown): SiteRedirect[] {
  if (!Array.isArray(value)) return [];
  const out: SiteRedirect[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const { from, pageId, createdAt } = entry as Record<string, unknown>;
    if (typeof from !== 'string' || from.length === 0) continue;
    if (typeof pageId !== 'string' || pageId.length === 0) continue;
    out.push({ from, pageId, createdAt: typeof createdAt === 'string' ? createdAt : '' });
  }
  return out;
}

function isStaticSlug(slug: string): boolean {
  return slug !== '' && !slug.split('/').some(isDynamicSegment);
}

/**
 * The redirect list after a save. `previous` is what the site stores today,
 * `storedSlugs` maps pageId to the slug stored before this save, `pages` is
 * the incoming page set. `everPublished` gates recording: a site that has
 * never been live has no old links to keep.
 *
 * Steps:
 *   1. record a redirect for every page whose static, non-empty slug changed
 *      to a different path, including a page that became the home page
 *      (replacing an older entry for the same `from`);
 *   2. drop entries whose page no longer exists (nothing to send people to);
 *   3. drop entries whose `from` is now some page's own path (the page wins);
 *   4. keep at most MAX_SITE_REDIRECTS, newest last.
 * Steps 2 to 4 run even when nothing new is recorded, so deleting a page or
 * reclaiming an old path always cleans the list.
 */
export function nextSiteRedirects(input: {
  previous: SiteRedirect[];
  storedSlugs: ReadonlyMap<string, string>;
  pages: ReadonlyArray<RedirectPage>;
  everPublished: boolean;
  now: Date;
}): SiteRedirect[] {
  const { storedSlugs, pages, everPublished, now } = input;
  let list = [...input.previous];

  if (everPublished) {
    for (const page of pages) {
      const before = storedSlugs.get(page.pageId);
      if (before === undefined || !isStaticSlug(before)) continue;
      if (slugKey(before) === slugKey(page.slug)) continue;
      const fromKey = slugKey(before);
      list = list.filter((r) => slugKey(r.from) !== fromKey);
      list.push({ from: before, pageId: page.pageId, createdAt: now.toISOString() });
    }
  }

  const livePageIds = new Set(pages.map((p) => p.pageId));
  const livePaths = new Set(pages.filter((p) => p.slug !== '').map((p) => slugKey(p.slug)));
  list = list.filter((r) => livePageIds.has(r.pageId) && !livePaths.has(slugKey(r.from)));

  if (list.length > MAX_SITE_REDIRECTS) list = list.slice(list.length - MAX_SITE_REDIRECTS);
  return list;
}

/**
 * The path a request should be redirected to (with its leading slash), or
 * null. Called by the published router when no static page owns the path.
 * `requestSegments` are the catch-all segments; the target is the redirect's
 * page's current slug, rebuilt from its non-empty segments and percent-encoded
 * per segment, so a stored slug can never turn into a protocol-relative
 * (`//other.host`) or otherwise off-site address. Never redirects to the same
 * path, to a page with a dynamic slug, or from the root.
 */
export function findRedirectTarget(
  redirects: ReadonlyArray<SiteRedirect>,
  pages: ReadonlyArray<RedirectPage>,
  requestSegments: ReadonlyArray<string>,
): string | null {
  const requestKey = slugKey(requestSegments.join('/'));
  if (requestKey === '') return null;
  const entry = redirects.find((r) => slugKey(r.from) === requestKey);
  if (!entry) return null;
  const page = pages.find((p) => p.pageId === entry.pageId);
  if (!page) return null;
  if (page.slug !== '' && !isStaticSlug(page.slug)) return null;
  if (slugKey(page.slug) === requestKey) return null;
  const segments = page.slug.split('/').map((seg) => seg.trim()).filter((seg) => seg.length > 0);
  if (segments.some((seg) => seg === '.' || seg === '..')) return null;
  return '/' + segments.map((seg) => encodeURIComponent(seg)).join('/');
}
