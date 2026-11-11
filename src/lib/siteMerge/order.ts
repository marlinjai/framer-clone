// src/lib/siteMerge/order.ts
//
// The order of a merged list of ids (docs/plans/2026-11-10-site-branches.md, section 5, rule 8): a node's
// children, the site's pages, the theme's tokens. Main's order is the starting point; when only the branch
// reordered what all three sides hold, the branch's; when both reordered it differently, the caller asks
// (`ask`) and main's stands in until answered. What only the other side placed goes after the item it
// followed there, or first.
//
// PURE: client and server safe.

import type { MergeSide } from './types';
import { jsonEqual } from './value';

export function mergeOrder(
  base: readonly string[],
  main: readonly string[],
  branch: readonly string[],
  /** The ids the merged list holds. */
  present: ReadonlySet<string>,
  options: { unordered?: boolean; ask?: (base: string[], main: string[], branch: string[]) => MergeSide | undefined } = {},
): string[] {
  if (present.size === 0) return [];
  const only = (list: readonly string[]) => list.filter((id) => present.has(id));
  const b = only(base);
  const m = only(main);
  const r = only(branch);
  let primary = m;
  let secondary = r;
  if (!options.unordered) {
    // The relative order of what all three hold: an add on one side and a reorder on the other never clash.
    const common = new Set(b.filter((id) => m.includes(id) && r.includes(id)));
    const seq = (list: string[]) => list.filter((id) => common.has(id));
    const mMoved = !jsonEqual(seq(m), seq(b));
    const rMoved = !jsonEqual(seq(r), seq(b));
    if (rMoved && !mMoved) {
      primary = r;
      secondary = m;
    } else if (rMoved && mMoved && !jsonEqual(seq(m), seq(r)) && options.ask?.(seq(b), seq(m), seq(r)) === 'branch') {
      primary = r;
      secondary = m;
    }
  }
  const out = [...primary];
  if (options.unordered) {
    for (const id of secondary) if (!out.includes(id)) out.push(id);
  } else {
    secondary.forEach((id, index) => {
      if (out.includes(id)) return;
      let at = 0;
      for (let i = index - 1; i >= 0; i--) {
        const found = out.indexOf(secondary[i]);
        if (found >= 0) {
          at = found + 1;
          break;
        }
      }
      out.splice(at, 0, id);
    });
  }
  // Held by neither side's list (kept by an answer from the base): last, in the base's order.
  for (const id of [...b, ...present]) if (!out.includes(id)) out.push(id);
  return out;
}
