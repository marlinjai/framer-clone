// src/lib/ai/pageGen/schema.ts
//
// The single source of truth for what the AI page generator may produce.
// Everything here is DERIVED from the editor's real code, never hand-kept:
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
// The validator (./validate.ts) and the model-facing documentation
// (./schemaDocs.ts) both read from here, so the model is told exactly what the
// validator accepts. A golden test (./__tests__/schemaDocs.test.ts) fails when
// the registry and the docs drift apart.
//
// Client-safe: no server-only imports, so the editor can import the limits and
// the breakpoint-key helper too.

import { COMPONENT_REGISTRY, type ComponentCategory, type DataComponentKind } from '@/lib/componentRegistry';
import { CSS_PROP_SET, type PropsRecord } from '@/models/ComponentModel';
import { isVoidTag } from '@/lib/drag/voidTags';
import { CONTAINER_TYPES, TEXT_TYPES } from '@/components/sidebars/right/sectionConfig';

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

/** Every registry entry, sorted by id for deterministic docs and cache-stable prompts. */
export function listGenerationPresets(): GenerationPreset[] {
  return Object.values(COMPONENT_REGISTRY)
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
 * The HTML tags a generated node may use: every tag the registry produces plus
 * every tag the properties panel classifies as a container or text element (so
 * each generated node gets the right property sections when selected). Sorted.
 */
export function listGenerationTags(): string[] {
  const tags = new Set<string>();
  for (const entry of Object.values(COMPONENT_REGISTRY)) tags.add(entry.htmlType);
  for (const t of CONTAINER_TYPES) tags.add(t);
  for (const t of TEXT_TYPES) tags.add(t);
  return [...tags].sort();
}

/** Style keys the editor routes into `style` (CSS_PROP_SET), sorted. */
export function listGenerationStyleKeys(): string[] {
  return [...CSS_PROP_SET].sort();
}

/**
 * Non-style props a node may carry, by tag. `children` is the text content and
 * is allowed on every non-void tag. Anything else (event handlers, raw HTML,
 * data attributes, className) is never accepted from the model.
 */
export function allowedPropKeysFor(tag: string): string[] {
  const keys: string[] = [];
  if (!isVoidTag(tag)) keys.push('children');
  if (tag === 'img') keys.push('src', 'alt', 'decorative', IMAGE_QUERY_PROP);
  if (PHOTO_BACKGROUND_TAGS.has(tag)) keys.push(IMAGE_QUERY_PROP);
  if (tag === 'a') keys.push('href', 'target');
  return keys;
}

/** Tags that are never generated, even if the model insists (dropped with a warning). */
export const FORBIDDEN_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea',
  'select', 'link', 'meta', 'base', 'frame', 'frameset', 'template', 'svg', 'math',
]);

/** Allowed image sources: http(s) or a site-relative path. No data: or javascript: URLs. */
export function isSafeSrc(value: string): boolean {
  const v = value.trim();
  if (v.startsWith('/') && !v.startsWith('//')) return true;
  return /^https?:\/\//i.test(v);
}

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
