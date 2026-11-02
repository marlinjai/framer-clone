// The render gate: what no stored node may put on a page. Both renderers drop it,
// so existing rows and every write path are covered. A page snapshot is opaque JSON to the
// save and publish routes (src/app/api/projects/_schema.ts), so the render step
// is the one place all of it passes through. The editor never produces these;
// see docs/plans/2026-11-01-complete-primitives.md for the custom code primitive
// that would be the deliberate way to run code on a site.
//
// Names are refused by default (./renderVocabulary.ts). Then values: an address
// must have a scheme a browser only follows, and a stored string or array is never
// a handler. test/renderGate tries all of it in real browsers.

import { REVIEWED_ANIMATED_ATTRIBUTES } from '@/lib/ai/pageGen/reviewedVocabulary';
import { FORM_CONFIG_PROPS } from '@/lib/forms/definition';
import { DOM_MEMBER_NAMES } from '@/lib/renderer/domMemberNames.generated';
import { isRenderedAttribute, isRenderedTag } from '@/lib/renderer/renderVocabulary';
import { TEXT_NODE_TYPE } from '@/lib/renderer/textNode';
import { STICKY_CTA_PROP_KEYS } from '@/lib/stickyCta/stickyCta';
import { SAFE_PROPERTY, UNSAFE_VALUE, cssValueText, isContainedValue } from '@/lib/responsive/responsiveCss';

/**
 * Refused by name, whatever the vocabulary says: both renderers and the score's
 * gap text read this. Anything else off the page is refused by not being listed
 * in ./renderVocabulary.ts.
 */
export const BLOCKED_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'fencedframe', 'base', 'link', 'meta',
  // Browser permission buttons: a grant stays with the origin, which on the
  // canvas is the signed-in editor.
  'geolocation', 'camera', 'microphone', 'usermedia', 'install', 'model',
]);

// What an address may be, wherever it stands: a browser follows these and nothing
// else. Refused by default for the same reason as the names: `javascript:` was
// found three times under other spellings, and the next scheme would not be.
const ADDRESS_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href', 'xlink:href', 'xlinkhref', 'src', 'action', 'formaction', 'poster', 'cite',
]);
const ADDRESS_SCHEMES: ReadonlySet<string> = new Set(['http', 'https', 'mailto', 'tel', 'sms']);
const MEDIA_DATA = /^data:(?:image|audio|video|font)\//i;

/**
 * The scheme as a browser reads it, which ignores spaces and control characters
 * around and inside it. An address with no scheme is a path or a fragment. Not
 * isSafeHref: that rule also judges how a link looks to a visitor, and a stored
 * page keeps what that refuses as long as it cannot act.
 */
function isSafeAddress(address: string): boolean {
  const text = address.replace(/[\u0000-\u0020\u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  return scheme === undefined || ADDRESS_SCHEMES.has(scheme) || MEDIA_DATA.test(text);
}

/**
 * Names that replace what a page's own code calls. An `img` or a `form` with a
 * `name` becomes a property of `document`: `name="createElement"` stopped every
 * island on a page. Any `id` becomes a global, which is how `__next_f` and
 * `webpackChunk_N_E` stopped hydration. A member's name stays open as an ordinary
 * `id` (`title`, `links`), except on an `img`, see withoutDocumentId.
 */
const DOM_MEMBERS: ReadonlySet<string> = new Set(DOM_MEMBER_NAMES);
const RESERVED_ID = /^__|^webpackChunk|^fc-|^ground-wrapper-/;

/** Attributes read as CSS. A reference inside the page is how SVG paints, any other reaches a file. */
const CSS_REFERENCE_ATTRIBUTES: ReadonlySet<string> = new Set([
  'fill', 'stroke', 'filter', 'mask', 'cursor', 'clip-path', 'clippath', 'marker-start', 'markerstart',
  'marker-mid', 'markermid', 'marker-end', 'markerend',
]);

function isForeignReference(value: string): boolean {
  if (/\\|image-set\(|\bsrc\(/i.test(value)) return true;
  return [...value.matchAll(/url\(\s*['"]?\s*([^'")\s]*)/gi)].some((match) => !match[1].startsWith('#'));
}

/** Addresses, sizes and the commas between them: a data address's own comma only splits off its payload. */
const isSafeSrcset = (value: string): boolean => value.split(/[\s,]+/).every(isSafeAddress);

const warned = new Set<string>();
const MAX_WARNINGS = 200;

function warnOnce(what: string): void {
  if (warned.has(what) || warned.size >= MAX_WARNINGS) return;
  warned.add(what);
  console.warn(`[renderer] dropped ${what} from a stored node`);
}

/** Names that take more than a scalar: an object anywhere else would be written out with `toString`. */
const OBJECT_PROPS: ReadonlySet<string> = new Set(['children', 'style']);

function isUnsafeValue(name: string, value: unknown): boolean {
  if (typeof value === 'object' && value !== null) {
    // An array is the dangerous case: `['javascript:x']` reads as a string to React.
    return !OBJECT_PROPS.has(name) || (name === 'style' && Array.isArray(value));
  }
  if (name === 'style') return value !== undefined && value !== null;
  if (name === 'ref') return value !== undefined && value !== null;
  if (typeof value !== 'string') return false;
  if (name === 'attributename') return !REVIEWED_ANIMATED_ATTRIBUTES.has(value);
  if (name === 'id') return RESERVED_ID.test(value);
  if (name === 'name') return DOM_MEMBERS.has(value);
  if (CSS_REFERENCE_ATTRIBUTES.has(name)) return isForeignReference(value);
  if (name === 'srcset') return !isSafeSrcset(value);
  return ADDRESS_ATTRIBUTES.has(name) && !isSafeAddress(value);
}

/**
 * The rule alone, without the warning: for the properties panel, which refuses
 * a prop before it is stored rather than dropping one that was. A function is the
 * editor's own (JSON cannot store one), so only raw HTML is refused in that form.
 */
export function isDroppedProp(name: string, value: unknown): boolean {
  if (name === 'dangerouslySetInnerHTML') return true;
  if (typeof value === 'function') return false;
  const lower = name.toLowerCase();
  return !isRenderedAttribute(lower) || isUnsafeValue(lower, value);
}

/** The rule alone, for the panel: whether a node with this tag renders nothing. */
export function isRefusedTag(tag: string): boolean {
  // Exact: both renderers return a text node before any tag rule.
  if (tag === TEXT_NODE_TYPE) return false;
  return BLOCKED_TAGS.has(tag.toLowerCase()) || !isRenderedTag(tag);
}

/**
 * Whether a node with this resolved tag must render nothing. `title` is an SVG name
 * in the vocabulary. Anywhere else it is the document's, and React lifts it to `head`,
 * so a node could rename the tab.
 */
export function isBlockedTag(tag: unknown, insideSvg = false): boolean {
  if (typeof tag !== 'string') return false;
  const documentTitle = tag.toLowerCase() === 'title' && !insideSvg;
  if (!documentTitle && !isRefusedTag(tag)) return false;
  warnOnce(`<${tag.toLowerCase()}>`);
  return true;
}

const NODE_SETTINGS: ReadonlySet<string> = new Set(['query', 'bindings', 'effects', 'rules', 'behaviour', 'instance', 'fieldName']);

/** Settings the renderers read from the node. Off the element, as they should be, so nothing to report. */
const isSettingsProp = (name: string): boolean =>
  FORM_CONFIG_PROPS.has(name) || (STICKY_CTA_PROP_KEYS as readonly string[]).includes(name) || NODE_SETTINGS.has(name);

/**
 * Whether a prop must not reach the DOM. React drops some of this for a known
 * element, but it writes a stored handler straight into the markup of a custom
 * element, sets anything a custom element has as a property (`innerHTML`) under
 * client rendering, and throws on some of the rest.
 */
export function isBlockedProp(name: string, value: unknown): boolean {
  const blocked = isDroppedProp(name, value);
  if (blocked && !isSettingsProp(name)) warnOnce(`the prop ${name}`);
  return blocked;
}

/**
 * Whether a declaration could do more than set its property from inside a `style`
 * attribute. Narrower than the sheet's rule, which also guards `{`, `}` and `<`:
 * React escapes an attribute and a declaration list has no rule to leave, and
 * applyResponsiveStyles leaves here on purpose what the sheet refuses. What counts
 * here is `;`, which starts a second declaration, and a comment outside a string,
 * which hides one from isContainedValue.
 */
function isUnsafeInline(key: string, value: unknown): boolean {
  if (typeof value === 'object' && value !== null) return true;
  if (!SAFE_PROPERTY.test(key)) return true;
  const text = cssValueText(key, value);
  if (text === undefined) return false;
  return !isContainedValue(text) || UNSAFE_VALUE.test(text.replaceAll('/*', '')) || text.replace(/"[^"]*"|'[^']*'/g, '').includes('/*');
}

/**
 * An inline style without what could act, the same object when nothing goes:
 * `red;background:url(...)` is two declarations in an attribute. `https` in a url()
 * stays, as in the sheet: a stored style may show an image.
 */
export function safeInlineStyle(style: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(style);
  if (!keys.some((key) => isUnsafeInline(key, style[key]))) return style;
  warnOnce('an unsafe style declaration');
  return Object.fromEntries(keys.filter((key) => !isUnsafeInline(key, style[key])).map((key) => [key, style[key]]));
}

/** An `img` with a `name` also puts its `id` on `document`, and only that element does. */
export function withoutDocumentId(tag: unknown, props: Record<string, unknown>): Record<string, unknown> {
  if (typeof tag !== 'string' || tag.toLowerCase() !== 'img' || typeof props.id !== 'string' || !DOM_MEMBERS.has(props.id)) return props;
  const { id, ...rest } = props;
  warnOnce(`the id ${id}`);
  return rest;
}

/** `props` without its blocked keys and unsafe style; the same object when there are none. */
export function withoutBlockedProps(props: Record<string, unknown>): Record<string, unknown> {
  const names = Object.keys(props);
  const kept = names.filter((name) => !isBlockedProp(name, props[name]));
  const style = props.style && typeof props.style === 'object' && kept.includes('style')
    ? safeInlineStyle(props.style as Record<string, unknown>)
    : props.style;
  if (kept.length === names.length && style === props.style) return props;
  return Object.fromEntries(kept.map((name) => [name, name === 'style' ? style : props[name]]));
}

// The canvas and the preview run on the signed-in editor's origin, so a stored
// page must not be able to draw over the editor or send anything from it: a
// popover sits in the top layer above every panel, and a form inside it is a
// convincing "sign in again". These stay on the published page, which is the
// site's own origin.
const EDITOR_SURFACE_DROPPED: ReadonlySet<string> = new Set([
  'popover', 'popovertarget', 'popovertargetaction', 'command', 'commandfor',
  'action', 'formaction', 'formtarget', 'ping',
]);

/** `props` as the editor surfaces render them; the same object when nothing is dropped. */
export function withoutEditorSurfaceProps(props: Record<string, unknown>): Record<string, unknown> {
  const names = Object.keys(props);
  if (!names.some((name) => EDITOR_SURFACE_DROPPED.has(name.toLowerCase()))) return props;
  return Object.fromEntries(
    names.filter((name) => !EDITOR_SURFACE_DROPPED.has(name.toLowerCase())).map((name) => [name, props[name]]),
  );
}

/** A form on an editor surface never submits: with no action it would reload the editor. */
export function refuseSubmit(event: { preventDefault(): void }): void {
  event.preventDefault();
}
