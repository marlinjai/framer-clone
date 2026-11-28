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

/** The holds on each box: the first applies the footing, the last one released takes it back. */
const holds = new WeakMap<HTMLElement, { count: number; isolation: string; position: string; positioned: boolean }>();

/**
 * Make `box` hold a layer: a stacking context of its own, and a position when it has
 * none. Returns the undo (once; later calls do nothing). Holds nest in any order (a
 * placeholder, a still frame and the live scene may overlap for a moment): the box
 * gets its footing from the first and back from the last undo. `positionIsOwned`
 * says, at the time of that last undo, that something else has set the box's inline
 * position since (the editor's renderer, after the author gave the box a position):
 * then it is left alone.
 */
export function holdFxBox(box: HTMLElement): (positionIsOwned?: boolean) => void {
  let held = holds.get(box);
  if (held) held.count += 1;
  else {
    held = { count: 1, isolation: box.style.isolation, position: box.style.position, positioned: false };
    box.style.isolation = 'isolate';
    held.positioned = getComputedStyle(box).position === 'static';
    if (held.positioned) box.style.position = 'relative';
    holds.set(box, held);
  }
  const mine = held;
  let released = false;
  return (positionIsOwned = false) => {
    if (released) return;
    released = true;
    mine.count -= 1;
    if (mine.count > 0 || holds.get(box) !== mine) return;
    holds.delete(box);
    box.style.isolation = mine.isolation;
    if (mine.positioned && !positionIsOwned) box.style.position = mine.position;
  };
}

/**
 * The box's own position was set or taken away while it is held: take the footing again on the new
 * one, keeping every hold (the editor's renderer has already written the new position).
 */
export function reholdFxBox(box: HTMLElement): void {
  const held = holds.get(box);
  if (!held) return;
  // Our own footing (written by this hold or another on the box) is not the box's position: nothing changed.
  if (held.positioned && box.style.position === 'relative') return;
  held.position = box.style.position;
  box.style.isolation = 'isolate';
  held.positioned = getComputedStyle(box).position === 'static';
  if (held.positioned) box.style.position = 'relative';
}
// ci-replay touch
