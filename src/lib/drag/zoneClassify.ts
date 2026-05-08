// Classify the drop zone within a candidate target.
//
// Zone layout (vertical slivers):
//   ┌───────────────┐  <- top sliver: 'before'
//   │░░░░░░░░░░░░░░░│
//   ├───────────────┤
//   │               │  <- middle: 'inside' if target can host children,
//   │               │                else nearest edge ('before' / 'after')
//   ├───────────────┤
//   │░░░░░░░░░░░░░░░│
//   └───────────────┘  <- bottom sliver: 'after'
//
// Sliver = min(12px, 25% of height). The 12px cap means small elements still
// have a usable middle zone (otherwise the whole target would be edge).
//
// Void tags (img, br, input, ...) always pass `targetCanHostChildren = false`
// so the middle collapses to nearest-edge. Same for text-leaf components whose
// `inside` zone would overwrite their string children.

export type Zone = 'before' | 'after' | 'inside';

export function classifyZone(
  rect: DOMRect,
  clientY: number,
  targetCanHostChildren: boolean,
): Zone {
  const sliver = Math.min(12, rect.height * 0.25);
  if (clientY <= rect.top + sliver) return 'before';
  if (clientY >= rect.bottom - sliver) return 'after';
  if (!targetCanHostChildren) {
    return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  }
  return 'inside';
}
