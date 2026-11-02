// Which named gap the computed differences of a real page belong to. A property maps
// to a gap only where the difference was traced to it on the first run (2026-11-02).
// Anything else stays `unclassified`, the honest bucket, and shows in the report.

import type { ComputedDiff } from '../lib/compare';
import type { GapId } from '../lib/types';

/** Values Tailwind builds from a var() list holding empty variables. */
const FROM_EMPTY_VARIABLES = new Set(['filter', 'backdrop-filter', '-webkit-backdrop-filter', 'background-image', 'box-shadow']);

export interface Classified {
  top: GapId;
  byGap: Partial<Record<GapId, number>>;
  topProperties: [string, number][];
}

function gapOf(property: string): GapId {
  if (property === 'missing') return 'blocked-embedded-content';
  if (FROM_EMPTY_VARIABLES.has(property)) return 'empty-custom-property';
  return 'unclassified';
}

export function classifyDifferences(diff: ComputedDiff): Classified {
  const byGap: Partial<Record<GapId, number>> = {};
  for (const [property, count] of Object.entries(diff.byProperty)) {
    const gap = gapOf(property);
    byGap[gap] = (byGap[gap] ?? 0) + count;
  }
  const ranked = Object.entries(byGap).sort((a, b) => b[1] - a[1]);
  return {
    top: (ranked[0]?.[0] as GapId | undefined) ?? 'layout-difference',
    byGap,
    topProperties: Object.entries(diff.byProperty).sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}
