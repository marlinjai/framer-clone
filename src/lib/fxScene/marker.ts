// src/lib/fxScene/marker.ts
//
// What marks an FX scene box, and nothing else: the names and the one test.
// Kept apart from fxScene.ts on purpose. The renderers' prop gates, the bindings
// resolver and the site operations need only these names, and some of them end
// up in the client code of a published page; fxScene.ts imports the engine's
// format (layer schemas, presets), which a page without an FX scene must not
// carry. This file imports nothing.

/** The marker prop (and DOM attribute) of an FX scene box. */
export const FX_ATTR = 'data-fx';
export const FX_MARKER = 'scene';
/** The prop that holds the stored scene. Never a DOM attribute. */
export const FX_PROP = 'fx';

/**
 * True when the node is an FX scene box. The marker counts on a `div` only: on
 * any other tag (a link, a button, a form part) it is an attribute and nothing
 * more. `type` may be left out by a caller that already knows the tag.
 */
export function isFxScene(props: unknown, type: unknown = 'div'): boolean {
  return type === 'div' && !!props && typeof props === 'object' && !Array.isArray(props) && (props as Record<string, unknown>)[FX_ATTR] === FX_MARKER;
}
