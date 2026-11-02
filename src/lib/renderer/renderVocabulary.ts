// src/lib/renderer/renderVocabulary.ts
//
// What a stored node may be on a page. Refused by default, like the generator's
// list it builds on (src/lib/ai/pageGen/reviewedVocabulary.ts): this one is wider
// because it also has to carry what owners set in the panel and what forms render,
// and it is the last word, since a snapshot is opaque JSON until it renders. A name
// nobody has judged stays off the page, so a new browser feature cannot act on a
// saved page the day it ships. Refusal lists failed here three times in one day
// (lower-case handlers, SVG animation of links, upper-case HREF).
//
// src/lib/renderer/__tests__/renderVocabulary.test.ts fails when the data the
// primitive score reads gains a name without a decision here.
//
// Before adding a name, ask whether it acts on its own: does it fetch, navigate,
// run, reach another document or change what the browser does with the page? An
// address also needs a rule in ADDRESS_ATTRIBUTES (./blockedNodes.ts).

import {
  REVIEWED_ATTRIBUTES,
  REVIEWED_HTML_TAGS,
  REVIEWED_MATHML_TAGS,
  REVIEWED_SVG_TAGS,
} from '@/lib/ai/pageGen/reviewedVocabulary';

const words = (text: string): string[] => text.trim().split(/\s+/);

/**
 * Tags the generator does not write and a page may hold: form controls, and the
 * inert presentational tags of older markup. Lower case, like every lookup here.
 */
const PAGE_ONLY_TAGS = words(`
  form input select textarea noscript template
  acronym big center dir font nobr rb rtc strike tt
`);

/** Lower case: SVG spells `linearGradient`, and a stored tag may come in any case. */
export const RENDERED_TAGS: ReadonlySet<string> = new Set(
  [...REVIEWED_HTML_TAGS, ...REVIEWED_SVG_TAGS, ...REVIEWED_MATHML_TAGS, ...PAGE_ONLY_TAGS].map((tag) => tag.toLowerCase()),
);

/**
 * Attributes the generator leaves to people, and inert ones of older markup.
 * Lower case, in both the markup's and React's spelling.
 */
const PAGE_ONLY_ATTRIBUTES = words(`
  class classname for htmlfor style
  accept accept-charset acceptcharset action autocomplete autofocus capture checked contenteditable
  defaultchecked defaultvalue dirname enctype form formaction formenctype formmethod formnovalidate
  formtarget maxlength minlength novalidate pattern placeholder readonly required step
  webkitdirectory wrap
  closedby command commandfor popover popovertarget popovertargetaction
  crossorigin loading referrerpolicy
  color cursor display filter font-family fontfamily height opacity order overflow transform width
  xmlns xmlns:xlink xmlnsxlink xml:lang xmllang xml:space xmlspace
  align axis bgcolor border cellpadding cellspacing char charoff clear face frame hspace noshade
  nowrap rules summary valign vspace
  itemid itemprop itemref itemscope itemtype list
  about property resource typeof vocab
  instance
  columnalign columnlines columnspacing mathbackground mathcolor mathsize rowalign rowlines rowspacing
  children key ref suppresscontenteditablewarning suppresshydrationwarning
`);

/** Lower case. `data-*` and `aria-*` are a pattern, see isRenderedAttribute. */
export const RENDERED_ATTRIBUTES: ReadonlySet<string> = new Set([...REVIEWED_ATTRIBUTES, ...PAGE_ONLY_ATTRIBUTES]);

/**
 * Attributes judged and refused, by what they would do. Refused by default means a
 * name here and a name nobody has seen are treated alike, except that the hyphenated
 * ones have to be named: see AUTHOR_ATTRIBUTE. `prefix` is here because Element has
 * a read-only property of that name, which stops React on a custom element.
 */
export const REFUSED_RENDER_ATTRIBUTES: ReadonlySet<string> = new Set(words(`
  srcdoc is nonce prefix
  ping attributionsrc attributionsourceid browsingtopics interestfor
  shadowrootclonable shadowrootcustomelementregistry shadowrootdelegatesfocus shadowrootmode
  shadowrootreferencetarget shadowrootserializable shadowrootslotassignment
  http-equiv manifest manifestid xml:base xmlbase
  allow allowfullscreen allowpaymentrequest credentialless csp privatetoken sandbox scrolling
  frameborder marginheight marginwidth
  archive classid codebase codetype data declare standby valuetype
  as async blocking charset content defer imagesizes imagesrcset integrity nomodule
  background link longdesc nohref notation rev scheme alink vlink actiontype
  bottommargin leftmargin rightmargin topmargin
  cross-origin-top-navigation-by-user-activation hreftranslate
  autolocate behavior compact denomalign drawable font-width framespacing glyph-orientation-horizontal
  glyph-orientation-vertical baseprofile clip moz-opaque noresize numalign scrollamount scrolldelay
  selection stagemode subscriptshift superscriptshift svgview switch text truespeed version watch zoomandpan
`));

/**
 * The renderers' own attributes: the consent runtime acts on these, so none comes
 * from a node. A name, not `data-fc-*`, for two reasons. applyBehaviour writes its
 * marks through this gate and drops stored ones itself (isIssuedAttribute), and an
 * author's own name that merely starts alike is kept. renderVocabulary.test.ts fails
 * when the code starts using a `data-fc-` name that is neither here nor issued. The
 * bare `data-fc-sticky-cta` passes: hoistStickyCta writes it, and it only pins a bar.
 * `data-fc-theme` and its `-mode` and `-sheet` forms belong to the theme sheet
 * (src/lib/site/theme.ts): a stored node carrying `data-fc-theme="frame"` would take
 * the page background on a surface, and one carrying the mode would show the other mode.
 */
const RENDERER_ATTRIBUTE = /^data-fc-(?:consent|sticky-cta-|site-base|page-base|fonts|effects|rules|responsive|behaviour|theme|b$)/;

/** A custom element's shape. A colon would let createElementNS read `x-y:script` as `script`. */
const CUSTOM_ELEMENT = /^[a-z][a-z0-9._]*-[a-z0-9._-]*$/;

const DATA_OR_ARIA = /^(?:data|aria)-[a-z0-9._:-]+$/;

/**
 * The one deliberate exception to refusing by default, and so a refusal list:
 * a page author's own attribute, `my-attribute`, which the panel offers. With no
 * script on a page nothing reads it, and React never treats such a name as a property
 * of a custom element, which is what makes other unknown names unsafe. A future
 * browser attribute with a hyphen would pass until the data lists it, and then
 * renderVocabulary.test.ts asks for a decision.
 */
const AUTHOR_ATTRIBUTE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

/**
 * Names a renderer reads or writes itself. Markup ignores case, so `ACTION` beside the
 * `action` a live form writes is a second spelling of one attribute, and the first
 * wins in server markup. Every check here compares in lower case, and stored names
 * stay as written, because SVG's are not (`viewBox`), but code that reads `props.action`
 * would not see `ACTION`. So these have one spelling, or React's, and no other.
 */
const ONE_SPELLING = new Set(words(`
  action children class classname data-component-kind data-form-id data-form-kind disabled enctype
  form formaction formenctype formmethod formnovalidate formtarget href id key method name novalidate
  ref rel style target type
`));
const REACT_SPELLINGS = new Set(words('className encType formAction formEncType formMethod formNoValidate formTarget noValidate'));

/** Whether this spelling of a name is one no renderer would recognise as that name. */
export function isOtherSpelling(name: string): boolean {
  const lower = name.toLowerCase();
  return name !== lower && ONE_SPELLING.has(lower) && !REACT_SPELLINGS.has(name);
}

/** Whether a page may hold this tag, in any case. */
export function isRenderedTag(tag: string): boolean {
  const name = tag.toLowerCase();
  // `#TEXT` lower-cases into nothing a browser can create.
  if (name.startsWith('#')) return false;
  return RENDERED_TAGS.has(name) || CUSTOM_ELEMENT.test(name);
}

/** Whether a page may hold an attribute of this lower-case name. The value has its own rules. */
export function isRenderedAttribute(name: string): boolean {
  if (RENDERER_ATTRIBUTE.test(name)) return false;
  if (RENDERED_ATTRIBUTES.has(name) || DATA_OR_ARIA.test(name)) return true;
  return AUTHOR_ATTRIBUTE.test(name) && !REFUSED_RENDER_ATTRIBUTES.has(name);
}
