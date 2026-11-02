// src/lib/ai/pageGen/schema.ts
//
// The single source of truth for what the AI page generator may produce. Two
// lists on purpose, so that accepting more never changes what the model is told:
//
//   Accepted (the validator, ./validate.ts, and the review, ../review/ops.ts):
//   what the data the primitive score reads lists (./webVocabulary.ts) AND a person
//   has reviewed (./reviewedVocabulary.ts), so a page the model wrote with a <ul>
//   keeps it, and a name that is new to the data stays out. CSS properties need no
//   review: their values are judged, by the rules of ./validate.ts.
//   Taught (the prompt, ./schemaDocs.ts): the short list below, which the
//   properties panel has controls for, derived from the editor's real code:
//
//   - presets      <- COMPONENT_REGISTRY (src/lib/componentRegistry.ts), the
//                     same entries the Components panel drags onto the canvas
//   - tags         <- the registry's htmlTypes plus the tag sets the properties
//                     panel can edit (CONTAINER_TYPES / TEXT_TYPES in
//                     src/components/sidebars/right/sectionConfig.ts)
//   - style keys   <- CSS_PROP_SET (src/models/ComponentModel.ts), the props
//                     getResolvedProps routes into `style`
//   - void tags    <- isVoidTag (src/lib/drag/voidTags.ts), the rule the drop
//                     resolver and renderer share
//
// A golden test (./__tests__/schemaDocs.test.ts) fails when the registry and the
// docs drift apart, and ./__tests__/webVocabulary.test.ts when the accepted lists
// and the data do.
//
// Client-safe: no server-only imports, so the editor can import the limits and
// the breakpoint-key helper too.

import { COMPONENT_REGISTRY, type ComponentCategory, type DataComponentKind } from '@/lib/componentRegistry';
import { CSS_PROP_SET, type PropsRecord } from '@/models/ComponentModel';
import { isVoidTag } from '@/lib/drag/voidTags';
import { isSafeSrc } from '@/lib/links/safeHref';
import { BLOCKED_TAGS } from '@/lib/renderer/blockedNodes';
import { CONTAINER_TYPES, TEXT_TYPES } from '@/components/sidebars/right/sectionConfig';
import { REVIEWED_ATTRIBUTES, REVIEWED_HTML_TAGS, REVIEWED_MATHML_TAGS, REVIEWED_SVG_TAGS } from './reviewedVocabulary';
import {
  WEB_ELEMENT_ATTRIBUTES,
  WEB_GLOBAL_ATTRIBUTES,
  WEB_MATHML_TAGS,
  WEB_STYLE_KEYS,
  WEB_SVG_TAGS,
  WEB_TAGS,
} from './webVocabulary';

/** Hard per-request budgets. The route and the validator enforce the same numbers. */
export const GENERATION_LIMITS = {
  /** Longest brief the route accepts, in characters. */
  maxBriefChars: 4000,
  /** Most nodes one generation may produce (the whole returned forest). */
  maxNodes: 200,
  /** Deepest nesting allowed, counting a top-level node as depth 1. */
  maxDepth: 10,
  /** Longest text content of one node, in characters (longer is cut, with a warning). */
  maxTextChars: 2000,
  /** Longest value of one attribute, in characters (longer is dropped, with a warning). */
  maxAttributeChars: 300,
  /** The same for SVG geometry (d, points, values): a real icon's path runs to thousands of characters. */
  maxGeometryChars: 8000,
  /** Longest attribute or style key name, in characters. */
  maxNameChars: 64,
  /** Most props, and most style keys, one node keeps. */
  maxPropsPerNode: 100,
  /** Largest model output the validator reads, in characters of its JSON. */
  maxGenerationChars: 1_000_000,
  /**
   * Most SVG elements one svg may become once each `use` and in-page reference is
   * counted at its full size. Five levels of ten `use` take a browser over a
   * second, six freeze it, and the size is in the expansion, not in the nodes.
   */
  maxSvgExpansion: 1000,
  /** Highest z-index, well below the consent banner, so that nothing can cover it. */
  maxZIndex: 100000,
  /**
   * Longest single style value, in characters (longer is dropped, with a
   * warning). Sized for a photo background echoed back in replace / insert
   * context: a scrim gradient plus a sized images.unsplash.com URL.
   */
  maxStyleValueChars: 700,
  /** Longest layer label, in characters. */
  maxLabelChars: 80,
  /** Longest stock-photo search query of one image, in characters. */
  maxImageQueryChars: 80,
  /** Most images one generation resolves to stock photos (the rest keep the placeholder). */
  maxStockImages: 12,
} as const;

/**
 * The prop that asks for a stock photo: a short English search query. On an
 * img it becomes the image's src; on a container (PHOTO_BACKGROUND_TAGS) it
 * becomes the photo layer of the container's backgroundImage, under any
 * gradient (the scrim) the model wrote there. The validator takes it OUT of
 * the props (it never reaches the editor) and the route resolves it to a
 * hotlinked Unsplash photo (./stockImages.ts).
 */
export const IMAGE_QUERY_PROP = 'imageQuery';

/**
 * The attribute a decorative image carries (the model's `decorative: true`
 * becomes alt "" plus this, so the page-essentials screen and the editor's
 * Image section treat the empty alt as intended).
 */
export const DECORATIVE_ATTR = 'data-decorative';

/** Tags that may carry a photo background (imageQuery on a container). */
export const PHOTO_BACKGROUND_TAGS: ReadonlySet<string> = CONTAINER_TYPES;

/** One registry entry as the generator sees it: a named starting point for a node. */
export interface GenerationPreset {
  id: string;
  label: string;
  category: ComponentCategory;
  htmlType: string;
  acceptsChildren: boolean;
  defaultProps: PropsRecord;
  dataComponentKind?: DataComponentKind;
  bindableSlots: string[];
}

/**
 * Every registry entry, sorted by id for deterministic docs and cache-stable prompts. A
 * behaviour preset is left out: its entry stands for nodes a function builds, not for the
 * element it names, and the generator is taught presets in slice B12 of the behaviour model.
 */
export function listGenerationPresets(): GenerationPreset[] {
  return Object.values(COMPONENT_REGISTRY)
    .filter((entry) => !entry.preset)
    .map((entry) => ({
      id: entry.id,
      label: entry.label,
      category: entry.category,
      htmlType: entry.htmlType,
      acceptsChildren: !isVoidTag(entry.htmlType),
      defaultProps: entry.defaultProps,
      ...(entry.dataComponentKind ? { dataComponentKind: entry.dataComponentKind } : {}),
      bindableSlots: Object.keys(entry.bindableSlots ?? {}).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getGenerationPreset(id: string): GenerationPreset | undefined {
  return listGenerationPresets().find((p) => p.id === id);
}

/**
 * The HTML tags the prompt teaches: every tag the registry produces plus every
 * tag the properties panel classifies as a container or text element (so each
 * generated node gets the right property sections when selected). Sorted.
 */
export function listGenerationTags(): string[] {
  const tags = new Set<string>();
  for (const entry of Object.values(COMPONENT_REGISTRY)) tags.add(entry.htmlType);
  for (const t of CONTAINER_TYPES) tags.add(t);
  for (const t of TEXT_TYPES) tags.add(t);
  return [...tags].sort();
}

/** The style keys the prompt teaches: what the editor routes into `style` (CSS_PROP_SET), sorted. */
export function listGenerationStyleKeys(): string[] {
  return [...CSS_PROP_SET].sort();
}

/**
 * The non-style props the prompt teaches, by tag. `children` is the text content
 * and is allowed on every non-void tag. isAcceptedAttribute says what else
 * survives the validator.
 */
export function allowedPropKeysFor(tag: string): string[] {
  const keys: string[] = [];
  if (!isVoidTag(tag)) keys.push('children');
  if (tag === 'img') keys.push('src', 'alt', 'decorative', IMAGE_QUERY_PROP);
  if (PHOTO_BACKGROUND_TAGS.has(tag)) keys.push(IMAGE_QUERY_PROP);
  if (tag === 'a') keys.push('href', 'target');
  return keys;
}

/**
 * Tags that are dropped with their subtree, even if the model insists (with a
 * warning), rather than rewritten to a div:
 *   - what no renderer shows (blockedNodes.ts);
 *   - raw form controls: a form only works through the form presets, a raw one
 *     would lose what a visitor submits;
 *   - template, because its declarative shadow root replaces the parent's content
 *     on a published page and shows nothing on the canvas;
 *   - noscript, whose content only crawlers and visitors without script see, so
 *     the owner cannot review it.
 */
export const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  ...BLOCKED_TAGS, 'form', 'input', 'textarea', 'select', 'template', 'noscript',
]);

/**
 * The tags the prompt names as off limits. Written out, not derived: a tag added to
 * the blocked list should not change the prompt, because the validator refuses the
 * rest without the model's help.
 */
export const PROMPT_AVOID_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link', 'meta',
  'form', 'input', 'textarea', 'select', 'template', 'svg', 'math',
]);

/** Which language a node's tag is read in: the root element of the other two opens them. */
export type MarkupNamespace = 'html' | 'svg' | 'mathml';

const byLowerCase = (tags: readonly string[]): ReadonlyMap<string, string> =>
  new Map(tags.filter((tag) => !FORBIDDEN_TAGS.has(tag.toLowerCase())).map((tag) => [tag.toLowerCase(), tag]));

/** In the data and reviewed: a name the data gains later stays out until someone has judged it. */
const ACCEPTED_TAGS: Record<MarkupNamespace, ReadonlyMap<string, string>> = {
  html: byLowerCase([...WEB_TAGS.filter((tag) => REVIEWED_HTML_TAGS.has(tag)), ...listGenerationTags(), 'svg', 'math']),
  svg: byLowerCase(WEB_SVG_TAGS.filter((tag) => REVIEWED_SVG_TAGS.has(tag))),
  mathml: byLowerCase(WEB_MATHML_TAGS.filter((tag) => REVIEWED_MATHML_TAGS.has(tag))),
};

/**
 * A tag the validator keeps, spelled as its standard spells it (`linearGradient`),
 * or undefined. Read in its namespace: a `rect` means nothing in HTML, and a
 * `title` in SVG is not the page's title.
 */
export function acceptedTag(tag: string, namespace: MarkupNamespace): string | undefined {
  return ACCEPTED_TAGS[namespace].get(tag.toLowerCase());
}

/** The namespace a node's children are read in. */
export function childNamespace(tag: string, namespace: MarkupNamespace): MarkupNamespace {
  if (tag === 'svg') return 'svg';
  if (tag === 'math') return 'mathml';
  return tag === 'foreignObject' ? 'html' : namespace;
}

const ACCEPTED_STYLE_KEYS: ReadonlySet<string> = new Set([...WEB_STYLE_KEYS, ...CSS_PROP_SET]);

/** A style key the validator and the review keep: a standard CSS property or a custom property. */
export function isAcceptedStyleKey(key: string): boolean {
  return ACCEPTED_STYLE_KEYS.has(key) || /^--[A-Za-z0-9_-]+$/.test(key);
}

/** A style key as the model wrote it, kebab-case converted: `font-size`, `-webkit-line-clamp`. */
export function styleKeyFrom(key: string): string {
  if (key.startsWith('--') || isAcceptedStyleKey(key)) return key;
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Attribute names as `CSS_PROP_SET` reads them, whatever the case the model wrote. */
const CSS_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([...CSS_PROP_SET].map((key) => key.toLowerCase()));

const GLOBAL_ATTRIBUTES: ReadonlySet<string> = new Set(WEB_GLOBAL_ATTRIBUTES);
const SVG_TAGS: ReadonlySet<string> = new Set(WEB_SVG_TAGS);

/**
 * A prop that survives the validator as an attribute on this tag, beyond the
 * taught ones. Refused by default: a name must be in the reviewed list and the
 * data must say it belongs on this tag, or be an aria-* name, which only changes
 * what assistive technology hears. Anything a CSS key would route into `style`
 * stays out, in any case (a `width` prop would skip the style checks). data-* stays
 * out entirely: nothing on a generated page reads one, and the code does (a
 * `data-form-kind` turns a div into a form), so there is only risk in it. A key is
 * matched without case: the data has HTML's names (`tabindex`) and a node holds
 * React's (`tabIndex`). The value is the validator's to check.
 */
export function isAcceptedAttribute(tag: string, key: string): boolean {
  if (key.length > GENERATION_LIMITS.maxNameChars) return false;
  const name = key.toLowerCase();
  if (CSS_ATTRIBUTE_NAMES.has(name)) return false;
  if (name.startsWith('aria-')) return /^aria-[a-z]+$/.test(key);
  if (!REVIEWED_ATTRIBUTES.has(name)) return false;
  // The data lists fill on shapes, but on a group or the svg it sets what they
  // inherit: an outline icon says fill="none" there.
  if (name === 'fill' && SVG_TAGS.has(tag)) return true;
  return GLOBAL_ATTRIBUTES.has(name) || (WEB_ELEMENT_ATTRIBUTES[tag] ?? []).includes(name);
}

export { isSafeSrc };

/** The image the Image preset ships with, used when the model omits or breaks `src`. */
export const PLACEHOLDER_IMAGE_SRC: string =
  (COMPONENT_REGISTRY.image?.defaultProps?.src as string | undefined) ?? '/images/sample-image.jpg';

// ---------- breakpoints ----------

/** A breakpoint as the client describes it to the route (no ids: they may not exist yet). */
export interface BreakpointInput {
  label: string;
  minWidth: number;
}

/** A breakpoint with the stable key the model uses in responsive style maps. */
export interface BreakpointKey extends BreakpointInput {
  key: string;
}

/** The reserved responsive-map key for "every breakpoint without its own value". */
export const BASE_KEY = 'base';

function slug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Derive one stable, unique key per breakpoint from its label ("Desktop" ->
 * "desktop"), largest breakpoint first (the editor treats the largest as the
 * primary one). An empty or reserved label falls back to `bp-<minWidth>`, and a
 * duplicate gets a numeric suffix. Pure: the client applying a result derives
 * the same keys from the same input and maps them back to real breakpoint ids.
 */
export function deriveBreakpointKeys(breakpoints: BreakpointInput[]): BreakpointKey[] {
  const sorted = [...breakpoints].sort((a, b) => b.minWidth - a.minWidth);
  const used = new Set<string>([BASE_KEY]);
  return sorted.map((bp) => {
    let key = slug(bp.label);
    if (!key || used.has(key)) key = key && key !== BASE_KEY ? key : `bp-${bp.minWidth}`;
    let candidate = key;
    let n = 2;
    while (used.has(candidate)) candidate = `${key}-${n++}`;
    used.add(candidate);
    return { key: candidate, label: bp.label, minWidth: bp.minWidth };
  });
}
