// src/lib/ai/pageGen/stockCredit.ts
//
// How a stock photo's attribution is stored on an img node. Client-safe (the
// properties panel uses it too).
//
// The editor's image is a plain <img>, and both renderers (the canvas,
// createComponentElement, and the published site, renderComponentNode) pass
// string props straight through as HTML attributes. So the credit travels as
// plain attributes on the image, with no renderer change:
//
//   title                   "Photo by <name> on Unsplash" (the visible hover credit)
//   data-credit-name        the photographer's name
//   data-credit-url         the photographer's Unsplash profile (with referral utm)
//   data-credit-source-url  unsplash.com (with referral utm)
//
// The Generate dialog also lists every placed photo's credit with real links.
// When the user replaces the image's src, the credit no longer describes it and
// is removed with the same edit (withoutStockCredit).

import type { StockPhotoCredit } from './protocol';

export const STOCK_CREDIT_ATTRS = ['data-credit-name', 'data-credit-url', 'data-credit-source-url'] as const;

/** The img props that carry one photo's credit. */
export function stockCreditProps(credit: StockPhotoCredit): Record<string, string> {
  return {
    title: `Photo by ${credit.photographerName} on Unsplash`,
    'data-credit-name': credit.photographerName,
    'data-credit-url': credit.photographerUrl,
    'data-credit-source-url': credit.unsplashUrl,
  };
}

/** True when the props carry a stock-photo credit. */
export function hasStockCredit(props: Record<string, unknown> | undefined): boolean {
  return !!props && typeof props['data-credit-name'] === 'string';
}

/**
 * The props without the stock-photo credit (the title too, since the credit
 * wrote it). Props without a credit come back unchanged.
 */
export function withoutStockCredit(props: Record<string, unknown>): Record<string, unknown> {
  if (!hasStockCredit(props)) return props;
  const next = { ...props };
  delete next.title;
  for (const key of STOCK_CREDIT_ATTRS) delete next[key];
  return next;
}
