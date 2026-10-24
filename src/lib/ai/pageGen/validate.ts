// src/lib/ai/pageGen/validate.ts
//
// Repair-or-reject for model output. The page generator NEVER applies what the
// model sent as-is: every node is rebuilt from the rules in ./schema.ts.
//
//   Repaired (with a warning the user can see):
//     - unknown style keys dropped (kebab-case keys converted first),
//     - unsafe or malformed style values, links and image sources dropped,
//     - props outside the per-tag allowlist dropped (handlers, raw HTML, ...),
//     - a registry id used as `type` turned into its preset, a preset whose
//       type disagrees with `type` wins, an unknown tag becomes a `div`,
//     - forbidden tags (script, iframe, form, ...) dropped with their subtree,
//     - text AND children on one node: the text becomes a leading text child,
//     - children on a void tag dropped, missing labels and alt text filled,
//     - an img with an aspectRatio but no height of its own gets height
//       "auto" (the Image preset's fixed height would otherwise win),
//     - an images.unsplash.com photo (img src or a container's background
//       url() layer) without its complete credit dropped,
//     - a fontFamily outside the self-hosted font library (Inter, Geist, an
//       unhosted font) replaced by the library default of its category; a
//       library family gets its canonical fallback stack (src/lib/fonts),
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
import ComponentModel, { ComponentTypeEnum, CSS_PROP_SET } from '@/models/ComponentModel';
import { isVoidTag } from '@/lib/drag/voidTags';
import { formPropKeysFor, presetFormKind, sanitizeGeneratedFormProps } from '@/lib/forms/generation';
import {
  BASE_KEY,
  FORBIDDEN_TAGS,
  GENERATION_LIMITS,
  IMAGE_QUERY_PROP,
  PHOTO_BACKGROUND_TAGS,
  PLACEHOLDER_IMAGE_SRC,
  allowedPropKeysFor,
  getGenerationPreset,
  isSafeHref,
  isSafeSrc,
  listGenerationTags,
  type BreakpointKey,
  type GenerationPreset,
} from './schema';
import { EFFECTS_PROP, cleanGeneratedEffects } from './promptSections/effects';

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
}

/** Keys the model may send that we silently ignore because the editor owns them. */
const OWNED_KEYS = new Set(['id', 'componentType', 'canvasNodeType', 'parentId']);
const NODE_KEYS = new Set(['type', 'preset', 'label', 'props', 'children']);

export const UNSAFE_STYLE_VALUE = /javascript:|vbscript:|expression\s*\(|<\s*\/?\s*script|@import|behavior\s*:|-moz-binding/i;
/**
 * Characters that let one style value escape into more CSS when a renderer or
 * the publish path serializes styles to text: `;` ends the declaration (and
 * starts another, e.g. "red;position:fixed;inset:0"), `{` `}` open or close
 * rules, a backslash starts a CSS escape ("\75 rl(" reads as "url("), and
 * control characters (newlines included) can break out of a declaration or
 * hide content. No legitimate generated value needs any of them.
 */
export const STYLE_BREAKOUT_CHARS = /[;{}\\\u0000-\u001f\u007f]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function kebabToCamel(key: string): string {
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
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

function isUnsplashPhotoUrl(value: string): boolean {
  try {
    return new URL(value).hostname === 'images.unsplash.com';
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

class Validator {
  readonly warnings: string[] = [];
  readonly errors: string[] = [];
  readonly imageRequests: ImageRequest[] = [];
  invalidImageQueries = 0;
  nodeCount = 0;
  /** Appear effects accepted so far (capped: motion is used sparingly). */
  appearCount = 0;
  maxDepth = 0;
  private readonly tags = new Set(listGenerationTags());
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

  private warn(path: string, message: string): void {
    this.warnings.push(`${path}: ${message}`);
  }

  private fail(path: string, message: string): void {
    this.errors.push(`${path}: ${message}`);
  }

  /** Validate a style value or a responsive map; returns undefined to drop it. */
  private styleValue(path: string, key: string, raw: unknown): unknown {
    if (isPlainObject(raw)) {
      const out: Record<string, string | number> = {};
      for (const [mapKey, v] of Object.entries(raw)) {
        const lower = mapKey.trim().toLowerCase();
        const canonical = lower === BASE_KEY ? BASE_KEY : this.bpKeys.get(lower);
        if (!canonical) {
          this.warn(path, `style.${key}: unknown breakpoint key "${mapKey}" dropped`);
          continue;
        }
        const scalar = this.scalarStyleValue(path, `${key}.${mapKey}`, v);
        if (scalar !== undefined) out[canonical] = scalar;
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
    return this.scalarStyleValue(path, key, raw);
  }

  private scalarStyleValue(path: string, key: string, raw: unknown): string | number | undefined {
    if (typeof raw === 'number') {
      if (Number.isFinite(raw)) return raw;
      this.warn(path, `style.${key}: non-finite number dropped`);
      return undefined;
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
    if (STYLE_BREAKOUT_CHARS.test(raw)) {
      this.warn(path, `style.${key}: value contains ; { } \\ or a control character, dropped`);
      return undefined;
    }
    if (UNSAFE_STYLE_VALUE.test(v)) {
      this.warn(path, `style.${key}: unsafe value dropped`);
      return undefined;
    }
    // url(...) only to http(s) or site paths, never data: or other schemes.
    const urls = [...v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((m) => m[2]);
    if (urls.some((u) => !isSafeSrc(u))) {
      this.warn(path, `style.${key}: url() to a disallowed location dropped`);
      return undefined;
    }
    // Font families: library families keep their canonical stack, system
    // stacks stay, anything else (Inter, Geist, a font this app does not host)
    // becomes the library default of its category (src/lib/fonts/registry.ts).
    if (key === 'fontFamily' || key.startsWith('fontFamily.')) {
      const font = normalizeFontFamily(v);
      if (font.reason) {
        this.warn(path, `style.${key}: ${font.reason}`);
      }
      return font.value;
    }
    return v;
  }

  private style(path: string, raw: unknown): Record<string, unknown> {
    if (raw === undefined) return {};
    if (!isPlainObject(raw)) {
      this.warn(path, 'props.style must be an object, dropped');
      return {};
    }
    const out: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(raw)) {
      const key = CSS_PROP_SET.has(rawKey) ? rawKey : kebabToCamel(rawKey);
      if (!CSS_PROP_SET.has(key)) {
        this.warn(path, `style key "${rawKey}" is not supported by the editor, dropped`);
        continue;
      }
      const value = this.styleValue(path, key, rawValue);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  /** Resolve type + preset. Returns null when the node must be dropped. */
  private resolveType(
    path: string,
    rawType: unknown,
    rawPreset: unknown,
  ): { type: string; preset?: GenerationPreset } | null {
    let preset: GenerationPreset | undefined;
    if (rawPreset !== undefined) {
      preset = typeof rawPreset === 'string' ? getGenerationPreset(rawPreset) : undefined;
      if (!preset) this.warn(path, `unknown preset ${JSON.stringify(rawPreset)} ignored`);
    }
    let type = typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
    if (!preset && type) {
      // The model used a registry id ("card", "stack") as the tag.
      const asPreset = getGenerationPreset(typeof rawType === 'string' ? rawType.trim() : '');
      if (asPreset && !this.tags.has(type)) {
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
    if (!type) {
      this.warn(path, 'missing type, using "div"');
      type = 'div';
    } else if (!this.tags.has(type)) {
      this.warn(path, `tag "${type}" is not available in the editor, using "div"`);
      type = 'div';
    }
    return { type, preset };
  }

  node(raw: unknown, path: string, depth: number, parentId?: string): GeneratedNodeSnapshot[] {
    if (!isPlainObject(raw)) {
      this.fail(path, 'node must be an object');
      return [];
    }
    if (depth > GENERATION_LIMITS.maxDepth) {
      this.fail(path, `nesting deeper than ${GENERATION_LIMITS.maxDepth} levels`);
      return [];
    }
    for (const key of Object.keys(raw)) {
      if (!NODE_KEYS.has(key) && !OWNED_KEYS.has(key)) this.warn(path, `unknown key "${key}" ignored`);
    }

    const resolved = this.resolveType(path, raw.type, raw.preset);
    if (!resolved) return [];
    const { type, preset } = resolved;
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
    const props: Record<string, unknown> = {};
    let text: string | undefined;
    let imageQuery: string | undefined;
    let invalidQuery = false;
    let rawEffects: unknown;

    // An Unsplash photo's credit (an earlier generation's image or background,
    // sent back in replace / insert context) is read separately below, never
    // warned about. Containers never carry the hover title (see stockCredit.ts).
    const isPhotoContainer = PHOTO_BACKGROUND_TAGS.has(type);
    const creditKeys = new Set<string>(
      type === 'img' ? ['title', ...STOCK_CREDIT_ATTRS] : isPhotoContainer ? STOCK_CREDIT_ATTRS : [],
    );
    for (const [key, value] of Object.entries(modelProps)) {
      if (key === 'style' || creditKeys.has(key)) continue;
      if (key === EFFECTS_PROP) {
        // Cleaned after the children are known (stagger needs two of them).
        rawEffects = value;
        continue;
      }
      if (formKeys.has(key)) {
        formProps[key] = value;
        continue;
      }
      if (!allowed.has(key)) {
        this.warn(path, `prop "${key}" is not allowed on <${type}>, dropped`);
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
    const modelStyle = this.style(path, modelProps.style);
    const style: Record<string, unknown> = { ...presetStyle, ...modelStyle };
    if (type === 'img' && modelStyle.aspectRatio !== undefined && modelStyle.height === undefined) {
      // The shape comes from the aspect ratio: a preset's fixed height would override it.
      style.height = 'auto';
    }
    const merged: Record<string, unknown> = {
      ...presetDefaults,
      ...props,
      ...sanitizeGeneratedFormProps(presetDefaults, formProps, (m) => this.warn(path, m)),
    };
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
      if (typeof merged.alt !== 'string' || merged.alt.trim() === '') {
        merged.alt = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : 'Image';
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

    const children: GeneratedNodeSnapshot[] = [];
    if (isVoidTag(type)) {
      if (rawChildren.length > 0) this.warn(path, `<${type}> cannot have children, ${rawChildren.length} dropped`);
      if (text !== undefined) this.warn(path, `<${type}> cannot have text, dropped`);
      text = undefined;
    } else if (rawChildren.length > 0 && ['form-field', 'form-submit'].includes(presetFormKind(presetDefaults) ?? '')) {
      this.warn(path, `form component "${preset?.id}" renders its own content, children dropped`);
    } else if (preset?.dataComponentKind && rawChildren.length > 0) {
      this.warn(path, `data component "${preset.id}" renders its own content, children dropped`);
    } else {
      if (text !== undefined && rawChildren.length > 0) {
        // Both text and children: keep both by turning the text into a leading child.
        this.warn(path, 'node had text and children, text moved into a leading text node');
        rawChildren = [{ type: 'p', preset: 'text', label: 'Text', props: { children: text } }, ...rawChildren];
        text = undefined;
      }
      rawChildren.forEach((child, i) => {
        children.push(...this.node(child, `${path}.children[${i}]`, depth + 1, id));
      });
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

  const nodes: GeneratedNodeSnapshot[] = [];
  raw.nodes.forEach((n, i) => nodes.push(...v.node(n, `nodes[${i}]`, 1)));

  if (v.nodeCount > GENERATION_LIMITS.maxNodes) {
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
