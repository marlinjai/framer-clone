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
/** The prop that holds the stored scene. Never a DOM attribute (but see isFxSceneProp). */
export const FX_PROP = 'fx';

/**
 * Whether `name` on a node of this tag is the FX scene prop.
 *
 * `fx` is also a real attribute, on exactly one element: the focal point of an SVG
 * `radialGradient`. There it is that attribute and nothing else, and everywhere
 * else it is scene data. Every place that keeps `fx` off the page, out of the
 * Custom section, out of bindings or out of site operations asks this, so a
 * gradient keeps its focal point. (The first version asked only for the name, and
 * the score caught the gradients losing theirs.)
 */
export function isFxSceneProp(name: string, type: unknown): boolean {
  return name === FX_PROP && !(typeof type === 'string' && type.toLowerCase() === 'radialgradient');
}

/**
 * True when the node is an FX scene box. The marker counts on a `div` only: on
 * any other tag (a link, a button, a form part) it is an attribute and nothing
 * more. `type` may be left out by a caller that already knows the tag.
 */
export function isFxScene(props: unknown, type: unknown = 'div'): boolean {
  return type === 'div' && !!props && typeof props === 'object' && !Array.isArray(props) && (props as Record<string, unknown>)[FX_ATTR] === FX_MARKER;
}

/**
 * Written by the published page, never stored: `data-fc-fx` carries the index
 * of a box's scene in the page's FX program (applyFx), `data-fc-fx-state` says
 * what the island is doing with it (FX_STATES), and `data-fc-fx-layer` marks
 * the layer the scene is drawn in. applyFx drops every `data-fc-fx` name from
 * every stored node, so a node cannot pose as a scene the page drew.
 */
export const FX_INDEX_ATTR = 'data-fc-fx';
export const FX_STATE_ATTR = 'data-fc-fx-state';
export const FX_LAYER_ATTR = 'data-fc-fx-layer';

/** True for an attribute only the published page may write: `data-fc-fx` and every `data-fc-fx-*`. */
export function isFxIssuedAttribute(name: string): boolean {
  return /^data-fc-fx(?:-|$)/i.test(name);
}

/**
 * What the island reports on a box, in `data-fc-fx-state`:
 *  - `waiting`: the scene will start (after the page settled, or when the box comes near);
 *  - `loading`: the engine is being fetched and set up;
 *  - `live`: the first frame is drawn and the scene is shown;
 *  - `calm`: nothing is drawn on purpose (reduced motion with the background as the
 *    calm state, or a second scene on a page, which keeps to one WebGL context);
 *  - `off`: the scene cannot be drawn here (no WebGL, the engine did not arrive, the
 *    scene was refused, the context was lost). The box shows what the server sent.
 */
export const FX_STATES = ['waiting', 'loading', 'live', 'calm', 'off'] as const;
export type FxState = (typeof FX_STATES)[number];
