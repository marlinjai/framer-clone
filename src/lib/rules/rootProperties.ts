// src/lib/rules/rootProperties.ts
//
// What a rule on `:root` may set. A list, because the document holds more than the
// page tree: `display`, `visibility`, `pointerEvents`, `opacity`, `filter`, `transform`
// and `position` would all reach the consent banner. Its own module, because the
// parser (rules.ts) and the emitter behind it (responsiveCss.ts) both read it, and
// responsiveCss.ts cannot import rules.ts as a value.
//
// Whatever ROOT_INHERITED opens, the banner has to pin on its own root, because it
// inherits from `html`: src/lib/consent/ConsentBanner.tsx, and a test walks the list.
//
// PURE: no React, no MST.

/** What the document does as a box and a scroller. An editor surface has neither, so these show nothing there. */
const ROOT_BOX: readonly string[] = [
  'scrollBehavior', 'scrollPadding', 'scrollPaddingTop', 'scrollPaddingRight', 'scrollPaddingBottom', 'scrollPaddingLeft',
  'scrollPaddingBlock', 'scrollPaddingInline', 'scrollSnapType', 'overscrollBehavior', 'overscrollBehaviorX', 'overscrollBehaviorY',
  'overflow', 'overflowX', 'overflowY', 'scrollbarColor', 'scrollbarGutter', 'scrollbarWidth',
  'boxSizing', 'maxWidth', 'minHeight', 'border', 'borderColor',
];

/** What a page takes from the document by inheritance, or paints behind itself. */
export const ROOT_INHERITED: ReadonlySet<string> = new Set([
  'accentColor', 'backgroundColor', 'color', 'colorScheme', 'fontFamily', 'fontFeatureSettings', 'fontSize', 'fontVariationSettings',
  'fontWeight', 'letterSpacing', 'lineHeight', 'MozOsxFontSmoothing', 'tabSize', 'textRendering', 'textSizeAdjust',
  'WebkitFontSmoothing', 'WebkitTapHighlightColor', 'WebkitTextSizeAdjust',
]);

/** Every property a rule may set on the document, beside custom properties. */
export const ROOT_PROPERTIES: ReadonlySet<string> = new Set([...ROOT_BOX, ...ROOT_INHERITED]);

/**
 * The platform's own custom properties. Case-sensitive on the raw key, as custom
 * property names are: `--FC-x` is another property, and a stored key cannot hold an
 * escape. `html` is where the sticky bar's `--fc-sticky-cta-h` is read, and the
 * consent banner is positioned from it, so a stored value would move the banner.
 */
const PLATFORM_VARIABLE = '--fc-';

/** True when a rule on the document may set this key. */
export const isRootStyleKey = (key: string): boolean =>
  key.startsWith('--') ? !key.startsWith(PLATFORM_VARIABLE) : ROOT_PROPERTIES.has(key);

/** What of a document rule an editor surface can show on the page's root node. */
export const showsOnSurface = (key: string): boolean => key.startsWith('--') || ROOT_INHERITED.has(key);
