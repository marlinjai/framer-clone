// Every page type of the BusBasis storefront, one line each. `captured` pages are
// frozen in test/score/corpus/busbasis. A page that cannot be captured stays on the
// list with its reason, because it still counts against "every BusBasis page passes".
//
// `needs` is what the static rebuild cannot show: a page that matches pixel for pixel
// is still not that page while the thing it exists for does not work. Each need fails
// the page, so a known gap is never recorded as a pass. It names the feature, which is
// checked against the code of 2026-11-02 and the Medusa analysis.

import type { GapId } from '../lib/types';

export interface PageNeed {
  id: string;
  gap: GapId;
  reason: string;
}

export interface BusbasisPage {
  slug: string;
  pageType: string;
  path: string;
  needs: PageNeed[];
}

export interface UncapturedPage {
  pageType: string;
  path: string;
  reason: string;
}

const need = (id: string, gap: GapId, reason: string): PageNeed => ({ id, gap, reason });

const MOBILE_MENU = need('mobile menu opens', 'behaviour-state', 'The chrome of every page: the menu is script on the original, and a frozen page cannot open it, so its parity is unmeasured.');
const CART_BADGE = need('cart count and dropdown', 'shop-feature-missing', 'The header shows the live cart count and a dropdown. framer-clone has a cart, but not as a header element on a page.');
const LEGAL_MODALS = need('legal modals open from the footer', 'behaviour-state', 'Impressum and Vereinssatzung exist only as modals opened by script, so their content is not on any frozen page.');
const SHOPPER_ACCOUNTS = need('shopper login', 'shop-feature-missing', 'framer-clone has no shopper accounts (Medusa analysis, plan rank "accounts").');
const CATEGORIES = need('nested categories', 'shop-feature-missing', 'Categories nested four levels. framer-clone has collections and tags only.');
const FACETED_SEARCH = need('faceted search', 'shop-feature-missing', 'Meilisearch with facets, sort and pagination. framer-clone has search only in the admin.');
const LIVE_LIST = need('live product list', 'shop-feature-missing', 'The tree is a frozen copy of the rows. A real page binds them to the catalogue through the product list island, which was not rebuilt here.');

// What the original sets on html is no longer a need: the lift writes it as rules on
// `:root` on the page root, and the score compares the html element of both. Measured
// on 2026-11-02, html matched on all 14 pages at every breakpoint and state.
const CHROME = [MOBILE_MENU, CART_BADGE, LEGAL_MODALS];

export const BUSBASIS_PAGES: BusbasisPage[] = [
  {
    slug: 'home',
    pageType: 'home',
    path: '/de',
    needs: [
      ...CHROME,
      need('contact form sends', 'behaviour-state', 'A form posting to the shop backend. framer-clone has forms, but this one was not wired in the rebuild.'),
      need('map embed', 'blocked-embedded-content', 'The location map is an iframe, which the renderers block on purpose until custom code exists.'),
      need('hero video', 'harness-limit', 'The hero plays a video. The frozen page holds no media, so only its box is compared.'),
    ],
  },
  { slug: 'store', pageType: 'product list', path: '/de/store', needs: [...CHROME, FACETED_SEARCH, CATEGORIES, LIVE_LIST] },
  { slug: 'search', pageType: 'search', path: '/de/store?q=bremse', needs: [...CHROME, FACETED_SEARCH, LIVE_LIST] },
  { slug: 'category', pageType: 'category', path: '/de/categories/mercedes-benz-baumuster-309-310-313-duedos-motor', needs: [...CHROME, CATEGORIES, LIVE_LIST] },
  { slug: 'collection', pageType: 'collection', path: '/de/collections/favoriten', needs: [...CHROME, LIVE_LIST] },
  {
    slug: 'product',
    pageType: 'product detail',
    path: '/de/products/11d3-32',
    needs: [
      ...CHROME,
      need('add to cart', 'shop-feature-missing', 'The product island of framer-clone was not rebuilt to this look, and shipping class rules such as bulky goods and on-request products are not built.'),
      need('image gallery', 'behaviour-state', 'The gallery is script on the original.'),
    ],
  },
  {
    slug: 'cart-empty',
    pageType: 'cart',
    path: '/de/cart',
    needs: [...CHROME, need('cart with items', 'shop-feature-missing', 'Only the empty state is frozen: a filled cart needs a write to the live shop. Free shipping nudge and promo codes are not built.')],
  },
  {
    slug: 'checkout-no-cart',
    pageType: 'checkout',
    path: '/de/checkout',
    needs: [...CHROME, need('checkout steps', 'shop-feature-missing', 'Without a cart the original answers 404, so this freezes that state. Address, shipping options, pickup with cash and the payment methods are not built.')],
  },
  { slug: 'privacy', pageType: 'content: privacy', path: '/de/privacy', needs: CHROME },
  { slug: 'terms', pageType: 'content: terms', path: '/de/terms', needs: CHROME },
  { slug: 'login', pageType: 'account: login', path: '/de/account', needs: [...CHROME, SHOPPER_ACCOUNTS] },
  { slug: 'request-reset', pageType: 'account: password reset', path: '/de/request-reset', needs: [...CHROME, SHOPPER_ACCOUNTS] },
  { slug: 'shop-unavailable', pageType: 'shop kill switch', path: '/de/shop-unavailable', needs: CHROME },
  { slug: 'not-found', pageType: 'not found', path: '/de/search', needs: [] },
];

export const UNCAPTURED_PAGES: UncapturedPage[] = [
  { pageType: 'FAQ', path: 'section on /de', reason: 'Not on the live page: the section renders only when the shop settings enable it, and the capture of 2026-11-02 found none. There is no FAQ page.' },
  { pageType: 'filled cart', path: '/de/cart', reason: 'Needs a cart row written to the live shop, which this slice does not do.' },
  { pageType: 'checkout steps', path: '/de/checkout', reason: 'Needs a cart row written to the live shop, which this slice does not do.' },
  { pageType: 'account dashboard', path: '/de/account (signed in)', reason: 'Needs a shopper login. The account, addresses, orders and profile pages show personal data.' },
  { pageType: 'order pages', path: '/de/order/[id]/confirmed, /de/order/pending', reason: 'Need a real order, and show personal data.' },
  { pageType: 'order transfer', path: '/de/order/[id]/transfer/[token]', reason: 'Need a real order and a token.' },
  { pageType: 'offer accept', path: '/de/offers/[id]/accept', reason: 'Needs a real offer link. Offers have no framer-clone counterpart.' },
  { pageType: 'password reset form', path: '/de/reset-password', reason: 'Needs a token from a reset mail.' },
  { pageType: 'Puck editor', path: '/editor', reason: 'The team\'s editing tool, behind a login: not a storefront page.' },
];
