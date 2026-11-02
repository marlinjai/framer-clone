// Which named gap the computed differences of a real page belong to, measured rather
// than guessed from a property's name. The same replica is also opened with no root
// layout sheet and no page base at all (`bareDocument`), which no visitor gets: what
// differs on the real page and not on that one is the page base's doing, so it is
// `published-base`. An element the replica does not have is `blocked-embedded-content`,
// the only cause found on these pages. Anything else stays `unclassified`, the honest
// bucket, and shows in the report.
//
// The comparison counts per property, so the split is per property too: of the
// differences in one property, as many as the bare page does not have are the base's.

import type { ComputedDiff } from '../lib/compare';
import type { GapId } from '../lib/types';

export interface Classified {
  top: GapId;
  byGap: Partial<Record<GapId, number>>;
  topProperties: [string, number][];
}

function gapOf(property: string): GapId {
  if (property === 'missing') return 'blocked-embedded-content';
  return 'unclassified';
}

/**
 * `withoutBase` is the same original against the replica on a page with no base, when
 * it was measured. Without it nothing can be put on the base, so nothing is.
 */
export function classifyDifferences(diff: ComputedDiff, withoutBase?: ComputedDiff): Classified {
  const byGap: Partial<Record<GapId, number>> = {};
  const add = (gap: GapId, count: number) => {
    if (count > 0) byGap[gap] = (byGap[gap] ?? 0) + count;
  };
  for (const [property, count] of Object.entries(diff.byProperty)) {
    const left = withoutBase ? Math.min(count, withoutBase.byProperty[property] ?? 0) : count;
    add('published-base', count - left);
    add(gapOf(property), left);
  }
  const ranked = Object.entries(byGap).sort((a, b) => b[1] - a[1]);
  return {
    top: (ranked[0]?.[0] as GapId | undefined) ?? 'layout-difference',
    byGap,
    topProperties: Object.entries(diff.byProperty).sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}
