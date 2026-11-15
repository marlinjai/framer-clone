// What each allowed head item is for, in the words the Head panel shows next to the picker
// (docs/plans/2026-11-02-theme-and-head.md, slice H3). The lists themselves are the closed
// lists of headItems.ts; a test holds these maps to them, so a name added there without a line
// here fails.

import { META_NAMES, LINK_RELS, PROPERTY_NAMES, PROPERTY_PREFIXES } from './headItems';

export const META_HELP: Readonly<Record<string, string>> = {
  author: 'Who wrote the page.',
  'application-name': 'The name of the site as an app, for browsers that can install it.',
  'apple-mobile-web-app-title': 'The label under the icon when the site is added to an iPhone home screen.',
  'format-detection': 'Stops phones from turning numbers into phone links, for example "telephone=no".',
  rating: 'A content rating such as "general" or "adult", read by some filters.',
  'twitter:site': 'The X (Twitter) account of the site, for sharing cards, written @name.',
  'twitter:creator': 'The X (Twitter) account of the author, for sharing cards, written @name.',
  'geo.region': 'The region the page is about, as a code such as DE-BE.',
  'geo.placename': 'The place the page is about, for example Berlin.',
  'geo.position': 'The coordinates the page is about, written latitude;longitude.',
  'google-site-verification': 'Proves the site is yours to Google Search Console. Paste the code Google gives you.',
  'msvalidate.01': 'Proves the site is yours to Bing Webmaster Tools. Paste the code Bing gives you.',
  'yandex-verification': 'Proves the site is yours to Yandex Webmaster. Paste the code Yandex gives you.',
  'baidu-site-verification': 'Proves the site is yours to Baidu. Paste the code Baidu gives you.',
  'facebook-domain-verification': 'Proves the domain is yours to Meta Business. Paste the code Meta gives you.',
  'p:domain_verify': 'Proves the domain is yours to Pinterest. Paste the code Pinterest gives you.',
  'ahrefs-site-verification': 'Proves the site is yours to Ahrefs. Paste the code Ahrefs gives you.',
};

export const PROPERTY_HELP: Readonly<Record<string, string>> = {
  'article:*': 'Details of an article for sharing: article:tag, article:author, article:section, article:published_time. Set the page\'s content type to Article.',
  'product:*': 'Details of a product for sharing, such as product:price:amount and product:price:currency.',
  'profile:*': 'Details of a person for sharing: profile:first_name, profile:last_name, profile:username.',
  'book:*': 'Details of a book for sharing: book:author, book:isbn, book:tag, book:release_date.',
  'fb:app_id': 'The Facebook app that owns the page, for Facebook insights.',
  'og:locale:alternate': 'Another language the page is also shared in, written like de_DE. Add one item per language.',
  'og:video': 'A video address for sharing previews. Fetched by sharing services, never by the visitor\'s browser.',
  'og:audio': 'An audio address for sharing previews. Fetched by sharing services, never by the visitor\'s browser.',
};

export const REL_HELP: Readonly<Record<string, string>> = {
  alternate: 'The same page in another language (give the language), or its feed (give the feed type).',
  me: 'A profile of yours elsewhere (Mastodon, GitHub). Add one item per profile.',
  author: 'The page of the person who wrote this.',
  license: 'The licence the content is published under.',
  help: 'A page that helps with this one.',
  'privacy-policy': 'The privacy policy that applies to this page.',
  'terms-of-service': 'The terms of service that apply to this page.',
};

/** The row id of a property in the lists above: `article:tag` belongs to `article:*`. */
export function propertyRow(property: string): string {
  if (PROPERTY_NAMES.has(property)) return property;
  const prefix = PROPERTY_PREFIXES.find((p) => property.startsWith(p));
  return prefix ? `${prefix}*` : property;
}

/** Every name the help maps must cover, for the test that keeps them whole. */
export const HELP_KEYS = {
  meta: [...META_NAMES],
  property: [...PROPERTY_PREFIXES.map((p) => `${p}*`), ...PROPERTY_NAMES],
  rel: [...LINK_RELS],
} as const;
