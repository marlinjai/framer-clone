// src/lib/fxScene/box.ts
//
// How the layer an FX scene is drawn in sits in its box, for every surface that
// draws one: the published page (./mount), the editor's canvas and its preview
// (src/components/fx/FxLayer.tsx). One description, so the three cannot drift.
//
// The layer is a child of the box: absolutely placed over the whole box, BEHIND the
// box's content, taking no pointer and hidden from assistive technology. It starts
// transparent and fades in once the first frame is drawn. A negative z-index puts
// it behind the content only inside a stacking context of the box's own (or it
// would slip behind the box's background and the page), and a box left
// `position: static` would not contain it at all: holdFxBox sees to both.
//
// No engine code, no imports.

/** The fade once the first frame is drawn: the ceiling for interface motion. */
export const FX_FADE_MS = 300;

/** The layer's own style, as CSS property names. */
export const FX_LAYER_STYLE = {
  position: 'absolute',
  inset: '0',
  zIndex: '-1',
  overflow: 'hidden',
  pointerEvents: 'none',
  opacity: '0',
  transition: `opacity ${FX_FADE_MS}ms ease-out`,
  borderRadius: 'inherit',
} as const;

/**
 * Make `box` hold a layer: a stacking context of its own, and a position when it has
 * none. Returns the undo. `positionIsOwned` says, at the time of the undo, that
 * something else has set the box's inline position since (the editor's renderer,
 * after the author gave the box a position): then it is left alone.
 */
export function holdFxBox(box: HTMLElement): (positionIsOwned?: boolean) => void {
  const before = { isolation: box.style.isolation, position: box.style.position };
  box.style.isolation = 'isolate';
  const positioned = getComputedStyle(box).position === 'static';
  if (positioned) box.style.position = 'relative';
  return (positionIsOwned = false) => {
    box.style.isolation = before.isolation;
    if (positioned && !positionIsOwned) box.style.position = before.position;
  };
}
