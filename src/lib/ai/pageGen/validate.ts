// src/lib/ai/pageGen/validate.ts
//
// Repair-or-reject for model output. The page generator NEVER applies what the
// model sent as-is: every node is rebuilt from the rules in ./schema.ts.
//
//   Repaired (with a warning the user can see):
//     - style keys that are no CSS property dropped (kebab-case converted first),
//     - unsafe or malformed style values, links and image sources dropped,
//     - props that are no attribute of the tag, or refused ones, dropped
//       (handlers, raw HTML, class names, the data attributes the renderers
//       read: isAcceptedAttribute in ./schema.ts), url attributes checked,
//     - a registry id used as `type` turned into its preset, a preset whose
//       type disagrees with `type` wins, an unknown tag becomes a `div`
//       (inside svg a `g`, inside math an `mrow`),
//     - forbidden tags (script, iframe, form, ...) dropped with their subtree,
//     - inside svg and math a tag is read in that language, in its own case,
//     - text AND children on one node: the text becomes a leading text node
//       (type "#text", bare text with no element, src/lib/renderer/textNode.ts),
//     - a "#text" node keeps only its text, and never stands at the top level
//       or directly inside an element a browser would move it out of,
//     - children on a void tag dropped, missing labels filled,
//     - an img's alt text kept as the model wrote it: a missing or generic
//       one is NOT filled here (the preset's "Image" default is removed too),
//       the page-essentials screen (./essentials.ts) sends it to the repair
//       round and the route fills a last-resort alt from the photo
//       description; `decorative: true` becomes alt "" plus data-decorative,
//     - the sticky call to action (preset stickyCta, src/lib/stickyCta) kept
//       only on a new page, at most one, moved to the end of the top-level
//       nodes; its link props cleaned, a bar without a label or a safe link
//       dropped,
//     - an img with an aspectRatio but no height of its own gets height
//       "auto" (the Image preset's fixed height would otherwise win),
//     - an images.unsplash.com photo (img src or a container's background
//       url() layer) without its complete credit dropped,
//     - a fontFamily outside the self-hosted font library (Inter, Geist, an
//       unhosted font) replaced by the library default of its category; a
//       library family gets its canonical fallback stack (src/lib/fonts),
//     - props.rules kept through the real parser (src/lib/rules/rules.ts) with
//       each body through the style checks: a rule with anything refused is
//       dropped whole, at most MAX_GENERATED_RULES per generation, an
//       `animation` moved behind the reduced-motion gate with the start values it
//       reveals, nothing that reads a visitor's state or looks beyond the node,
//       and on a generation that keeps a rule no address on another host in
//       Normal or an img, but what the request's context held (./promptSections/rules.ts),
//     - responsive-map keys matched to the request's breakpoint keys
//       (case-insensitive, label match), unknown keys dropped,
//     - ids assigned fresh and `parentId` set on every nested node (a whole
//       subtree applied as a snapshot bypasses addChild, and delete / move rely
//       on parentId).
//
//   Rejected (the whole generation, with the reasons, so the route can ask the
//   model for one repair round and otherwise fail loudly):
//     - not an object / no `nodes` array / nothing left after repair,
//     - more than GENERATION_LIMITS.maxNodes nodes or deeper than maxDepth,
//     - anything MobX-State-Tree itself refuses (ComponentModel.create is the
//       final gate, so an invalid snapshot can never reach the editor).
//
// Pure apart from the id factory; runs on the server (route) and is safe to run
// in the browser.

import { v4 as uuidv4 } from 'uuid';
import { STOCK_CREDIT_ATTRS, stockCreditAttrs, stockCreditProps } from './stockCredit';
import { parseAspectRatio, photoUrlOf, withPhotoUrl } from '@/lib/images/imageStyle';
import { normalizeFontFamily } from '@/lib/fonts/registry';
import ComponentModel, { ComponentTypeEnum } from '@/models/ComponentModel';
import { UNSAFE_VALUE, isContainedValue, scanCssValue } from '@/lib/responsive/responsiveCss';
import { isVoidTag } from '@/lib/drag/voidTags';
import { TEXT_NODE_TYPE, refusesBareText } from '@/lib/renderer/textNode';
import { formPropKeysFor, presetFormKind, sanitizeGeneratedFormProps } from '@/lib/forms/generation';
import {
  BASE_KEY,
  DECORATIVE_ATTR,
  FORBIDDEN_TAGS,
  GENERATION_LIMITS,
  IMAGE_QUERY_PROP,
  PHOTO_BACKGROUND_TAGS,
  PLACEHOLDER_IMAGE_SRC,
  acceptedTag,
  allowedPropKeysFor,
  childNamespace,
  getGenerationPreset,
  isAcceptedAttribute,
  isAcceptedStyleKey,
  isSafeSrc,
  styleKeyFrom,
  type BreakpointKey,
  type GenerationPreset,
  type MarkupNamespace,
} from './schema';
import { REVIEWED_ANIMATED_ATTRIBUTES } from './reviewedVocabulary';
import { svgAttributeAsStyle } from './svgAttributes';
import { WEB_ATTRIBUTE_PROP_NAMES } from './webVocabulary';
import { EFFECTS_PROP, cleanGeneratedEffects } from './promptSections/effects';
import {
  MAX_GENERATED_RULES,
  MAX_GENERATED_RULE_WEIGHT,
  MAX_GENERATED_SELECTOR_PARTS,
  REDUCED_MOTION_GATE,
  RULES_PROP,
  hidesContent,
  isMotionKey,
  isReducedMotionGate,
  motionValueProblem,
  namesGeneratedKeyframes,
  ruleWeight,
  selectorProblem,
  storedKeyframesIn,
  wrapperProblem,
} from './promptSections/rules';
import { styleValueTell, textTell } from './tells';
import {
  RULE_ID,
  holdsTooManyBlocks,
  isDefinitionRule,
  isRuleList,
  parseRule,
  storedRulesOf,
  type DefinitionRule,
  type SelectorRule,
  type StoredRule,
} from '@/lib/rules/rules';
import { isSafeHref } from '@/lib/links/safeHref';
import {
  STICKY_CTA_PROP_KEYS,
  cleanStickyCtaProp,
  isStickyCta,
  type StickyCtaPropKey,
} from '@/lib/stickyCta/stickyCta';


/** One validated node, ready for ComponentModel.create (responsive keys are still breakpoint KEYS). */
export interface GeneratedNodeSnapshot {
  id: string;
  type: string;
  componentType: ComponentTypeEnum.HOST;
  label: string;
  props: Record<string, unknown>;
  children: GeneratedNodeSnapshot[];
  parentId?: string;
}

/** Unsplash's orientation filter values. */
export type ImageOrientation = 'landscape' | 'portrait' | 'squarish';

/** Where a stock photo goes: an img's src, or the photo layer of a container's background. */
export type ImageRequestKind = 'img' | 'background';

/**
 * One image the model described for a stock photo. Server-side data only: the
 * route resolves it and writes the photo into the node's props; it is never
 * sent to the editor.
 */
export interface ImageRequest {
  /** The img or container node's (fresh) id. */
  nodeId: string;
  kind: ImageRequestKind;
  /** The search query, trimmed, whitespace collapsed. */
  query: string;
  /** From the box's px width and height, or its aspectRatio (a background defaults to landscape). */
  orientation?: ImageOrientation;
  /** The box's width in px on the largest breakpoint, when known (sizes the hotlinked photo). */
  widthPx?: number;
}

export interface GenerationResult {
  title?: string;
  description?: string;
  nodes: GeneratedNodeSnapshot[];
  warnings: string[];
  stats: { nodeCount: number; maxDepth: number };
  /** Images to resolve to stock photos, in page order. */
  imageRequests: ImageRequest[];
  /** Images whose imageQuery was unusable (they keep the placeholder). */
  invalidImageQueries: number;
}

export type ValidationOutcome =
  | { ok: true; result: GenerationResult }
  | { ok: false; errors: string[]; warnings: string[] };

export interface ValidateContext {
  /** The breakpoint keys the model was told about (see deriveBreakpointKeys). */
  breakpoints: BreakpointKey[];
  /** Id factory; defaults to uuid v4. Injectable for deterministic tests. */
  newId?: () => string;
  /**
   * Whether a sticky call to action may be generated: only on a full new
   * page, where "at most one per page" can be checked. Section generations
   * (replace / insert) never get one. Defaults to false.
   */
  allowStickyCta?: boolean;
  /**
   * What the selected component already holds (addressesHeldBy). A generation with a
   * rule keeps no address on another host but these: they are the owner's, and a
   * regeneration must not take them.
   */
  heldAddresses?: ReadonlySet<string>;
}

/**
 * Where a style sits, which decides what it may hold: a container's own style can
 * carry a credited photo layer, and a rule can hold an animation behind its gate.
 */
type StylePlace = 'photo' | 'plain' | 'rule';

/** Keys the model may send that we silently ignore because the editor owns them. */
const OWNED_KEYS = new Set(['id', 'componentType', 'canvasNodeType', 'parentId']);
const NODE_KEYS = new Set(['type', 'preset', 'label', 'props', 'children']);

/**
 * Characters that let one style value escape into more CSS when a renderer or
 * the publish path serializes styles to text: `{` `}` open or close rules, a
 * backslash starts a CSS escape ("\75 rl(" reads as "url("), and control
 * characters (newlines included) can break out of a declaration or hide content.
 * A `;` depends on where it stands (data inside a string or a url()), which
 * isContainedValue reads the way a browser does: it needs this check first.
 */
const STYLE_BREAKOUT_CHARS = /[{}\\\u0000-\u001f\u007f]/;

/** True when a style value could leave its declaration. */
export function styleValueBreaksOut(text: string): boolean {
  return STYLE_BREAKOUT_CHARS.test(text) || !isContainedValue(text);
}

/** CSS functions that load a URL from a string no check here reads. No generated page needs them. */
export const STRING_URL_FUNCTION = /\bsrc\(|\bimage\(/i;

const Z_INDEX_KEYWORD = /^(?:auto|inherit|initial|unset|revert|revert-layer)$/i;

/**
 * A z-index no higher than GENERATION_LIMITS.maxZIndex, or undefined for one that
 * cannot be read: a var() or calc() could hide any number. The banner sits above
 * that limit, so nothing generated can cover it.
 */
export function clampedZIndex(value: string | number): string | number | undefined {
  const limit = GENERATION_LIMITS.maxZIndex;
  if (typeof value === 'number') return Math.min(Math.trunc(value), limit);
  if (Z_INDEX_KEYWORD.test(value)) return value;
  if (!/^[+-]?\d+$/.test(value)) return undefined;
  return Number(value) > limit ? String(limit) : value;
}

/**
 * Why a style value is refused for what it says, whichever path it came by:
 *   - a custom property holding an address: read through var(), it would pass every
 *     check on the property that uses it;
 *   - a var() in a font or in image-set(): the value that counts is not this one;
 *   - motion that never ends, or a stored keyframes outside a rule (./promptSections/rules.ts).
 */
export function styleValueProblem(property: string, value: string, inRule = false): string | undefined {
  if (UNSAFE_VALUE.test(value) || STRING_URL_FUNCTION.test(value)) return 'unsafe value';
  const motion = motionValueProblem(property, value);
  if (motion) return motion;
  if (!inRule && namesGeneratedKeyframes(property, value)) return 'a stored animation outside a rule';
  const scan = scanCssValue(value);
  if (scan.indirect) return 'var() inside image-set()';
  if ((property === 'fontFamily' || property === 'font') && /var\(/i.test(value)) return 'var() in a font';
  if (property.startsWith('--')) {
    if (/url\(|image-set\(/i.test(value) || scan.strings.some((text) => /[:/]/.test(text))) return 'an address in a custom property';
  }
  return undefined;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** True for raw model output that asks for a text node. */
function isTextNodeInput(v: unknown): boolean {
  return isPlainObject(v) && typeof v.type === 'string' && v.type.trim().toLowerCase() === TEXT_NODE_TYPE;
}

/**
 * A usable stock-photo query: printable text, at least two letters, at most
 * GENERATION_LIMITS.maxImageQueryChars after collapsing whitespace. Anything
 * else (markup, a URL, control characters) is not a description of a photo.
 */
export function cleanImageQuery(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const q = value.replace(/\s+/g, ' ').trim();
  if (q.length < 2 || q.length > GENERATION_LIMITS.maxImageQueryChars) return undefined;
  if (/[<>{}\\\u0000-\u001f\u007f]|:\/\//.test(q)) return undefined;
  if ((q.match(/\p{L}/gu) ?? []).length < 2) return undefined;
  return q;
}

/**
 * Read the way a browser reads it: against a base, so that a backslash or a
 * protocol-relative address finds its host, and a trailing dot is the same host.
 */
function isUnsplashPhotoUrl(value: string): boolean {
  try {
    return new URL(value.trim(), 'https://site.invalid').hostname.replace(/\.+$/, '') === 'images.unsplash.com';
  } catch {
    return false;
  }
}

function isUnsplashPage(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === 'unsplash.com';
  } catch {
    return false;
  }
}

/** A background with no px width says nothing about its size: assume a wide section. */
const DEFAULT_BACKGROUND_WIDTH_PX = 1200;

/** Why one descriptor of a definition is refused: its keys are no CSS properties, so its values are all there is to check. */
function descriptorProblem(key: string, value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'a non-finite number';
  if (typeof value !== 'string') return 'not a string or a number';
  if (value.length > GENERATION_LIMITS.maxStyleValueChars) return 'too long';
  if (styleValueBreaksOut(value)) return 'a bare ;, { } \\ or a control character';
  // @property's initial value is read through var(), like a custom property.
  const problem = styleValueProblem(key === 'initialValue' ? '--initial-value' : key, value, true);
  if (problem) return problem;
  if (scanCssValue(value).urls.some((url) => !url.startsWith('#') && !isSafeSrc(url))) return 'url() to a disallowed location';
  return styleValueTell(key, value) ?? undefined;
}

/** The credit attributes of an existing stock photo, when complete and well-formed. */
function unsplashCredit(props: Record<string, unknown>) {
  const name = props['data-credit-name'];
  const photographerUrl = props['data-credit-url'];
  const unsplashUrl = props['data-credit-source-url'];
  if (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\u0000-\u001f\u007f<>]/.test(name)) {
    return undefined;
  }
  if (!isUnsplashPage(photographerUrl) || !isUnsplashPage(unsplashUrl)) return undefined;
  return { photoId: '', photographerName: name.trim(), photographerUrl, unsplashUrl };
}

/** A px length ("640px", "640", 640) as a number, else undefined. */
function pxLength(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const m = /^(\d+(?:\.\d+)?)(px)?$/.exec(value.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? n : undefined;
}

/** Orientation from a width / height ratio (10% either side of square counts as square). */
export function orientationFor(ratio: number | undefined): ImageOrientation | undefined {
  if (ratio === undefined) return undefined;
  if (ratio > 1.1) return 'landscape';
  if (ratio < 0.9) return 'portrait';
  return 'squarish';
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

/** Attributes that load media by themselves, beyond the taught img src. */
const MEDIA_URL_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'poster', 'srcset']);

/** Elements whose href is a link: it navigates, and draws nothing in. */
const LINK_TAGS: ReadonlySet<string> = new Set(['a', 'area']);

/** SVG elements whose href loads a file. */
const MEDIA_HREF_TAGS: ReadonlySet<string> = new Set(['image', 'feImage']);

/** Characters no attribute value needs: a backslash starts a CSS escape in a presentation attribute. */
const ATTRIBUTE_BREAKOUT_CHARS = /[\\\u0000-\u001f\u007f]/;

/** An id a page anchor needs, and none that reaches the platform: see attributeProblem. */
const SAFE_ID = /^[a-z][a-z0-9-]*$/;
const PLATFORM_ID_PREFIX = /^(?:fc-|ground-wrapper-)/;

/** An id inside an svg, as design tools write them: it is scoped later, so it cannot reach a global. */
const SVG_ID = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

/** A camelCase page anchor, which has one plain slug form. */
const CAMEL_CASE_ID = /^[a-z][a-zA-Z0-9]*$/;

/** The scope an earlier generation left on an id, so that regenerating does not stack them. */
const SVG_ID_SCOPE = /--[a-z0-9]{1,8}$/;

/** A link's spellings: SVG reaches other documents through all three. */
const HREF_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'xlinkhref', 'xlink:href']);

/** SVG attributes that hold geometry: long, and wrapped over lines as often as not. */
const GEOMETRY_ATTRIBUTES: ReadonlySet<string> = new Set(['d', 'points', 'values']);

/** What replaces an unknown tag: the plain box of each language. */
const FALLBACK_TAG: Record<MarkupNamespace, string> = { html: 'div', svg: 'g', mathml: 'mrow' };

/**
 * An address that loads by itself, with no click: a path of this site only. It would
 * reach a third party with the visitor's address and, on a details or a lazy image,
 * report what they did. The storage host could join once it is named in one place.
 */
function isSitePath(url: string): boolean {
  return url.startsWith('/') && isSafeSrc(url) && !isUnsplashPhotoUrl(url);
}

/** Whether every candidate of a srcset is a path of this site (a candidate is a URL and an optional size). */
function isSitePathSrcset(value: string): boolean {
  return value.split(',').every((candidate) => isSitePath(candidate.trim().split(/\s+/)[0]));
}

/** What a browser would do with this href, by tag. */
function hrefProblem(tag: string, text: string): string | undefined {
  if (MEDIA_HREF_TAGS.has(tag)) return isSitePath(text) || text.startsWith('#') ? undefined : 'only a site path';
  return isSafeHref(text) && !isUnsplashPhotoUrl(text) ? undefined : 'only https, http, mailto, tel, # or a site path';
}

/**
 * Why an attribute's text is refused, numbers and booleans included: `target: 1`
 * gets no pass for not being a string.
 *   - An id becomes a property of `window`. Next.js boots from `self.__next_f`, so
 *     one element with that id stops React on the whole page. Every platform global
 *     has an underscore or a capital and a page anchor is a slug, so a slug is what
 *     passes; fc- and ground-wrapper- are ids the page and the canvas look up. An id
 *     inside an svg may look as a design tool wrote it, because scopeIds gives it a
 *     suffix no global has.
 *   - An SVG paint or filter attribute is read as CSS: its url() may only point
 *     inside the page, and a backslash is a CSS escape, so `u\\72 l(` is a url().
 *   - An animation writes an attribute after these checks ran, so only the shape
 *     and paint attributes in the reviewed list may be its target.
 *   - rel="opener" hands the opened page the site's own tab.
 */
function attributeProblem(tag: string, name: string, text: string, namespace: MarkupNamespace): string | undefined {
  const limit = GEOMETRY_ATTRIBUTES.has(name) ? GENERATION_LIMITS.maxGeometryChars : GENERATION_LIMITS.maxAttributeChars;
  if (text.length > limit) return 'too long';
  if (ATTRIBUTE_BREAKOUT_CHARS.test(text)) return 'a backslash or a control character';
  if (/javascript:|vbscript:/i.test(text) || STRING_URL_FUNCTION.test(text) || /image-set\(/i.test(text)) return 'unsafe value';
  if (/url\(/i.test(text)) {
    const scan = scanCssValue(text);
    if (!scan.contained || scan.urls.some((url) => !url.startsWith('#'))) return 'url() outside the page';
  }
  if (name === 'id' && (!(namespace === 'svg' ? SVG_ID : SAFE_ID).test(text) || PLATFORM_ID_PREFIX.test(text))) {
    return 'an id must be a lower-case slug';
  }
  if (name === 'attributename' && !REVIEWED_ANIMATED_ATTRIBUTES.has(text)) return 'animates an attribute outside the shape and paint ones';
  if (name === 'rel' && /(?:^|\s)opener(?:\s|$)/i.test(text)) return 'rel opener';
  if (HREF_ATTRIBUTES.has(name)) return hrefProblem(tag, text);
  if (name === 'srcset') return isSitePathSrcset(text) ? undefined : 'only a site path';
  if (MEDIA_URL_ATTRIBUTES.has(name)) return isSitePath(text) ? undefined : 'only a site path';
  if (name === 'cite') return isSafeSrc(text) && !isUnsplashPhotoUrl(text) ? undefined : 'only https, http or a site path';
  if (name === 'target' && text !== '_blank' && text !== '_self') return 'target must be _blank or _self';
  return undefined;
}

class Validator {
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly imageRequests: ImageRequest[] = [];
  invalidImageQueries = 0;
  nodeCount = 0;
  /** Camel-case page anchors and the slugs they became, so a link to one follows it. */
  readonly idSlugs = new Map<string, string>();
  /** Appear effects accepted so far (capped: motion is used sparingly). */
  appearCount = 0;
  /** Rules stored so far (capped: a state on everything is a tell). */
  ruleCount = 0;
  /** What those rules cost the sheet, so a generation cannot spend the page's budget. */
  ruleWeight = 0;
  maxDepth = 0;
  private readonly bpKeys: Map<string, string>;
  /** Breakpoint keys, largest breakpoint first (the editor's primary breakpoint). */
  private readonly orderedKeys: string[];
  private readonly newId: () => string;

  constructor(ctx: ValidateContext) {
    this.newId = ctx.newId ?? uuidv4;
    this.orderedKeys = [...ctx.breakpoints].sort((a, b) => b.minWidth - a.minWidth).map((b) => b.key);
    // Accept the exact key, its lowercase, and the breakpoint's label, all
    // mapping to the canonical key.
    this.bpKeys = new Map<string, string>();
    for (const bp of ctx.breakpoints) {
      this.bpKeys.set(bp.key.toLowerCase(), bp.key);
      this.bpKeys.set(bp.label.trim().toLowerCase(), bp.key);
    }
  }

  /** A style value on the largest breakpoint: the scalar, or the map's primary / base entry. */
  private primaryStyleValue(value: unknown): unknown {
    if (!isPlainObject(value)) return value;
    const primary = this.orderedKeys[0];
    if (primary && value[primary] !== undefined) return value[primary];
    return value[BASE_KEY];
  }

  /**
   * The box geometry of an image or a photo background, for the photo's
   * orientation and size: the shape from an explicit aspectRatio, else from a
   * px width and height (minHeight for a background, which usually grows with
   * its content). A background without a usable shape is a wide section
   * (landscape), and without a px width it is sized as a full-width one.
   */
  private imageGeometry(
    style: Record<string, unknown>,
    kind: ImageRequestKind,
  ): { orientation?: ImageOrientation; widthPx?: number } {
    const width = pxLength(this.primaryStyleValue(style.width));
    const height =
      pxLength(this.primaryStyleValue(style.height)) ??
      (kind === 'background' ? pxLength(this.primaryStyleValue(style.minHeight)) : undefined);
    const ratio =
      parseAspectRatio(this.primaryStyleValue(style.aspectRatio)) ??
      (width !== undefined && height !== undefined ? width / height : undefined);
    const orientation = orientationFor(ratio) ?? (kind === 'background' ? 'landscape' : undefined);
    const widthPx = width ?? (kind === 'background' ? DEFAULT_BACKGROUND_WIDTH_PX : undefined);
    return {
      ...(orientation ? { orientation } : {}),
      ...(widthPx !== undefined ? { widthPx: Math.round(widthPx) } : {}),
    };
  }

  /**
   * Keep a container's background photo only when it may be shown: an
   * images.unsplash.com url() layer needs the complete credit the context
   * carried (it is then written back as data-credit-* attributes), otherwise
   * the photo layer is removed and the overlay layers (the scrim) stay. Works
   * on a scalar backgroundImage and on every entry of a responsive map.
   * Returns whether a photo layer is left, so a brief-provided URL wins over
   * an imageQuery the same way an img's src does.
   */
  private photoBackground(
    path: string,
    style: Record<string, unknown>,
    modelProps: Record<string, unknown>,
    merged: Record<string, unknown>,
  ): boolean {
    const bg = style.backgroundImage;
    if (bg === undefined) return false;
    const credit = unsplashCredit(modelProps);
    let hasPhoto = false;
    let usedCredit = false;
    let droppedUncredited = false;
    const fix = (value: unknown): unknown => {
      if (typeof value !== 'string') return value;
      const url = photoUrlOf(value);
      if (!url) return value;
      if (isUnsplashPhotoUrl(url)) {
        if (!credit) {
          droppedUncredited = true;
          const rest = withPhotoUrl(value, undefined);
          return rest || undefined;
        }
        usedCredit = true;
      }
      hasPhoto = true;
      return value;
    };
    if (isPlainObject(bg)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(bg)) {
        const fixed = fix(v);
        if (fixed !== undefined) out[k] = fixed;
      }
      if (Object.keys(out).length > 0) style.backgroundImage = out;
      else delete style.backgroundImage;
    } else {
      const fixed = fix(bg);
      if (fixed !== undefined) style.backgroundImage = fixed;
      else delete style.backgroundImage;
    }
    if (droppedUncredited) {
      this.warn(path, 'an Unsplash background photo without its credit cannot be kept, photo layer dropped');
    }
    if (usedCredit && credit) Object.assign(merged, stockCreditAttrs(credit));
    return hasPhoto;
  }

  /** A short token, new for each generation. */
  scopeToken(): string {
    return this.newId().replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'x';
  }

  private warn(path: string, message: string): void {
    this.warnings.push(`${path}: ${message}`);
  }

  private fail(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  /** Validate a style value or a responsive map; returns undefined to drop it. */
  private styleValue(path: string, key: string, raw: unknown, place: StylePlace): unknown {
    if (isPlainObject(raw)) {
      const out: Record<string, string | number> = {};
      for (const [mapKey, v] of Object.entries(raw)) {
        const lower = mapKey.trim().toLowerCase();
        const canonical = lower === BASE_KEY ? BASE_KEY : this.bpKeys.get(lower);
        if (!canonical) {
          this.warn(path, `style.${key}: unknown breakpoint key "${mapKey}" dropped`);
          continue;
        }
        const scalar = this.scalarStyleValue(path, key, mapKey, v, place);
        if (scalar !== undefined) out[canonical] = scalar;
        // A rule is never kept in part, a breakpoint of it included.
        else if (place === 'rule') return undefined;
      }
      if (Object.keys(out).length === 0) {
        this.warn(path, `style.${key}: responsive map had no usable value, dropped`);
        return undefined;
      }
      // Kept as given: the editor and the published page resolve a breakpoint
      // desktop-first (src/lib/responsive/cascade.ts: its own value, then each
      // larger breakpoint's, then "base"), so "base" already reaches every
      // breakpoint without one, and a smaller key's value its smaller ones.
      return out;
    }
    return this.scalarStyleValue(path, key, undefined, raw, place);
  }

  private scalarStyleValue(
    path: string,
    property: string,
    mapKey: string | undefined,
    raw: unknown,
    place: StylePlace,
  ): string | number | undefined {
    const key = mapKey === undefined ? property : `${property}.${mapKey}`;
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) {
        this.warn(path, `style.${key}: non-finite number dropped`);
        return undefined;
      }
      const motion = motionValueProblem(property, String(raw));
      if (motion) {
        this.warn(path, `style.${key}: ${motion} dropped`);
        return undefined;
      }
      return property === 'zIndex' ? clampedZIndex(raw) : raw;
    }
    if (typeof raw !== 'string') {
      this.warn(path, `style.${key}: value must be a string or number, dropped`);
      return undefined;
    }
    const v = raw.trim();
    if (v.length === 0) return undefined;
    if (v.length > GENERATION_LIMITS.maxStyleValueChars) {
      this.warn(path, `style.${key}: value longer than ${GENERATION_LIMITS.maxStyleValueChars} characters dropped`);
      return undefined;
    }
    if (styleValueBreaksOut(raw)) {
      this.warn(path, `style.${key}: value contains a bare ;, { } \\ or a control character, dropped`);
      return undefined;
    }
    const problem = styleValueProblem(property, v, place === 'rule');
    if (problem) {
      this.warn(path, `style.${key}: ${problem} dropped`);
      return undefined;
    }
    // url(...) only to http(s), site paths or a reference inside the page (an SVG
    // clip or mask), never data: or other schemes.
    const { urls } = scanCssValue(v);
    if (urls.some((u) => !u.startsWith('#') && !isSafeSrc(u))) {
      this.warn(path, `style.${key}: url() to a disallowed location dropped`);
      return undefined;
    }
    // A stock photo is only shown with its credit, which photoBackground checks,
    // and it only reads the photo layer of a container's backgroundImage. Anywhere
    // else no credit can travel with it.
    const stock = urls.filter(isUnsplashPhotoUrl);
    const isPhotoLayer = place === 'photo' && property === 'backgroundImage' && stock.length === 1 && photoUrlOf(v) === stock[0];
    if (stock.length > 0 && !isPhotoLayer) {
      this.warn(path, `style.${key}: an Unsplash photo outside a container's background cannot keep its credit, dropped`);
      return undefined;
    }
    if (property === 'zIndex') {
      const clamped = clampedZIndex(v);
      if (clamped === undefined) this.warn(path, `style.${key}: z-index must be a plain number, dropped`);
      return clamped;
    }
    // Font families: library families keep their canonical stack, system
    // stacks stay, anything else (Inter, Geist, a font this app does not host)
    // becomes the library default of its category (src/lib/fonts/registry.ts).
    if (property === 'fontFamily') {
      const font = normalizeFontFamily(v);
      if (font.reason) {
        this.warn(path, `style.${key}: ${font.reason}`);
      }
      return font.value;
    }
    // The tells screen reads props.style, so a rule is read here, one value at a time.
    const tell = place === 'rule' ? (styleValueTell(property, v) ?? (property === 'content' ? textTell(v) : null)) : null;
    if (tell) {
      this.warn(path, `style.${key}: ${tell}, dropped`);
      return undefined;
    }
    return v;
  }

  private style(path: string, raw: unknown, place: StylePlace): Record<string, unknown> {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) {
      this.warn(path, 'props.style must be an object, dropped');
      return {};
    }
    const out: Record<string, unknown> = {};
    const entries = Object.entries(raw);
    if (entries.length > GENERATION_LIMITS.maxPropsPerNode) {
      this.warn(path, `only the first ${GENERATION_LIMITS.maxPropsPerNode} style keys kept`);
    }
    for (const [rawKey, rawValue] of entries.slice(0, GENERATION_LIMITS.maxPropsPerNode)) {
      const key = styleKeyFrom(rawKey);
      if (rawKey.length > GENERATION_LIMITS.maxNameChars || !isAcceptedStyleKey(key)) {
        this.warn(path, `style key "${rawKey}" is not supported by the editor, dropped`);
        continue;
      }
      const value = this.styleValue(path, key, rawValue, place);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /** A rule's or a keyframe's declarations, or undefined for none or for one refused: a rule is never kept in part. */
  private declarations(path: string, raw: unknown): Record<string, unknown> | undefined {
    const style = this.style(path, raw, 'rule');
    const kept = Object.keys(style).length;
    return kept > 0 && isPlainObject(raw) && kept === Object.keys(raw).length ? style : undefined;
  }

  private descriptors(path: string, raw: Record<string, unknown>): Record<string, unknown> | undefined {
    for (const [key, value] of Object.entries(raw)) {
      const problem = descriptorProblem(key, value);
      if (problem) {
        this.warn(path, `descriptor ${key}: ${problem}, dropped`);
        return undefined;
      }
    }
    return raw;
  }

  /**
   * A definition. Its text is parsed first, because a descriptor (`src`, `syntax`) is
   * no CSS property and only the parser knows which at-rule may hold which. Keyframes
   * and `@position-try` hold real properties, so they get every check a style gets:
   * a keyframe could otherwise animate a z-index past the banner.
   */
  private definition(path: string, raw: Record<string, unknown>, id: string): DefinitionRule | string {
    const read = parseRule({ ...raw, id });
    if (!read.ok) return read.reason;
    if (read.value.kind !== 'definition') return 'a rule is either a selector or a definition';
    const { atRule, style, blocks } = read.value;
    const body = (from: Record<string, unknown>) =>
      atRule === 'keyframes' || atRule === 'position-try' ? this.declarations(path, from) : this.descriptors(path, from);
    const stored: DefinitionRule = { id, define: (raw.define as string).trim() };
    if (style) {
      const cleaned = body(style);
      if (!cleaned) return 'a descriptor was refused';
      stored.style = cleaned;
    }
    if (blocks) {
      stored.blocks = [];
      for (const block of blocks) {
        const cleaned = body(block.style);
        if (!cleaned) return 'a block was refused';
        stored.blocks.push({ selector: block.selector, style: cleaned });
      }
    }
    return stored;
  }

  /**
   * A selector rule, with an `animation` behind the reduced-motion gate. The gate takes
   * only the animation, because a visitor who asked for less motion keeps the rest of
   * a hover. `freshId` names the rule that split off.
   */
  private selectorRules(path: string, raw: Record<string, unknown>, id: string, freshId: () => string): SelectorRule[] | string {
    if (typeof raw.selector === 'string' && raw.selector.length > GENERATION_LIMITS.maxStyleValueChars) {
      return `a selector longer than ${GENERATION_LIMITS.maxStyleValueChars} characters`;
    }
    const style = this.declarations(path, raw.style);
    if (!style) return 'a declaration was refused, or it has none';
    // Everything the model sent is read, so a `when` or a `gate` is refused rather than
    // left behind: without its condition a rule would be the permanent look.
    const read = parseRule({ ...raw, id, style });
    if (!read.ok) return read.reason;
    if (read.value.kind !== 'selector') return 'a rule is either a selector or a definition';
    const { at, parts } = read.value;
    if (parts.length > MAX_GENERATED_SELECTOR_PARTS) return `a selector with more than ${MAX_GENERATED_SELECTOR_PARTS} parts`;
    const refused = parts.map(selectorProblem).find(Boolean) ?? at.map(wrapperProblem).find(Boolean);
    if (refused) return refused;
    const rule: SelectorRule = { id, selector: raw.selector as string, ...(at.length > 0 ? { at } : {}), style };
    const motion = Object.keys(style).filter(isMotionKey);
    if (motion.length === 0 || at.some(isReducedMotionGate)) return [rule];
    const gated: SelectorRule = { ...rule, at: [REDUCED_MOTION_GATE, ...at] };
    if (motion.length === Object.keys(style).length) return [gated];
    const moving = Object.fromEntries(motion.map((key) => [key, style[key]]));
    const rest = Object.fromEntries(Object.entries(style).filter(([key]) => !isMotionKey(key)));
    return [{ ...rule, style: rest }, { ...gated, id: freshId(), style: moving }];
  }

  /** One rule of the model's, as what will be stored, or why it is dropped. */
  private rule(path: string, raw: unknown, ids: Set<string>): StoredRule[] | string {
    if (!isPlainObject(raw)) return 'a rule is an object';
    if (holdsTooManyBlocks(raw)) return 'too many blocks';
    const freshId = () => {
      let n = ids.size + 1;
      while (ids.has(`r${n}`)) n += 1;
      ids.add(`r${n}`);
      return `r${n}`;
    };
    // The editor needs an id and nothing depends on the model's: a missing one is filled.
    const wanted = typeof raw.id === 'string' && RULE_ID.test(raw.id) && !ids.has(raw.id) ? raw.id : undefined;
    if (wanted) ids.add(wanted);
    const id = wanted ?? freshId();
    const made = raw.define !== undefined ? this.definition(path, raw, id) : this.selectorRules(path, raw, id, freshId);
    if (typeof made === 'string') return made;
    const rules = Array.isArray(made) ? made : [made];
    for (const rule of rules) {
      // Last, on what will be stored: this is what the renderers will parse.
      const final = parseRule(rule);
      if (!final.ok) return final.reason;
    }
    return rules;
  }

  private weightOf(rule: StoredRule): number {
    if (isDefinitionRule(rule)) return ruleWeight(rule, 1, 1);
    const parsed = parseRule(rule);
    const parts = parsed.ok && parsed.value.kind === 'selector' ? parsed.value.parts.length : 1;
    return ruleWeight(rule, parts, Object.values(rule.style).some(isPlainObject) ? Math.max(this.orderedKeys.length, 1) : 1);
  }

  /** The stored form of props.rules, capped across the generation like appear effects. */
  private rules(path: string, raw: unknown[]): StoredRule[] {
    const kept: StoredRule[] = [];
    const ids = new Set<string>();
    for (const [index, item] of raw.entries()) {
      const room = MAX_GENERATED_RULES - this.ruleCount;
      if (room <= 0) {
        this.warn(path, `more than ${MAX_GENERATED_RULES} rules in one generation, ${raw.length - index} dropped (use them sparingly)`);
        break;
      }
      const rules = this.rule(`${path}.rules[${index}]`, item, ids);
      if (typeof rules === 'string') this.warn(`${path}.rules[${index}]`, `rule dropped: ${rules}`);
      else if (rules.length > room) this.warn(`${path}.rules[${index}]`, `rule dropped: more than ${MAX_GENERATED_RULES} rules in one generation`);
      else {
        const weight = rules.reduce((sum, rule) => sum + this.weightOf(rule), 0);
        if (this.ruleWeight + weight > MAX_GENERATED_RULE_WEIGHT) {
          this.warn(`${path}.rules[${index}]`, 'rule dropped: the rules of this generation are too long');
          continue;
        }
        kept.push(...rules);
        this.ruleCount += rules.length;
        this.ruleWeight += weight;
      }
    }
    return kept;
  }

  /**
   * A prop beyond the taught ones (see isAcceptedAttribute), stored under one
   * spelling. HTML reads `ID` as `id` while every check here reads the key it was
   * given, so a second spelling of a name is a way past them.
   */
  private attribute(
    path: string,
    type: string,
    key: string,
    value: unknown,
    props: Record<string, unknown>,
    namespace: MarkupNamespace,
  ): void {
    if (!isAcceptedAttribute(type, key)) {
      this.warn(path, `prop "${key}" is not allowed on <${type}>, dropped`);
      return;
    }
    const name = key.toLowerCase();
    if (typeof value !== 'string' && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) {
      this.warn(path, `${key} must be text, a number or true / false, dropped`);
      return;
    }
    let text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : String(value);
    if (name === 'id' && namespace !== 'svg' && CAMEL_CASE_ID.test(text) && text !== text.toLowerCase()) {
      const slug = text.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      this.idSlugs.set(text, slug);
      text = slug;
    }
    const problem = attributeProblem(type, name, text, namespace);
    if (problem) {
      this.warn(path, `${key} dropped: ${problem}`);
      return;
    }
    props[WEB_ATTRIBUTE_PROP_NAMES[name] ?? name] = typeof value === 'string' || name === 'id' ? text : value;
  }

  /** Resolve type + preset. Returns null when the node must be dropped. */
  private resolveType(
    path: string,
    rawType: unknown,
    rawPreset: unknown,
    namespace: MarkupNamespace,
  ): { type: string; preset?: GenerationPreset } | null {
    let preset: GenerationPreset | undefined;
    if (rawPreset !== undefined) {
      preset = typeof rawPreset === 'string' ? getGenerationPreset(rawPreset) : undefined;
      if (!preset) this.warn(path, `unknown preset ${JSON.stringify(rawPreset)} ignored`);
    }
    let type = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
    if (!preset && type && namespace === 'html') {
      // The model used a registry id ("card", "stack") as the tag.
      const asPreset = getGenerationPreset(typeof rawType === 'string' ? rawType.trim() : '');
      if (asPreset && !acceptedTag(type, namespace)) {
        this.warn(path, `"${rawType}" is a preset, not a tag: using type "${asPreset.htmlType}" with preset "${asPreset.id}"`);
        preset = asPreset;
        type = asPreset.htmlType;
      }
    }
    if (FORBIDDEN_TAGS.has(type)) {
      this.warn(path, `tag "${type}" is not allowed, node and its children dropped`);
      return null;
    }
    if (preset && type !== preset.htmlType) {
      if (type) this.warn(path, `type "${type}" does not match preset "${preset.id}", using "${preset.htmlType}"`);
      type = preset.htmlType;
    }
    const fallback = FALLBACK_TAG[namespace];
    if (!type) {
      this.warn(path, `missing type, using "${fallback}"`);
      type = fallback;
    } else if (!preset) {
      const accepted = acceptedTag(type, namespace);
      if (!accepted) this.warn(path, `tag "${type}" is not available in the editor, using "${fallback}"`);
      type = accepted ?? fallback;
    }
    return { type, preset };
  }

  /**
   * A text node: bare text among its siblings, so only its text is kept. The
   * text stays exactly as written ("Hello " keeps its space; a space alone
   * separates two inline elements), and React escapes it like any other text.
   */
  private textNode(
    raw: Record<string, unknown>,
    path: string,
    depth: number,
    parentId?: string,
  ): GeneratedNodeSnapshot[] {
    if (depth === 1) {
      this.warn(path, 'a #text node must sit inside an element, dropped');
      return [];
    }
    const props = isPlainObject(raw.props) ? raw.props : {};
    for (const key of Object.keys(props)) {
      if (key !== 'children') this.warn(path, `prop "${key}" is not allowed on a #text node, dropped`);
    }
    if (Array.isArray(raw.children) && raw.children.length > 0) {
      this.warn(path, `a #text node cannot have children, ${raw.children.length} dropped`);
    }
    const text = cleanText(props.children, GENERATION_LIMITS.maxTextChars);
    if (text === undefined || text === '') {
      this.warn(path, 'a #text node needs text in props.children, dropped');
      return [];
    }
    if (typeof props.children === 'string' && props.children.length > text.length) {
      this.warn(path, `text cut to ${GENERATION_LIMITS.maxTextChars} characters`);
    }
    this.nodeCount += 1;
    if (depth > this.maxDepth) this.maxDepth = depth;
    const snapshot: GeneratedNodeSnapshot = {
      id: `text-${this.newId()}`,
      type: TEXT_NODE_TYPE,
      componentType: ComponentTypeEnum.HOST,
      label: 'Text',
      props: { children: text },
      children: [],
    };
    if (parentId) snapshot.parentId = parentId;
    return [snapshot];
  }

  node(raw: unknown, path: string, depth: number, parentId?: string, namespace: MarkupNamespace = 'html'): GeneratedNodeSnapshot[] {
    if (!isPlainObject(raw)) {
      this.fail(path, 'node must be an object');
      return [];
    }
    // Past the limit the generation is refused anyway: reading on only costs time.
    if (this.nodeCount > GENERATION_LIMITS.maxNodes) return [];
    if (depth > GENERATION_LIMITS.maxDepth) {
      this.fail(path, `nesting deeper than ${GENERATION_LIMITS.maxDepth} levels`);
      return [];
    }
    for (const key of Object.keys(raw)) {
      if (!NODE_KEYS.has(key) && !OWNED_KEYS.has(key)) this.warn(path, `unknown key "${key}" ignored`);
    }

    if (isTextNodeInput(raw)) {
      return this.textNode(raw, path, depth, parentId);
    }

    const resolved = this.resolveType(path, raw.type, raw.preset, namespace);
    if (!resolved) return [];
    const { type, preset } = resolved;
    // A preset is an HTML element, and the HTML parser throws one out of svg and math
    // while a client render keeps it inside and invisible: crawlers would read text
    // the owner never sees. Under a foreignObject the namespace is HTML again.
    if (preset && namespace !== 'html') {
      this.warn(path, `preset "${preset.id}" cannot sit inside svg or math, node and its children dropped`);
      return [];
    }
    const id = `${preset?.id ?? type}-${this.newId()}`;
    this.nodeCount += 1;
    if (depth > this.maxDepth) this.maxDepth = depth;

    // ---- props ----
    const rawProps = raw.props === undefined ? {} : raw.props;
    if (!isPlainObject(rawProps)) this.warn(path, 'props must be an object, ignored');
    const modelProps = isPlainObject(rawProps) ? rawProps : {};
    const allowed = new Set(allowedPropKeysFor(type));
    // Form presets (src/lib/forms/generation.ts) accept their own props on top.
    const formKeys = new Set(formPropKeysFor(preset?.defaultProps as Record<string, unknown> | undefined));
    const formProps: Record<string, unknown> = {};
    // The sticky call to action's link props (src/lib/stickyCta/stickyCta.ts).
    const stickyKeys = new Set<string>(isStickyCta(preset?.defaultProps) ? STICKY_CTA_PROP_KEYS : []);
    const stickyProps: Record<string, unknown> = {};
    let decorative = false;
    const props: Record<string, unknown> = {};
    let text: string | undefined;
    let imageQuery: string | undefined;
    let invalidQuery = false;
    let rawEffects: unknown;
    let rawRules: unknown[] | undefined;

    // An Unsplash photo's credit (an earlier generation's image or background,
    // sent back in replace / insert context) is read separately below, never
    // warned about. Containers never carry the hover title (see stockCredit.ts).
    const isPhotoContainer = PHOTO_BACKGROUND_TAGS.has(type);
    const creditKeys = new Set<string>(
      type === 'img' ? ['title', ...STOCK_CREDIT_ATTRS] : isPhotoContainer ? STOCK_CREDIT_ATTRS : [],
    );
    const ownNamespace = type === 'svg' ? 'svg' : namespace;
    const svgStyle: Record<string, unknown> = {};
    const modelEntries = Object.entries(modelProps);
    if (modelEntries.length > GENERATION_LIMITS.maxPropsPerNode) {
      this.warn(path, `only the first ${GENERATION_LIMITS.maxPropsPerNode} props kept`);
    }
    for (const [key, value] of modelEntries.slice(0, GENERATION_LIMITS.maxPropsPerNode)) {
      if (key === 'style' || creditKeys.has(key)) continue;
      if (key === EFFECTS_PROP) {
        // Cleaned after the children are known (stagger needs two of them).
        rawEffects = value;
        continue;
      }
      // A string is the legacy table attribute, which stays an attribute.
      if (key === RULES_PROP && typeof value !== 'string') {
        if (isRuleList(value)) rawRules = value;
        else this.warn(path, 'props.rules must be a list, dropped');
        continue;
      }
      if (formKeys.has(key)) {
        formProps[key] = value;
        continue;
      }
      if (stickyKeys.has(key)) {
        const cleaned = cleanStickyCtaProp(key as StickyCtaPropKey, value);
        if (cleaned === undefined) this.warn(path, `${key} of the sticky call to action is not usable, dropped`);
        else stickyProps[key] = cleaned;
        continue;
      }
      if (type === 'img' && key === DECORATIVE_ATTR) {
        // An existing decorative image echoed back in replace / insert context.
        if (value === 'true') decorative = true;
        continue;
      }
      if (!allowed.has(key)) {
        const asStyle = ownNamespace === 'svg' ? svgAttributeAsStyle(type, key, value) : undefined;
        if (asStyle) svgStyle[asStyle.key] = asStyle.value;
        else this.attribute(path, type, key, value, props, ownNamespace);
        continue;
      }
      if (key === 'children') {
        const t = cleanText(value, GENERATION_LIMITS.maxTextChars);
        if (t === undefined) {
          this.warn(path, 'props.children must be text, dropped');
        } else {
          if (typeof value === 'string' && value.length > GENERATION_LIMITS.maxTextChars) {
            this.warn(path, `text cut to ${GENERATION_LIMITS.maxTextChars} characters`);
          }
          text = t;
        }
      } else if (key === 'href') {
        if (typeof value === 'string' && isSafeHref(value)) props.href = value.trim();
        else this.warn(path, 'href dropped (only https, http, mailto, tel, # or a site path)');
      } else if (key === 'src') {
        if (typeof value === 'string' && isSafeSrc(value)) props.src = value.trim();
        else this.warn(path, 'src dropped (only https, http or a site path)');
      } else if (key === 'target') {
        if (value === '_blank' || value === '_self') props.target = value;
        else this.warn(path, 'target must be _blank or _self, dropped');
      } else if (key === 'alt') {
        const alt = cleanText(value, 300);
        if (alt !== undefined) props.alt = alt;
      } else if (key === 'decorative') {
        if (value === true) decorative = true;
        else if (value !== false) this.warn(path, 'decorative must be true or false, dropped');
      } else if (key === IMAGE_QUERY_PROP) {
        // Kept out of the props: the route resolves it to a stock photo.
        imageQuery = cleanImageQuery(value);
        if (imageQuery === undefined) {
          invalidQuery = true;
          this.warn(path, `${IMAGE_QUERY_PROP} must be a short plain-text photo description, dropped`);
        }
      }
    }

    // Merge preset defaults under the model's props; style merges key by key.
    const presetDefaults = (preset?.defaultProps ?? {}) as Record<string, unknown>;
    const presetStyle = isPlainObject(presetDefaults.style) ? presetDefaults.style : {};
    const rawModelStyle = isPlainObject(modelProps.style) ? modelProps.style : modelProps.style === undefined ? {} : modelProps.style;
    const modelStyle = this.style(path, isPlainObject(rawModelStyle) ? { ...svgStyle, ...rawModelStyle } : rawModelStyle, isPhotoContainer ? 'photo' : 'plain');
    const style: Record<string, unknown> = { ...presetStyle, ...modelStyle };
    if (type === 'img' && modelStyle.aspectRatio !== undefined && modelStyle.height === undefined) {
      // The shape comes from the aspect ratio: a preset's fixed height would override it.
      style.height = 'auto';
    }
    const merged: Record<string, unknown> = {
      ...presetDefaults,
      ...props,
      ...sanitizeGeneratedFormProps(presetDefaults, formProps, (m) => this.warn(path, m)),
      ...stickyProps,
    };
    if (isStickyCta(presetDefaults)) {
      // The label and the link must come from the model: the preset's
      // placeholders ("Book now" to "#contact") would publish a dead button.
      if (stickyProps.ctaLabel === undefined) delete merged.ctaLabel;
      if (stickyProps.ctaHref === undefined) delete merged.ctaHref;
    }
    delete merged.style;
    const hasBackgroundPhoto = isPhotoContainer && this.photoBackground(path, style, modelProps, merged);
    if (Object.keys(style).length > 0) merged.style = style;
    if (isPhotoContainer) {
      // A photo the brief provided (a url() layer) wins over a stock-photo query.
      if (imageQuery !== undefined && !hasBackgroundPhoto) {
        this.imageRequests.push({ nodeId: id, kind: 'background', query: imageQuery, ...this.imageGeometry(style, 'background') });
      } else if (invalidQuery && !hasBackgroundPhoto) {
        this.invalidImageQueries += 1;
      }
    }
    if (type === 'img' && typeof props.src === 'string' && isUnsplashPhotoUrl(props.src)) {
      // An Unsplash photo is only ever shown with its credit: keep the credit
      // the context carried, or drop the photo (the query or placeholder
      // path below takes over).
      const credit = unsplashCredit(modelProps);
      if (credit) Object.assign(merged, stockCreditProps(credit));
      else {
        this.warn(path, 'an Unsplash photo without its credit cannot be kept, src dropped');
        delete props.src;
        delete merged.src;
      }
    }
    if (type === 'img') {
      // A src the model was given in the brief wins over a stock-photo query.
      if (imageQuery !== undefined && typeof props.src !== 'string') {
        this.imageRequests.push({ nodeId: id, kind: 'img', query: imageQuery, ...this.imageGeometry(style, 'img') });
      } else if (invalidQuery && typeof props.src !== 'string') {
        this.invalidImageQueries += 1;
      }
      if (!(typeof merged.src === 'string' && isSafeSrc(merged.src))) {
        // No src is the documented way to ask for a placeholder (the user
        // swaps in a real image); only a broken src was already warned about.
        merged.src = PLACEHOLDER_IMAGE_SRC;
      }
      if (decorative) {
        // Decorative on purpose: an empty alt, so screen readers skip it.
        merged.alt = '';
        merged[DECORATIVE_ATTR] = 'true';
      } else if (typeof props.alt !== 'string' || props.alt.trim() === '') {
        // Judged on what the model wrote, never on the preset's "Image"
        // default: a missing alt goes to the repair round (./essentials.ts).
        delete merged.alt;
      }
      merged.draggable = false;
    }

    // ---- label ----
    let label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (label.length > GENERATION_LIMITS.maxLabelChars) label = label.slice(0, GENERATION_LIMITS.maxLabelChars);
    if (!label) label = preset?.label ?? type.charAt(0).toUpperCase() + type.slice(1);

    // ---- children ----
    let rawChildren: unknown[] = [];
    if (raw.children !== undefined) {
      if (Array.isArray(raw.children)) rawChildren = raw.children;
      else this.warn(path, 'children must be an array, ignored');
    }

    // ---- effects (appear only, clamped, capped per generation) ----
    // Decided before the children, so the cap keeps the outer reveals (a
    // section) over inner ones. Stagger needs two children to make sense.
    delete merged[EFFECTS_PROP];
    if (rawEffects !== undefined) {
      const childCount = isVoidTag(type) || preset?.dataComponentKind ? 0 : rawChildren.length;
      const cleaned = cleanGeneratedEffects(rawEffects, childCount, this.appearCount);
      for (const w of cleaned.warnings) this.warn(path, w);
      if (cleaned.effects) {
        merged[EFFECTS_PROP] = cleaned.effects;
        this.appearCount += 1;
      }
    }

    // ---- rules (decided here for the same reason: the outer nodes come first) ----
    if (rawRules) {
      const rules = this.rules(path, rawRules);
      if (rules.length > 0) merged[RULES_PROP] = rules;
    }

    const children: GeneratedNodeSnapshot[] = [];
    if (isVoidTag(type)) {
      if (rawChildren.length > 0) this.warn(path, `<${type}> cannot have children, ${rawChildren.length} dropped`);
      if (text !== undefined) this.warn(path, `<${type}> cannot have text, dropped`);
      text = undefined;
    } else if (rawChildren.length > 0 && isStickyCta(presetDefaults)) {
      this.warn(path, 'the sticky call to action renders its own link (ctaLabel, ctaHref), children dropped');
    } else if (rawChildren.length > 0 && ['form-field', 'form-submit'].includes(presetFormKind(presetDefaults) ?? '')) {
      this.warn(path, `form component "${preset?.id}" renders its own content, children dropped`);
    } else if (preset?.dataComponentKind && rawChildren.length > 0) {
      this.warn(path, `data component "${preset.id}" renders its own content, children dropped`);
    } else {
      if (text !== undefined && rawChildren.length > 0) {
        // Both text and children: keep both by turning the text into a leading child.
        this.warn(path, 'node had text and children, text moved into a leading text node');
        rawChildren = [{ type: TEXT_NODE_TYPE, props: { children: text } }, ...rawChildren];
        text = undefined;
      }
      rawChildren.forEach((child, i) => {
        const childPath = `${path}.children[${i}]`;
        // The browser would move this text out of the element while parsing.
        if (refusesBareText(type) && isTextNodeInput(child)) {
          this.warn(childPath, `a #text node cannot sit directly inside <${type}>, dropped`);
          return;
        }
        children.push(...this.node(child, childPath, depth + 1, id, childNamespace(type, namespace)));
      });
    }
    if (isStickyCta(presetDefaults)) {
      // The bar draws its link from ctaLabel; text on the bar is that label.
      if (text !== undefined && merged.ctaLabel === undefined) {
        const label = cleanStickyCtaProp('ctaLabel', text);
        if (label !== undefined) merged.ctaLabel = label;
      }
      text = undefined;
    }
    if (text !== undefined) merged.children = text;
    else delete merged.children;

    const snapshot: GeneratedNodeSnapshot = {
      id,
      type,
      componentType: ComponentTypeEnum.HOST,
      label,
      props: merged,
      children,
    };
    if (parentId) snapshot.parentId = parentId;
    return [snapshot];
  }
}

/** Count a subtree's nodes. */
function countNodes(node: GeneratedNodeSnapshot): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}

/**
 * The ids a node draws in, by a paint, mask or filter url() or an href, and whether
 * it is a `use` reaching outside the generation. A link draws nothing in, so `a`
 * and `area` never count: a link to the section it sits in is no cycle.
 */
function referencesOf(node: GeneratedNodeSnapshot): { ids: string[]; external: boolean } {
  const ids: string[] = [];
  let external = false;
  const read = (value: unknown): void => {
    if (typeof value === 'string') {
      if (/url\(/i.test(value)) {
        for (const url of scanCssValue(value).urls) if (url.startsWith('#')) ids.push(url.slice(1));
      }
    } else if (isPlainObject(value)) {
      Object.values(value).forEach(read);
    }
  };
  for (const [key, value] of Object.entries(node.props)) {
    if (key === 'children') continue;
    read(value);
    if (!HREF_ATTRIBUTES.has(key.toLowerCase()) || typeof value !== 'string' || LINK_TAGS.has(node.type)) continue;
    if (value.startsWith('#')) ids.push(value.slice(1));
    else if (node.type === 'use') external = true;
  }
  return { ids, external };
}

/**
 * The size of a subtree with every reference counted at full size, memoised, so a
 * chain of `use` costs its real expansion and not its node count. Over the budget
 * stops counting; a cycle or a `use` reaching outside this generation counts as over
 * it, because the size of what it reaches cannot be known.
 */
function expandedSize(
  node: GeneratedNodeSnapshot,
  byId: Map<string, GeneratedNodeSnapshot[]>,
  memo: Map<GeneratedNodeSnapshot, number>,
  open: Set<GeneratedNodeSnapshot>,
): number {
  const over = GENERATION_LIMITS.maxSvgExpansion + 1;
  const known = memo.get(node);
  if (known !== undefined) return known;
  if (open.has(node)) return over;
  open.add(node);
  const { ids, external } = referencesOf(node);
  let size = external ? over : 1;
  const add = (target: GeneratedNodeSnapshot) => {
    size = Math.min(over, size + expandedSize(target, byId, memo, open));
  };
  for (const id of ids) {
    const targets = byId.get(id) ?? [];
    if (node.type === 'use' && targets.length === 0) size = over;
    // A duplicate id: a browser picks one, so all of them count.
    targets.forEach(add);
  }
  node.children.forEach(add);
  open.delete(node);
  memo.set(node, size);
  return size;
}

/** Every node under an svg, the root included. */
function forEachInSvg(nodes: GeneratedNodeSnapshot[], visit: (node: GeneratedNodeSnapshot) => void): void {
  const inside = (node: GeneratedNodeSnapshot): void => {
    visit(node);
    node.children.forEach(inside);
  };
  for (const node of nodes) {
    if (node.type === 'svg') inside(node);
    else forEachInSvg(node.children, visit);
  }
}

const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/gi;

/**
 * Give every id inside an svg a suffix unique to this generation, and every
 * reference with it, and follow a page anchor to its slug. Ids under svg are private
 * to the graphic, so nothing is lost, and a generation can no longer declare a decoy
 * of an id another one holds, which is how three generations could rebuild a chain
 * of `use` the budget had refused. An HTML id stays what it is: a page anchor.
 */
function scopeIds(nodes: GeneratedNodeSnapshot[], v: Validator): GeneratedNodeSnapshot[] {
  const scoped = new Map<string, string>();
  const taken = new Set<string>();
  const inSvg = new Set<GeneratedNodeSnapshot>();
  let scope: string | undefined;
  forEachInSvg(nodes, (node) => {
    inSvg.add(node);
    const id = node.props.id;
    if (typeof id !== 'string' || scoped.has(id)) return;
    scope ??= v.scopeToken();
    // Removing an old scope can make two ids one: each keeps a name of its own.
    const base = id.replace(SVG_ID_SCOPE, '');
    let name = `${base}--${scope}`;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}--${scope}`;
    taken.add(name);
    scoped.set(id, name);
  });
  if (scoped.size === 0 && v.idSlugs.size === 0) return nodes;
  const target = (id: string): string | undefined => scoped.get(id) ?? v.idSlugs.get(id);
  const inValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(URL_REFERENCE, (match, quote: string, id: string) => {
        const to = target(id);
        return to ? `url(${quote}#${to}${quote})` : match;
      });
    }
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, inValue(inner)]));
  };
  const rewrite = (node: GeneratedNodeSnapshot): GeneratedNodeSnapshot => {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.props)) {
      if (key === 'children' || typeof value === 'boolean' || typeof value === 'number') props[key] = value;
      else if (key === 'id') props[key] = inSvg.has(node) ? (scoped.get(value as string) ?? value) : value;
      else if (HREF_ATTRIBUTES.has(key.toLowerCase()) && typeof value === 'string' && value.startsWith('#')) {
        props[key] = `#${target(value.slice(1)) ?? value.slice(1)}`;
      } else if (/^aria-(?:labelledby|describedby|controls|owns|details|flowto|activedescendant|errormessage)$/.test(key) && typeof value === 'string') {
        props[key] = value.split(' ').map((id) => target(id) ?? id).join(' ');
      } else props[key] = inValue(value);
    }
    return { ...node, props, children: node.children.map(rewrite) };
  };
  return nodes.map(rewrite);
}

/**
 * Drop every svg whose expansion is over budget, after everything else, so that it
 * covers every route into a generation. A few dozen nested `use` freeze a browser
 * tab for every visitor and for the editor that opens the page, and no node or depth
 * limit sees that. References run across the whole generation, because one svg can
 * reach into another, and a `use` may not leave it. It runs on the ids scopeIds
 * wrote, the ones a browser will read, so it cannot count a different page than the
 * one that ships; that also stops a later generation declaring a decoy of an id.
 */
function dropExpandingSvgs(nodes: GeneratedNodeSnapshot[], v: Validator): GeneratedNodeSnapshot[] {
  const byId = new Map<string, GeneratedNodeSnapshot[]>();
  forEachInSvg(nodes, (node) => {
    if (typeof node.props.id === 'string') byId.set(node.props.id, [...(byId.get(node.props.id) ?? []), node]);
  });
  const memo = new Map<GeneratedNodeSnapshot, number>();
  const dropped = new Set<string>();
  const forget = (node: GeneratedNodeSnapshot): void => {
    dropped.add(node.id);
    node.children.forEach(forget);
  };
  const keep = (list: GeneratedNodeSnapshot[]): GeneratedNodeSnapshot[] => {
    const out: GeneratedNodeSnapshot[] = [];
    for (const node of list) {
      if (node.type === 'svg' && expandedSize(node, byId, memo, new Set()) > GENERATION_LIMITS.maxSvgExpansion) {
        v.warnings.push(`${node.label}: this svg expands past ${GENERATION_LIMITS.maxSvgExpansion} elements or uses something outside this generation, dropped`);
        v.nodeCount -= countNodes(node);
        forget(node);
      } else {
        out.push(node.children.length > 0 ? { ...node, children: keep(node.children) } : node);
      }
    }
    return out;
  };
  const kept = keep(nodes);
  if (dropped.size > 0) {
    const requests = v.imageRequests.filter((request) => !dropped.has(request.nodeId));
    v.imageRequests.splice(0, v.imageRequests.length, ...requests);
  }
  return kept;
}

/** The properties each stored `@keyframes` of a generation moves, by name. */
function keyframeProperties(nodes: GeneratedNodeSnapshot[]): Map<string, Set<string>> {
  const moved = new Map<string, Set<string>>();
  const read = (node: GeneratedNodeSnapshot): void => {
    for (const rule of storedRulesOf(node.props)) {
      if (!isDefinitionRule(rule) || !/^@keyframes /i.test(rule.define)) continue;
      const name = rule.define.split(/\s+/)[1];
      const properties = moved.get(name) ?? new Set<string>();
      for (const block of rule.blocks ?? []) Object.keys(block.style).forEach((key) => properties.add(key));
      moved.set(name, properties);
    }
    node.children.forEach(read);
  };
  nodes.forEach(read);
  return moved;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((entry, index) => entry === b[index]);

/**
 * Put an animation's start values behind the reduced-motion gate with it. Otherwise
 * `{opacity:0;animation:u-in 1s forwards}` leaves the content invisible for the very
 * visitor who asked for less motion, because the animation that reveals it never
 * runs. That takes what a keyframes of this generation moves and anything that hides
 * the node, from the rules with the same selector and, for `&`, from Normal: an honest
 * model writes the start value there as often as in the rule. Whatever a hover's
 * colour has to do with neither stays where it is.
 */
function gateStartValues(nodes: GeneratedNodeSnapshot[]): void {
  const moved = keyframeProperties(nodes);
  const visit = (node: GeneratedNodeSnapshot): void => {
    node.children.forEach(visit);
    const rules = storedRulesOf(node.props);
    const isGated = (rule: StoredRule): rule is SelectorRule => !isDefinitionRule(rule) && (rule.at ?? []).some(isReducedMotionGate);
    for (const gated of rules.filter(isGated)) {
      const motion = Object.keys(gated.style).filter(isMotionKey);
      if (motion.length === 0) continue;
      const moves = new Set(motion.flatMap((key) => storedKeyframesIn(gated.style[key])).flatMap((name) => [...(moved.get(name) ?? [])]));
      const take = (from: Record<string, unknown>, keys: string[]): void => {
        for (const key of keys) {
          gated.style[key] ??= from[key];
          delete from[key];
        }
      };
      const otherAt = (gated.at ?? []).filter((wrapper) => !isReducedMotionGate(wrapper));
      for (const rule of rules) {
        if (isDefinitionRule(rule) || rule === gated || rule.selector !== gated.selector || !sameList(rule.at ?? [], otherAt)) continue;
        take(rule.style, Object.keys(rule.style).filter((key) => moves.has(key) || hidesContent(key, rule.style[key])));
      }
      const normal = node.props.style;
      if (gated.selector === '&' && isPlainObject(normal)) {
        take(normal, Object.keys(normal).filter((key) => hidesContent(key, normal[key])));
        if (Object.keys(normal).length === 0) delete node.props.style;
      }
    }
    const left = rules.filter((rule) => isDefinitionRule(rule) || Object.keys(rule.style).length > 0);
    if (left.length !== rules.length) node.props[RULES_PROP] = left;
  };
  nodes.forEach(visit);
}

/** True for an address that loads from a host that is neither this site nor the stock library. */
function isForeignAddress(url: string, held: ReadonlySet<string>): boolean {
  return !url.startsWith('#') && !isSitePath(url) && !isUnsplashPhotoUrl(url) && !held.has(url);
}

/** The addresses a selected component holds, to pass as ValidateContext.heldAddresses. */
export function addressesHeldBy(context: unknown): Set<string> {
  const held = new Set<string>();
  const read = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (key === 'src') held.add(value.trim());
      for (const url of scanCssValue(value).urls) held.add(url);
    } else if (Array.isArray(value)) {
      value.forEach((entry) => read(entry));
    } else if (isPlainObject(value)) {
      for (const [name, entry] of Object.entries(value)) read(entry, name);
    }
  };
  read(context);
  return held;
}

/**
 * A rule can switch on what Normal holds, so a generation with both can report what a
 * visitor does to any host. The allow list in selectorProblem shuts the states, but
 * `&:hover` and a media condition remain, and a generated page needs no foreign host:
 * its photos are stock and its files are the site's. So with a rule kept, nothing
 * else loads from elsewhere. The address goes rather than the rule, because a brief
 * can name an address, and only the owner's own addresses are worth keeping.
 */
function dropForeignAddresses(nodes: GeneratedNodeSnapshot[], v: Validator, held: ReadonlySet<string>): void {
  const anyRule = (list: GeneratedNodeSnapshot[]): boolean => list.some((node) => storedRulesOf(node.props).length > 0 || anyRule(node.children));
  if (!anyRule(nodes)) return;
  const foreign = (value: unknown): boolean => typeof value === 'string' && scanCssValue(value).urls.some((url) => isForeignAddress(url, held));
  const visit = (node: GeneratedNodeSnapshot): void => {
    node.children.forEach(visit);
    const warn = (what: string) => v.warnings.push(`${node.label}: ${what} from another host beside a rule, dropped`);
    if (node.type === 'img' && typeof node.props.src === 'string' && isForeignAddress(node.props.src, held)) {
      warn('an image');
      node.props.src = PLACEHOLDER_IMAGE_SRC;
    }
    const style = node.props.style;
    if (!isPlainObject(style)) return;
    for (const [key, value] of Object.entries(style)) {
      if (isPlainObject(value)) {
        for (const [mapKey, entry] of Object.entries(value)) {
          if (!foreign(entry)) continue;
          warn(`style.${key}`);
          delete value[mapKey];
        }
        if (Object.keys(value).length === 0) delete style[key];
      } else if (foreign(value)) {
        warn(`style.${key}`);
        delete style[key];
      }
    }
  };
  nodes.forEach(visit);
}

/**
 * The sticky call to action's rules: only on a new page, at most one, with a
 * label and a safe link, as the last top-level node (it is a page-level bar,
 * never part of a section), and never from inside an svg (a foreignObject), which
 * would carry it out past the graphic. Extra or unusable bars are dropped with a warning.
 */
function placeStickyCta(nodes: GeneratedNodeSnapshot[], v: Validator, allowed: boolean): GeneratedNodeSnapshot[] {
  let kept: GeneratedNodeSnapshot | undefined;
  const drop = (node: GeneratedNodeSnapshot, reason: string) => {
    v.warnings.push(`${node.label}: ${reason}`);
    v.nodeCount -= countNodes(node);
  };
  const strip = (list: GeneratedNodeSnapshot[], inSvg: boolean): GeneratedNodeSnapshot[] => {
    const out: GeneratedNodeSnapshot[] = [];
    for (const node of list) {
      if (!isStickyCta(node.props)) {
        out.push(node.children.length > 0 ? { ...node, children: strip(node.children, inSvg || node.type === 'svg') } : node);
        continue;
      }
      if (inSvg) drop(node, 'a sticky call to action has no place inside an svg: dropped');
      else if (!allowed) drop(node, 'a sticky call to action belongs to a whole page, not a section: dropped');
      else if (typeof node.props.ctaLabel !== 'string' || typeof node.props.ctaHref !== 'string') {
        drop(node, 'the sticky call to action needs a ctaLabel and a ctaHref (https, mailto, tel, # or a site path): dropped');
      } else if (kept) drop(node, 'at most one sticky call to action per page: this one was dropped');
      else kept = node;
    }
    return out;
  };
  const rest = strip(nodes, false);
  if (!kept) return rest;
  const bar: GeneratedNodeSnapshot = { ...kept };
  delete bar.parentId;
  return [...rest, bar];
}

/**
 * Validate (and repair) one generation. `raw` is the model's tool input:
 * `{ title?, description?, nodes: Node[] }`.
 */
export function validateGeneration(raw: unknown, ctx: ValidateContext): ValidationOutcome {
  const v = new Validator(ctx);
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['output must be an object with a "nodes" array'], warnings: [] };
  }
  if (!Array.isArray(raw.nodes)) {
    return { ok: false, errors: ['output must contain a "nodes" array'], warnings: [] };
  }
  if (raw.nodes.length === 0) {
    return { ok: false, errors: ['"nodes" is empty: produce at least one node'], warnings: [] };
  }

  const size = JSON.stringify(raw)?.length ?? 0;
  if (size > GENERATION_LIMITS.maxGenerationChars) {
    return { ok: false, errors: [`output of ${size} characters exceeds the limit of ${GENERATION_LIMITS.maxGenerationChars}: produce a smaller page`], warnings: [] };
  }

  const parsed: GeneratedNodeSnapshot[] = [];
  raw.nodes.forEach((n, i) => parsed.push(...v.node(n, `nodes[${i}]`, 1)));
  // Decided before any svg is dropped: a page past the limit was cut short, and must not pass for being under it.
  const overLimit = v.nodeCount > GENERATION_LIMITS.maxNodes;
  const nodes = dropExpandingSvgs(scopeIds(placeStickyCta(parsed, v, ctx.allowStickyCta === true), v), v);
  gateStartValues(nodes);
  dropForeignAddresses(nodes, v, ctx.heldAddresses ?? new Set());

  if (overLimit) {
    v.errors.push(`${v.nodeCount} nodes exceed the limit of ${GENERATION_LIMITS.maxNodes}: produce a smaller page`);
  }
  if (v.errors.length === 0 && nodes.length === 0) {
    v.errors.push('nothing usable was left after removing disallowed nodes');
  }

  // Ids must be unique across the whole forest: MST does not refuse a
  // duplicate identifier inside one snapshot, but selection (safeReference)
  // and the history patches resolve nodes by id, so a duplicate would corrupt
  // the editor later instead of failing here.
  if (v.errors.length === 0) {
    const seen = new Set<string>();
    const walk = (n: GeneratedNodeSnapshot): void => {
      if (seen.has(n.id)) v.errors.push(`duplicate node id "${n.id}"`);
      seen.add(n.id);
      n.children.forEach(walk);
    };
    nodes.forEach(walk);
  }

  // Final gate: MobX-State-Tree must accept every snapshot as-is.
  if (v.errors.length === 0) {
    nodes.forEach((node, i) => {
      try {
        ComponentModel.create(node);
      } catch (err) {
        v.errors.push(`nodes[${i}]: rejected by the editor model (${err instanceof Error ? err.message.split('\n')[0] : 'invalid snapshot'})`);
      }
    });
  }

  if (v.errors.length > 0) return { ok: false, errors: v.errors, warnings: v.warnings };

  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : undefined;
  const description =
    typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim().slice(0, 300) : undefined;

  return {
    ok: true,
    result: {
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      nodes,
      warnings: v.warnings,
      stats: { nodeCount: v.nodeCount, maxDepth: v.maxDepth },
      imageRequests: v.imageRequests,
      invalidImageQueries: v.invalidImageQueries,
    },
  };
}
