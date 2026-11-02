// src/lib/site/pageBase.ts
//
// What elements look like on a site before anyone styles them, the Site settings
// field `pageBase`. The site sheet (src/app/(site)/site.css) ships Tailwind's reset
// and the base layer to every published route, so a site cannot be left out of
// them. Two bases come out of that:
//
//   - `reset`, every site's default: the reset stands. Headings, lists, margins and
//     form controls start bare, and a page shows only what its nodes set.
//   - `browser`: the page sheet takes the reset back out. This is what a page written
//     as plain HTML and CSS expects, and it cannot be reached from the nodes: what the
//     reset changes includes `tab-size` and the border style of every borderless
//     element, which nobody would write on a node. It is also the base for a page
//     that brings its own reset, such as a Tailwind site's: its reset is already on
//     its nodes, and ours would add what it leaves alone (the `antialiased` body,
//     the padding of `<option>`). No third value is needed for that: measured on the
//     BusBasis pages (test/score/busbasis.score.ts), this base leaves nothing behind.
//
// `revert-layer` inside the `base` layer rolls an element back past that layer and
// keeps everything around it. `revert` would not do: it also drops what the markup
// says through presentational hints, so an SVG `fill` or an `<img width>` would go.
// Utilities sit in a later layer and the page's own sheet is unlayered, so both stay.
// The `:not(#\#)` matches every element and lifts the rule above each selector in the
// layer. It needs a browser with `revert-layer`: Chrome 99, Firefox 97, Safari 15.4.
//
// One thing cannot be taken back: `[hidden]{display:none!important}` in the reset
// outranks anything here, so `hidden` hides a node that also sets a `display`, where
// a plain browser would show it.
//
// PURE and client-safe: the published page, the editor surfaces and the score share
// these two functions, so a test never compares against a copy of the text.

import { SYSTEM_FONT_STACK } from '@/lib/fonts/registry';

export const PAGE_BASES = ['reset', 'browser'] as const;
export type PageBase = (typeof PAGE_BASES)[number];

export const DEFAULT_PAGE_BASE: PageBase = 'reset';

/** Matches every element, with the specificity of an id. */
const ANY_ELEMENT = ':not(#\\#)';

/**
 * Every pseudo-element the reset styles: `*` does not reach them.
 * src/app/__tests__/publishedBase.test.ts compares this with the built sheet.
 */
export const RESET_PSEUDO_ELEMENTS = [
  '::before',
  '::after',
  '::backdrop',
  '::file-selector-button',
  '::placeholder',
  '::-webkit-search-decoration',
  '::-webkit-date-and-time-value',
  '::-webkit-datetime-edit',
  '::-webkit-datetime-edit-fields-wrapper',
  '::-webkit-datetime-edit-year-field',
  '::-webkit-datetime-edit-month-field',
  '::-webkit-datetime-edit-day-field',
  '::-webkit-datetime-edit-hour-field',
  '::-webkit-datetime-edit-minute-field',
  '::-webkit-datetime-edit-second-field',
  '::-webkit-datetime-edit-millisecond-field',
  '::-webkit-datetime-edit-meridiem-field',
  '::-webkit-calendar-picker-indicator',
  '::-webkit-inner-spin-button',
  '::-webkit-outer-spin-button',
] as const;

/** One rule each: a browser that refuses one name would throw away a whole selector list. */
function layerRolledBack(element: string): string {
  const rules = [element, ...RESET_PSEUDO_ELEMENTS.map((pseudo) => `${element}${pseudo}`)];
  return rules.map((selector) => `${selector}{all:revert-layer}`).join('');
}

/**
 * The published page's sheet for a base. `body` is the document shell, which no node
 * can style: its margin stays at zero as on every other published page, because a
 * frame fills the window, and `antialiased` on the root layout's body is a utility,
 * so it is set back here.
 */
export function pageBaseSheet(base: PageBase): string {
  if (base !== 'browser') return '';
  return `@layer base{${layerRolledBack(ANY_ELEMENT)}}body{margin:0;-webkit-font-smoothing:auto;-moz-osx-font-smoothing:auto}`;
}

/** What a page inherits from the document on the published page and from the editor around a frame here. */
const DOCUMENT_INHERITED = [
  'color:CanvasText',
  `font-family:${SYSTEM_FONT_STACK}`,
  'line-height:normal',
  'tab-size:8',
  'font-feature-settings:normal',
  'font-variation-settings:normal',
  '-webkit-text-size-adjust:auto',
  'text-size-adjust:auto',
  '-webkit-tap-highlight-color:initial',
  '-webkit-font-smoothing:auto',
  '-moz-osx-font-smoothing:auto',
].join(';');

/**
 * The same base on an editor surface, which shares its document with the editor: only
 * what sits inside `roots`, the frames a page shows in, or the editor would lose its
 * own reset. A root is the editor's element, so it stays, and hands down what the
 * document hands down on a published page.
 */
export function surfacePageBaseSheet(base: PageBase, roots: readonly string[]): string {
  if (base !== 'browser' || roots.length === 0) return '';
  const inside = roots.map((root) => layerRolledBack(`${root} ${ANY_ELEMENT}`)).join('');
  return `@layer base{${inside}}${roots.join(',')}{${DOCUMENT_INHERITED}}`;
}
