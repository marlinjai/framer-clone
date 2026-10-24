// The PUBLIC storefront route: SSR-on-request render of a published page.
//
// Resolves the site from the request Host (NOT a middleware rewrite: the P1
// middleware is an auth gate whose matcher leaves public render paths open),
// loads the matched page snapshot, hydrates CMS + commerce data LIVE per
// request via `hydrateBindings`, renders the primitive tree server-side, and
// emits the four interactive commerce kinds as client islands. SEO/OG come from
// the page metadata; the analytics snippet is injected when the Lumitra binding
// is enabled.
//
// Render mode is SSR-on-request (force-dynamic): the snapshot is loaded and
// hydrated on every request so CMS + commerce are always fresh. A missing site
// OR missing page -> notFound() (404); a malformed snapshot (no app tree) -> 404.
// Errors surface loudly, never a blank 200.
//
// This is a REQUIRED catch-all (`[...slug]`, NOT optional `[[...slug]]`): an
// optional catch-all would also match `/` and collide with the existing root
// `app/page.tsx` (the editor) -> a Next "two parallel pages resolve to /" build
// error. A required catch-all needs >=1 segment, so `/` stays the editor and the
// storefront serves every published page at its slug (`/about`,
// `/products/classic-tee`, ...). `(site)` is a route group (no URL segment), so
// the specific routes (`/`, `/preview`, `/api/*`) keep precedence. Serving the
// storefront HOME at the host root (`/`) is handled by host-aware root routing in
// `src/middleware.ts`: on a non-editor host it rewrites `/` to the reserved
// `HOME_REWRITE_SENTINEL` segment, which reaches THIS route as
// `params.slug = ['__home']` and `matchPageBySlug` resolves as the home request.

import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { findRedirectTarget } from '@/lib/pages/redirects';
import { isDynamicSegment } from '@/lib/pages/slug';

import {
  matchPageBySlug,
  type PublishedSite,
  type MatchedPage,
} from '@/server/sites/publicResolver';
import { getPrimaryHostForRequest, resolveSiteForRequest } from '@/server/sites/requestSite';
import { isNotFoundPage, renderSitePage } from '@/server/sites/renderSitePage';
import { snapshotToComponentNode } from '@/lib/renderer/server/snapshotToComponentNode';
import { effectiveSiteName } from '@/lib/site/siteSettings';
import { buildBusinessJsonLd, pageMetadata, pagePath } from '@/lib/site/publishedHead';

// SSR-on-request: never statically cached, always hydrated fresh. Node runtime
// (Prisma is server-only and not edge-safe).
/** True when a page slug has a dynamic (`:param`) segment. */
function hasDynamicSegment(slug: string): boolean {
  return slug.split('/').some(isDynamicSegment);
}

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SitePageProps {
  params: Promise<{ slug?: string[] }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The query string of the request, rebuilt from Next's parsed search params so
 * an old-slug redirect keeps it (`/old?ref=x` -> `/new?ref=x`). Empty or `?...`.
 * A page component never sees the raw URL, and the edge middleware does not
 * run on storefront paths (its matcher is the editor plane plus `/`), so the
 * parsed form is the one available: every key and value survives, with
 * repeated keys grouped together and a bare `?flag` written as `flag=`, which
 * every query parser reads the same way.
 */
async function queryStringOf(
  searchParams: SitePageProps['searchParams'],
): Promise<string> {
  const parsed = (await searchParams) ?? {};
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) for (const v of value) query.append(key, v);
    else if (value !== undefined) query.append(key, value);
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

// The site of the request comes from src/server/sites/requestSite.ts: React
// `cache()` per request (generateMetadata, the page body and the layouts share
// one resolution) over getCachedPublishedSite (MT-17, cross-request, tagged
// per host, invalidated on publish/unpublish).

/** Match the published site + the requested slug to a single page (with params). */
function resolvePage(
  site: PublishedSite | null,
  slug: string[] | undefined,
): MatchedPage | null {
  if (!site) return null;
  return matchPageBySlug(site.pages, slug ?? []);
}

export async function generateMetadata({ params }: SitePageProps): Promise<Metadata> {
  const { slug } = await params;
  const site = await resolveSiteForRequest();
  const matched = resolvePage(site, slug);
  if (!site || !matched) return {};
  // The designed 404 page answers its own path with the 404 (see below); its
  // metadata then comes from the (site) layout like every 404.
  if (isNotFoundPage(site, matched.page.pageId)) return {};
  const adapted = snapshotToComponentNode(matched.page.snapshot);
  return pageMetadata({
    page: adapted.metadata,
    settings: site.siteSettings,
    siteName: effectiveSiteName(site.siteSettings, site.name),
    primaryHost: await getPrimaryHostForRequest(),
    path: pagePath(matched.page.slug, matched.params),
  });
}

export default async function SitePage({ params, searchParams }: SitePageProps) {
  const { slug } = await params;
  const site = await resolveSiteForRequest();
  const matched = resolvePage(site, slug);
  // A page used to live at this path (its slug changed after the site was
  // published): a permanent redirect (308) to the page's current path,
  // relative so a custom domain stays on its own host. Precedence: a STATIC
  // page that owns the path wins (the save path also drops such redirects),
  // the redirect beats a DYNAMIC page (`/:handle` would otherwise swallow every
  // old path), and only then does a dynamic page or the 404 answer.
  if (site && (!matched || hasDynamicSegment(matched.page.slug))) {
    const target = findRedirectTarget(site.redirects ?? [], site.pages, slug ?? []);
    if (target !== null) permanentRedirect(`${target}${await queryStringOf(searchParams)}`);
  }
  // A missing site OR no matching page -> 404 (never a blank 200).
  if (!site || !matched) notFound();

  // The site's designed 404 page is never served as a normal page: its own
  // path answers with the 404 status too, rendered by (site)/not-found.tsx.
  if (isNotFoundPage(site, matched.page.pageId)) notFound();

  const adapted = snapshotToComponentNode(matched.page.snapshot);
  // A published page with no app component tree is malformed -> 404.
  if (!adapted.root) notFound();

  // The business data as schema.org JSON-LD, on the home page only: that is
  // where search engines look for the organization behind a site, and one
  // place keeps it from repeating on every page.
  const isHome = matched.page.slug.split('/').filter(Boolean).length === 0;
  const jsonLd = isHome
    ? buildBusinessJsonLd({
        settings: site.siteSettings,
        siteName: effectiveSiteName(site.siteSettings, site.name),
        primaryHost: await getPrimaryHostForRequest(),
      })
    : null;

  return renderSitePage({ site, matched, adapted: { ...adapted, root: adapted.root }, jsonLd });
}
