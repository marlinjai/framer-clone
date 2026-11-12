// src/lib/site/publishedHead.ts
//
// The <head> of a published page, from the Site settings and the page's own
// metadata (plan docs/plans/2026-10-23-published-site-essentials.md, decisions
// 1 to 3). PURE: no Next runtime, no database, so every rule is unit-tested.
//
//   - siteLayoutMetadata: the (site) layout's metadata, the base every page
//     and the 404 page inherit: title template, metadataBase, favicon set, web
//     manifest, Open Graph site name and default image, twitter card.
//   - pageMetadata: one page's metadata. Next merges metadata per top-level key
//     (a page's `openGraph` REPLACES the layout's), so the page result carries
//     the complete Open Graph and twitter objects itself.
//   - buildBusinessJsonLd: schema.org LocalBusiness (or Organization without a
//     complete address) from the business data.
//
// Every image the owner set is re-checked here so a bad value is left out,
// never emitted. An image is an https URL typed by hand or the path of an
// uploaded one (`/site-images/<sha256>.<ext>`, src/lib/site/siteImages.ts):
// icons keep that path relative, so a visitor on any of the site's hosts loads
// the icon from the host they are on; Open Graph, twitter and JSON-LD images
// are made absolute on the primary host, since crawlers need full addresses.

import type { Metadata } from 'next';
import { parseOgType } from './headItems';
import { parseSiteImagePath } from './siteImages';
import {
  WEEKDAYS,
  effectiveTitleTemplate,
  applyTitleTemplate,
  hasAddress,
  isHttpsUrl,
  type SiteSettings,
} from './siteSettings';

/** What the head builders need to know about the site. */
export interface SiteHeadInput {
  settings: SiteSettings;
  /** effectiveSiteName(settings, site.name). */
  siteName: string;
  /** The site's primary host (src/server/sites/primaryHost.ts), or null. */
  primaryHost: string | null;
}

/** The page fields the head uses (PageSeoMetadata from snapshotToComponentNode). */
export interface PageHeadInput {
  title: string;
  description: string;
  keywords: string[];
  ogTitle: string;
  ogDescription: string;
  ogImage: string;
  canonicalUrl: string;
  noIndex: boolean;
  /** The Open Graph content type. Read through parseOgType, so a missing or forged value is `website`. */
  ogType?: string;
}

/** The path of the web manifest route (src/app/site.webmanifest/route.ts). */
export const SITE_MANIFEST_PATH = '/site.webmanifest';

/**
 * An icon address for the head and the manifest: an https URL as typed, an
 * uploaded image's path as it is (relative, served on every host of the site),
 * or undefined for anything else.
 */
export function iconHref(value: string): string | undefined {
  if (isHttpsUrl(value)) return value;
  return parseSiteImagePath(value) ? value : undefined;
}

/** The MIME type of an uploaded icon (`image/png`, `image/x-icon`), or undefined for a typed URL. */
export function iconMimeType(value: string): string | undefined {
  return parseSiteImagePath(value)?.contentType;
}

/**
 * An absolute image address for crawlers (Open Graph, twitter, JSON-LD): an
 * https URL as typed, an uploaded image's path on the primary host, or
 * undefined (anything else, or an upload on a site without a primary host).
 */
export function sharedImageUrl(value: string, primaryHost: string | null): string | undefined {
  if (isHttpsUrl(value)) return value;
  return parseSiteImagePath(value) ? absoluteUrl(primaryHost, value) : undefined;
}

/** https://<host> for a primary host, or undefined. */
export function originOf(primaryHost: string | null): string | undefined {
  return primaryHost ? `https://${primaryHost}` : undefined;
}

/** An absolute URL on the primary host, or undefined without one. */
export function absoluteUrl(primaryHost: string | null, path: string): string | undefined {
  const origin = originOf(primaryHost);
  return origin ? `${origin}${path.startsWith('/') ? path : `/${path}`}` : undefined;
}

function dynamicName(segment: string): string | null {
  if (segment.startsWith(':')) return segment.slice(1) || null;
  if (segment.startsWith('[') && segment.endsWith(']')) return segment.slice(1, -1) || null;
  return null;
}

/**
 * The public path of a page: its slug with `:param` / `[param]` segments filled
 * from the matched params (URL-encoded). The home page (empty slug) is `/`. A
 * dynamic segment without a value returns null (no canonical can be built).
 */
export function pagePath(slug: string, params: Record<string, string> = {}): string | null {
  const segments = slug.split('/').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return '/';
  const out: string[] = [];
  for (const segment of segments) {
    const name = dynamicName(segment);
    if (name) {
      const value = params[name];
      if (!value) return null;
      out.push(encodeURIComponent(value));
    } else {
      out.push(segment);
    }
  }
  return `/${out.join('/')}`;
}

/**
 * The Open Graph locale for a language: `en-GB` -> `en_GB`; a bare language
 * takes the business country when there is one (`de` + DE -> `de_DE`), else
 * none (Open Graph needs a region).
 */
export function ogLocale(settings: SiteSettings): string | undefined {
  const [lang, ...rest] = settings.language.split('-');
  const region = rest.find((p) => /^[A-Z]{2}$/.test(p)) ?? settings.business.country;
  return lang && region ? `${lang}_${region}` : undefined;
}

/** The (site) layout's metadata, inherited by every page and the 404 page. */
export function siteLayoutMetadata(input: SiteHeadInput): Metadata {
  const { settings, siteName, primaryHost } = input;
  const metadata: Metadata = {
    title: siteName
      ? { template: effectiveTitleTemplate(settings, siteName), default: siteName }
      : { template: effectiveTitleTemplate(settings, siteName), default: 'Site' },
    robots: { index: true, follow: true },
    manifest: SITE_MANIFEST_PATH,
  };
  const origin = originOf(primaryHost);
  if (origin) metadata.metadataBase = new URL(origin);
  const icon = iconHref(settings.faviconUrl);
  if (icon) {
    const type = iconMimeType(settings.faviconUrl);
    metadata.icons = {
      icon: [{ url: icon, ...(type ? { type } : {}) }],
      // Apple's home screen icon must be a raster image it can scale: an uploaded ICO is left out.
      ...(type === 'image/x-icon' ? {} : { apple: [{ url: icon }] }),
    };
  }
  const locale = ogLocale(settings);
  const image = sharedImageUrl(settings.ogImageUrl, primaryHost);
  metadata.openGraph = {
    type: 'website',
    ...(siteName ? { siteName } : {}),
    ...(locale ? { locale } : {}),
    ...(image ? { images: [{ url: image }] } : {}),
  };
  metadata.twitter = {
    card: settings.twitterCard,
    ...(image ? { images: [image] } : {}),
  };
  return metadata;
}

export interface PageMetadataInput extends SiteHeadInput {
  page: PageHeadInput;
  /** The page's public path (pagePath), or null when it cannot be built. */
  path: string | null;
  /** True for the site's 404 page (always noindex). */
  isNotFoundPage?: boolean;
}

/**
 * One published page's metadata.
 *
 * - Title: the page title through the layout's template. A page titled like
 *   the site itself (usually the home page), or a page with no title, shows
 *   the site name alone, never "Bakery | Bakery".
 * - Canonical: the page's own canonical URL when set by hand, else the page's
 *   path on the primary host.
 * - Open Graph and twitter: complete objects (they replace the layout's),
 *   with the page image, else the site default image.
 * - robots: noindex for a page hidden from search engines and for the 404 page.
 */
export function pageMetadata(input: PageMetadataInput): Metadata {
  const { page, settings, siteName, primaryHost, path, isNotFoundPage } = input;
  const metadata: Metadata = {};
  const pageTitle = page.title.trim();
  const showsSiteNameOnly = !pageTitle || (siteName !== '' && pageTitle === siteName);
  const template = effectiveTitleTemplate(settings, siteName);
  if (showsSiteNameOnly) {
    if (siteName) metadata.title = { absolute: siteName };
  } else {
    metadata.title = pageTitle;
  }
  const fullTitle = showsSiteNameOnly ? siteName : applyTitleTemplate(template, pageTitle);
  if (page.description) metadata.description = page.description;
  if (page.keywords.length > 0) metadata.keywords = page.keywords;

  const computedUrl = path ? absoluteUrl(primaryHost, path) : undefined;
  const canonical = page.canonicalUrl || computedUrl;
  if (canonical) metadata.alternates = { canonical };

  const image = sharedImageUrl(page.ogImage, primaryHost) ?? sharedImageUrl(settings.ogImageUrl, primaryHost);
  const ogTitle = page.ogTitle || fullTitle;
  const ogDescription = page.ogDescription || page.description;
  const locale = ogLocale(settings);
  metadata.openGraph = {
    type: parseOgType(page.ogType),
    ...(ogTitle ? { title: ogTitle } : {}),
    ...(ogDescription ? { description: ogDescription } : {}),
    ...(canonical ? { url: canonical } : {}),
    ...(siteName ? { siteName } : {}),
    ...(locale ? { locale } : {}),
    ...(image ? { images: [{ url: image }] } : {}),
  };
  metadata.twitter = {
    card: settings.twitterCard,
    ...(ogTitle ? { title: ogTitle } : {}),
    ...(ogDescription ? { description: ogDescription } : {}),
    ...(image ? { images: [image] } : {}),
  };

  if (page.noIndex || isNotFoundPage) {
    metadata.robots = { index: false, follow: true };
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

/** True when the business data says anything beyond the name. */
function hasBusinessData(settings: SiteSettings): boolean {
  const b = settings.business;
  return Boolean(
    b.legalName || b.phone || b.email || b.vatId || hasAddress(b) || b.openingHours.length > 0,
  );
}

/**
 * schema.org data for the business: `LocalBusiness` with a complete address
 * (with opening hours), else `Organization`. Null when there is no business
 * data at all (a bare name says nothing a search engine does not already see).
 * Only valid rows go in: an opening-hours row without days is skipped.
 */
export function buildBusinessJsonLd(input: SiteHeadInput): Record<string, unknown> | null {
  const { settings, siteName, primaryHost } = input;
  if (!hasBusinessData(settings)) return null;
  const b = settings.business;
  const local = hasAddress(b);
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': local ? 'LocalBusiness' : 'Organization',
    name: siteName || b.legalName,
  };
  if (b.legalName) data.legalName = b.legalName;
  const url = absoluteUrl(primaryHost, '/');
  if (url) data.url = url;
  if (b.phone) data.telephone = b.phone;
  if (b.email) data.email = b.email;
  if (b.vatId) data.vatID = b.vatId;
  const image = sharedImageUrl(settings.ogImageUrl, primaryHost);
  if (image) data.image = image;
  const logo = sharedImageUrl(settings.faviconUrl, primaryHost);
  if (logo) data.logo = logo;
  if (local) {
    data.address = {
      '@type': 'PostalAddress',
      streetAddress: b.street,
      postalCode: b.postalCode,
      addressLocality: b.city,
      addressCountry: b.country,
    };
    const hours = b.openingHours
      .filter((row) => row.days.length > 0 && row.opens && row.closes && row.closes > row.opens)
      .map((row) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: WEEKDAYS.filter((d) => row.days.includes(d)),
        opens: row.opens,
        closes: row.closes,
      }));
    if (hours.length > 0) data.openingHoursSpecification = hours;
  }
  if (b.managingDirectors.length > 0) {
    data.employee = b.managingDirectors.map((name) => ({ '@type': 'Person', name, jobTitle: 'Managing Director' }));
  }
  return data;
}

/**
 * The JSON-LD as script text. `<` is escaped so no value can close the
 * script element (`</script>` in a business name stays inert).
 */
export function jsonLdScriptText(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * Metadata for a branch's public preview (site branches, slice S8): never indexed and never followed, with no
 * canonical address, no Open Graph address and no manifest. The address of a preview is a secret that expires;
 * nothing may point a search engine or a sharing card at it, or at the live site as if this were it.
 */
export function previewMetadata(metadata: Metadata): Metadata {
  const { alternates: _alternates, manifest: _manifest, metadataBase: _base, ...rest } = metadata;
  void _alternates;
  void _manifest;
  void _base;
  const openGraph = rest.openGraph ? { ...rest.openGraph } : undefined;
  if (openGraph) delete (openGraph as { url?: unknown }).url;
  return {
    ...rest,
    ...(openGraph ? { openGraph } : {}),
    robots: { index: false, follow: false, noarchive: true },
  };
}
