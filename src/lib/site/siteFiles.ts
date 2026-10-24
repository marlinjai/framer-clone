// src/lib/site/siteFiles.ts
//
// The per-host files of a published site (plan decision 2): robots.txt,
// sitemap.xml and the web manifest. PURE builders plus the rule that decides
// which pages a sitemap lists; the route handlers under src/app supply the
// resolved site and, for dynamic pages, the expanded values
// (src/server/sites/sitemap.ts).
//
// Rules:
//   - robots.txt allows everything and points at the sitemap. It never
//     `Disallow`s a noindex page: a disallowed page is never crawled, so its
//     noindex tag would never be seen and the page could still be listed from
//     links elsewhere. Hiding is the meta tag plus leaving it out of the sitemap.
//   - sitemap.xml lists every published page except noindex pages and the 404
//     page, on the primary host, with lastmod from the page's own updatedAt.
//   - A dynamic page (`/blog/:id`, `/products/:handle`) is expanded only when
//     its data source makes the values knowable (dynamicPagePlan): a
//     RecordView bound to a literal collection id on a page whose only dynamic
//     segment is `:id` (one URL per published row id), or a bound ProductDetail
//     on a page whose only dynamic segment is `:handle` (one URL per product
//     handle). Bounded: at most SITEMAP_LIMITS.perDynamicPage values per page
//     and SITEMAP_LIMITS.total URLs per sitemap. Anything else is left out:
//     a URL a search engine cannot reach is worse than none.

import type { PublishedPageRow } from '@/server/sites/publicResolver';
import { absoluteUrl, pagePath } from './publishedHead';
import { isHttpsUrl, type SiteSettings } from './siteSettings';

export const SITEMAP_LIMITS = {
  perDynamicPage: 1000,
  total: 5000,
} as const;

/** robots.txt for a site on its primary host. */
export function buildRobotsTxt(primaryHost: string | null): string {
  const lines = ['User-agent: *', 'Allow: /'];
  const sitemap = absoluteUrl(primaryHost, '/sitemap.xml');
  if (sitemap) lines.push('', `Sitemap: ${sitemap}`);
  return `${lines.join('\n')}\n`;
}

export interface SitemapEntry {
  loc: string;
  /** ISO 8601 date-time, or undefined when unknown. */
  lastmod?: string;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** sitemap.xml text (sitemaps.org protocol 0.9). */
export function buildSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((e) => {
    const lastmod = e.lastmod ? `<lastmod>${escapeXml(e.lastmod)}</lastmod>` : '';
    return `  <url><loc>${escapeXml(e.loc)}</loc>${lastmod}</url>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/** The web manifest of a site (linked from every page, served per host). */
export function buildWebManifest(settings: SiteSettings, siteName: string): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    name: siteName || 'Site',
    short_name: (siteName || 'Site').slice(0, 12),
    lang: settings.language,
    start_url: '/',
    display: 'browser',
  };
  if (isHttpsUrl(settings.faviconUrl)) {
    manifest.icons = [{ src: settings.faviconUrl, sizes: 'any' }];
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Which pages the sitemap lists
// ---------------------------------------------------------------------------

interface NodeLike {
  props?: Record<string, unknown>;
  bindings?: Record<string, { mode?: unknown; expression?: unknown } | undefined>;
  children?: NodeLike[];
}

function dynamicSegments(slug: string): string[] {
  return slug
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith(':') ? s.slice(1) : s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : null))
    .filter((s): s is string => s !== null);
}

/** How a dynamic page's values can be listed, or null (leave it out). */
export type DynamicPagePlan =
  | { kind: 'cms-rows'; param: 'id'; collectionId: string }
  | { kind: 'commerce-products'; param: 'handle' };

/**
 * The plan for a dynamic page (see the file header), from its first data node
 * in document order. The collection id must be a literal: an expression
 * (`{{...}}`) depends on runtime scope and cannot be listed ahead of time.
 */
export function dynamicPagePlan(page: PublishedPageRow): DynamicPagePlan | null {
  const params = dynamicSegments(page.slug);
  if (params.length !== 1) return null;
  const root = (page.snapshot as { appComponentTree?: NodeLike }).appComponentTree;
  if (!root) return null;
  const stack: NodeLike[] = [root];
  let visited = 0;
  while (stack.length > 0 && visited < 2000) {
    const node = stack.shift()!;
    visited++;
    const kind = node.props?.['data-component-kind'];
    if (kind === 'record-view') {
      const binding = node.bindings?.record;
      const expression = typeof binding?.expression === 'string' ? binding.expression.trim() : '';
      if (params[0] !== 'id' || binding?.mode !== 'read' || !expression || expression.includes('{{')) return null;
      return { kind: 'cms-rows', param: 'id', collectionId: expression };
    }
    if (kind === 'product-detail') {
      const bound = !!node.bindings && Object.keys(node.bindings).length > 0;
      if (params[0] !== 'handle' || !bound) return null;
      return { kind: 'commerce-products', param: 'handle' };
    }
    if (kind === 'collection' || kind === 'product-list') {
      // A list before any detail node: not a detail page, nothing to expand by.
      continue;
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return null;
}

/** The ISO lastmod of a stored page (its snapshot's updatedAt, epoch ms). */
export function pageLastmod(page: PublishedPageRow): string | undefined {
  const updated = (page.snapshot as { updatedAt?: unknown }).updatedAt;
  if (typeof updated === 'number' && Number.isFinite(updated)) return new Date(updated).toISOString();
  if (typeof updated === 'string' && !Number.isNaN(Date.parse(updated))) return new Date(updated).toISOString();
  return undefined;
}

/** True when a page belongs in the sitemap at all (not hidden, not the 404 page). */
export function isListablePage(page: PublishedPageRow, settings: SiteSettings): boolean {
  if (settings.notFoundPageId && page.pageId === settings.notFoundPageId) return false;
  const meta = (page.snapshot as { metadata?: { noIndex?: unknown } }).metadata;
  return meta?.noIndex !== true;
}

/**
 * The sitemap entries for a site: every listable static page, then every
 * listable dynamic page expanded with the values `expansions` supplies for it
 * (keyed by pageId; a page with no entry is left out). Capped at
 * SITEMAP_LIMITS.total, static pages first. Without a primary host there is no
 * absolute URL, so the sitemap is empty.
 */
export function sitemapEntries(
  pages: readonly PublishedPageRow[],
  settings: SiteSettings,
  primaryHost: string | null,
  expansions: ReadonlyMap<string, readonly string[]> = new Map(),
): SitemapEntry[] {
  if (!primaryHost) return [];
  const listable = pages.filter((p) => isListablePage(p, settings));
  const isDynamic = (p: PublishedPageRow) => dynamicSegments(p.slug).length > 0;
  // Home first, then by path, so the output is stable.
  const ordered = [...listable].sort((a, b) => a.slug.localeCompare(b.slug));
  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  const push = (path: string | null, lastmod: string | undefined) => {
    if (!path || entries.length >= SITEMAP_LIMITS.total) return;
    const loc = absoluteUrl(primaryHost, path)!;
    if (seen.has(loc)) return;
    seen.add(loc);
    entries.push({ loc, ...(lastmod ? { lastmod } : {}) });
  };
  for (const page of ordered.filter((p) => !isDynamic(p))) push(pagePath(page.slug), pageLastmod(page));
  for (const page of ordered.filter(isDynamic)) {
    const values = expansions.get(page.pageId);
    const param = dynamicSegments(page.slug)[0];
    if (!values || !param) continue;
    for (const value of values.slice(0, SITEMAP_LIMITS.perDynamicPage)) {
      push(pagePath(page.slug, { [param]: value }), pageLastmod(page));
    }
  }
  return entries;
}
