// The attributes the editor and the renderers read as instructions: one list, for every
// door that takes markup or CSS from someone else. A source may not set one, since an
// island's marker turns a `div` into a form and an editor mark makes a node the target of
// a click. A stored rule may not read one either: the canvas wraps content in
// `[data-ground]` and a published page does not, so `&:is([data-ground] *)` would show a
// person one thing in the editor and every visitor another.
//
// The names outside these families are the ones `platformAttributes.test.ts` finds read
// in `src`, so a new one fails there until it is judged here.

const PLATFORM_FAMILY = /^data-(?:fc|fcs|fx|u|island|component|inner-component|form|sticky|repeat|ground|viewport|breakpoint|floating-root|preview|editor|camera|lenis)(?:-|$)/i;

const PLATFORM_NAMES: ReadonlySet<string> = new Set([
  'data-add-line', 'data-discard-row', 'data-drag-handle', 'data-escape-local', 'data-focus-key', 'data-haptics', 'data-import-all',
  'data-import-row', 'data-layer-breakpoint', 'data-layer-row', 'data-logo-choose', 'data-menu-item', 'data-notice-action',
  'data-outline-select', 'data-page-overlay', 'data-page-settings-button', 'data-pan-cursor', 'data-placement', 'data-placement-root', 'data-pointer',
  'data-radius-corner', 'data-resize-direction', 'data-resume-offer', 'data-shown', 'data-spacing-band', 'data-spacing-handle', 'data-text-node-row',
]);

/** An attribute the platform reads as an instruction, in any case. A source may not set it. */
export const isPlatformAttribute = (name: string): boolean => PLATFORM_FAMILY.test(name) || PLATFORM_NAMES.has(name.toLowerCase());

/**
 * `data-u-*` is the one family a rule is meant to read. The platform writes it from stored data, the same on
 * the canvas and the page: a behaviour's `data-u-on`, a bound `data-u-*`, a variant's `data-u-v-*`.
 */
const AUTHOR_READABLE = /^data-u-/i;

/** An attribute a stored rule may not name in a selector, in any case. */
export const isPlatformMarker = (name: string): boolean => isPlatformAttribute(name) && !AUTHOR_READABLE.test(name);
