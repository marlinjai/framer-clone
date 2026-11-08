// src/lib/site/sitePath.ts
//
// A link to a path of the site (`/contact`) on a surface of the editor: the preview and
// the canvas in Interact never navigate the app there. They read the path off the click
// and switch the editor to the page it names, or to the product page with that product.
//
// PURE: no React, no MST.

import { PRODUCT_PARAM_SEGMENT } from '@/lib/pages/slug';

/** The site path a click lands on (`/contact` from `<a href="/contact#x">`), or null for anchors and outside links. */
export function sitePathOfClick(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const href = target.closest('a[href]')?.getAttribute('href') ?? '';
  if (!href.startsWith('/') || href.startsWith('//')) return null;
  return href.split(/[?#]/)[0];
}

/** What a site needs to answer a path: its pages' slugs and its product page path. */
export interface SitePages {
  pagesArray: readonly { id: string; slug: string }[];
  productPagePath: string | null;
}

/**
 * Where a site path goes in the editor: a page, or the product page with the product it
 * shows, whose handle is undefined for a malformed link (the page then shows the first).
 */
export type SitePathTarget = { pageId: string; product: false } | { pageId: string; product: true; handle: string | undefined };

/** The handle in a product link, or undefined for a malformed one (the page then shows the first product). */
function productHandleFrom(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The page a path of the site names, or null when the site has none there. */
export function pageForSitePath(site: SitePages, path: string): SitePathTarget | null {
  const slug = path.replace(/^\/+|\/+$/g, '').toLowerCase();
  const page = site.pagesArray.find((p) => p.slug.toLowerCase() === slug);
  if (page) return { pageId: page.id, product: false };
  const productPath = site.productPagePath;
  const productPage = productPath ? site.pagesArray.find((p) => p.slug === `${productPath.slice(1)}/${PRODUCT_PARAM_SEGMENT}`) : undefined;
  if (productPath && productPage && path.toLowerCase().startsWith(`${productPath}/`)) {
    return { pageId: productPage.id, product: true, handle: productHandleFrom(path.slice(productPath.length + 1)) };
  }
  return null;
}
