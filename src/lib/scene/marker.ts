// src/lib/scene/marker.ts
//
// What marks a 3D scene box, and nothing else: the names and the one test.
// Kept apart from format.ts so the renderers' prop gates and the site operations
// need only these names, and none of the format's code ends up in the client
// code of a published page. This file imports nothing.
//
// Terminology (decided in slice S1 of docs/plans/2026-11-02-3d-scene-primitive.md):
// a "3D scene" is this primitive, a three.js scene described as data. It is not an
// "FX scene" (a visual effects scene, src/lib/fxScene, the WebGL effects engine's
// background layer). The two never share a prop, a marker or a panel: FX uses the
// prop `fx` and the marker `data-fx="scene"`, this uses the prop `scene` and the
// marker `data-scene="three"`. Editor and generator wording says "3D scene" for
// this and "visual effect" or "FX scene" for the other, never a bare "scene".

/** The marker prop (and DOM attribute) of a 3D scene box. */
export const SCENE_ATTR = 'data-scene';
export const SCENE_MARKER = 'three';
/** The prop that holds the stored 3D scene description. Never a DOM attribute. */
export const SCENE_PROP = 'scene';

/**
 * True when the node is a 3D scene box. The marker counts on a `div` only: on any
 * other tag it is an attribute and nothing more. `type` may be left out by a
 * caller that already knows the tag.
 */
export function isScene3d(props: unknown, type: unknown = 'div'): boolean {
  return type === 'div' && !!props && typeof props === 'object' && !Array.isArray(props) && (props as Record<string, unknown>)[SCENE_ATTR] === SCENE_MARKER;
}
