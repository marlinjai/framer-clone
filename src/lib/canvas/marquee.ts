// src/lib/canvas/marquee.ts
//
// Marquee (rubber-band) selection on the canvas: the pure geometry and the
// hit test. Canvas.tsx collects the candidates from the DOM (one entry per
// rendered component, with its on-screen rect and the id of the nearest
// rendered ancestor component) and hands them here, so the rules that decide
// what a rectangle selects are unit tested without a browser.

/** A rectangle in screen (client) pixels. */
export interface ScreenBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MarqueeCandidate {
  /** Component id. The same id can appear more than once (a list renders its
   *  item template once per row); any of its rects hitting selects it once. */
  id: string;
  /** Id of the nearest ancestor component that is also a candidate, if any. */
  parentId?: string;
  /** On-screen rect, already clipped to whatever hides the node. */
  rect: ScreenBox;
}

/** Pointer travel (screen px) before a press on empty canvas becomes a
 *  marquee. Matches the drag manager's threshold, so a click stays a click. */
export const MARQUEE_THRESHOLD_PX = 4;

/** The normalised rectangle spanned by two pointer positions, in any order. */
export function boxFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): ScreenBox {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return { left, top, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** True once the pointer has moved far enough from the press to be a drag. */
export function pastThreshold(
  start: { x: number; y: number },
  current: { x: number; y: number },
  threshold: number = MARQUEE_THRESHOLD_PX,
): boolean {
  return Math.abs(current.x - start.x) >= threshold || Math.abs(current.y - start.y) >= threshold;
}

/**
 * True when the two boxes overlap with a positive area. Touching edges do not
 * count, and an empty box (a node that renders nothing) never hits.
 */
export function boxesIntersect(a: ScreenBox, b: ScreenBox): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  );
}

/**
 * Ids the marquee selects, in candidate (document) order, without duplicates.
 *
 * A candidate is hit when its rect intersects the marquee. Of the hit nodes,
 * only the topmost level is kept: a node is dropped when any of its ancestors
 * is also hit, so a rectangle across a card selects the card, never the card
 * together with its title and button.
 */
export function marqueeHitTest(marquee: ScreenBox, candidates: MarqueeCandidate[]): string[] {
  const hit = new Set<string>();
  for (const c of candidates) {
    if (boxesIntersect(marquee, c.rect)) hit.add(c.id);
  }
  if (hit.size === 0) return [];

  // First recorded parent per id. Repeated ids (list rows) share a template,
  // so their parents are the same component.
  const parentOf = new Map<string, string | undefined>();
  for (const c of candidates) {
    if (!parentOf.has(c.id)) parentOf.set(c.id, c.parentId);
  }

  const hasHitAncestor = (id: string): boolean => {
    const seen = new Set<string>([id]);
    let current = parentOf.get(id);
    while (current !== undefined) {
      // A malformed chain (a cycle) must not hang the canvas.
      if (seen.has(current)) return false;
      if (hit.has(current)) return true;
      seen.add(current);
      current = parentOf.get(current);
    }
    return false;
  };

  const result: string[] = [];
  const emitted = new Set<string>();
  for (const c of candidates) {
    if (emitted.has(c.id) || !hit.has(c.id)) continue;
    emitted.add(c.id);
    if (!hasHitAncestor(c.id)) result.push(c.id);
  }
  return result;
}

/** Area of the overlap between two boxes (0 when they do not intersect). */
export function overlapArea(a: ScreenBox, b: ScreenBox): number {
  const w = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const h = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}
