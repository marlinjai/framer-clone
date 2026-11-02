// What no stored node may put on a page: both renderers drop it, so existing
// rows and every write path are covered. A page snapshot is opaque JSON to the
// save and publish routes (src/app/api/projects/_schema.ts), so the render step
// is the one place all of it passes through. The editor never produces these;
// see docs/plans/2026-11-01-complete-primitives.md for the custom code primitive
// that would be the deliberate way to run code on a site.

export const BLOCKED_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link', 'meta',
  // Browser permission buttons: a grant stays with the origin, which on the
  // canvas is the signed-in editor.
  'geolocation', 'camera', 'microphone', 'usermedia', 'install', 'model',
]);

// SVG animation can write a `javascript:` address into a link or a handler, so
// it is judged by the attribute it targets, not by the value it sets.
const ANIMATION_TARGET_BLOCKED = /^(?:(?:xlink:)?href$|on)/i;

// React only blocks `javascript:` under the exact spelling of a known attribute,
// so a stored `HREF` or `FORMACTION` reaches the markup. Browsers skip tabs,
// newlines and spaces inside a scheme, so those are removed before reading it.
const DESTINATION_ATTRIBUTES: ReadonlySet<string> = new Set([
  'href', 'xlink:href', 'xlinkhref', 'src', 'action', 'formaction', 'data', 'poster', 'cite', 'background',
]);
const SCRIPT_SCHEME = /^(?:javascript:|vbscript:|data:text\/html)/i;

function isScriptDestination(name: string, value: unknown): boolean {
  if (typeof value !== 'string' || !DESTINATION_ATTRIBUTES.has(name.toLowerCase())) return false;
   
  return SCRIPT_SCHEME.test(value.replace(/[\u0000-\u0020\u007f]/g, ''));
}

const warned = new Set<string>();

function warnOnce(what: string): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[renderer] dropped ${what} from a stored node`);
}

/**
 * The rule alone, without the warning: for the properties panel, which refuses
 * a prop before it is ever stored rather than dropping one that was.
 */
export function isDroppedProp(name: string, value: unknown): boolean {
  if (name === 'dangerouslySetInnerHTML') return true;
  // What expansion records on a placement root for hydration. A string stays the
  // plain attribute it has always been.
  if (name === 'instance' && typeof value === 'object') return true;
  if (/^on/i.test(name)) return typeof value !== 'function';
  if (isScriptDestination(name, value)) return true;
  return name.toLowerCase() === 'attributename' && typeof value === 'string' && ANIMATION_TARGET_BLOCKED.test(value.trim());
}

/** Whether a node with this resolved tag must render nothing. */
export function isBlockedTag(tag: unknown): boolean {
  if (typeof tag !== 'string' || !BLOCKED_TAGS.has(tag.toLowerCase())) return false;
  warnOnce(`<${tag.toLowerCase()}>`);
  return true;
}

/**
 * Whether a prop must not reach the DOM. An event handler is only legitimate as
 * a function (the editor attaches its own); a stored one is a string, which
 * React drops or throws on for a known element but writes straight into the
 * markup of a custom element (`<x-y onclick="...">`), in any letter case.
 */
export function isBlockedProp(name: string, value: unknown): boolean {
  const blocked = isDroppedProp(name, value);
  if (blocked) warnOnce(`the prop ${name}`);
  return blocked;
}

/** `props` without its blocked keys; the same object when there are none. */
export function withoutBlockedProps(props: Record<string, unknown>): Record<string, unknown> {
  const names = Object.keys(props);
  if (!names.some((name) => isBlockedProp(name, props[name]))) return props;
  return Object.fromEntries(names.filter((name) => !isBlockedProp(name, props[name])).map((name) => [name, props[name]]));
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
