// What no stored node may put on a page: both renderers drop it, so existing
// rows and every write path are covered. A page snapshot is opaque JSON to the
// save and publish routes (src/app/api/projects/_schema.ts), so the render step
// is the one place all of it passes through. The editor never produces these;
// see docs/plans/2026-11-01-complete-primitives.md for the custom code primitive
// that would be the deliberate way to run code on a site.

export const BLOCKED_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'link', 'meta',
]);

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
  return name === 'dangerouslySetInnerHTML' || (/^on[A-Z]/.test(name) && typeof value !== 'function');
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
 * React either drops or throws on.
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
