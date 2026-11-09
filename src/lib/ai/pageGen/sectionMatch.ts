// src/lib/ai/pageGen/sectionMatch.ts
//
// Which sections of a generation's result are exactly the preview sections the
// canvas already drew while the model wrote (gen:section). A preview section and
// its final copy are validated apart and get different ids, so what the model
// wrote, ids aside, is what matches them, never the position: a repair round may
// insert, drop or reorder sections, and a section that got its stock photo
// differs from its preview. A matched section stays still when the result lands;
// everything else reveals. Used by the editor's own Generate (GeneratePageDialog)
// and by the MCP generate_page, which works the matches out on the server and
// sends the candidates with gen:done (src/server/sites/liveGeneration.ts). Pure, client-safe.

import type { GeneratedNodeSnapshot } from './validate';

/** What a section says, without its ids: equal keys are the same section as the model wrote it. */
export function sectionContentKey(node: GeneratedNodeSnapshot): string {
  return JSON.stringify(node, (key, value) => (key === 'id' || key === 'parentId' ? undefined : value));
}

/**
 * For each result section, the position in `previews` of the preview it is
 * identical to, or null. Each preview matches at most one result section, the
 * first identical one in page order.
 */
export function matchPreviewSections(previews: readonly GeneratedNodeSnapshot[], results: readonly GeneratedNodeSnapshot[]): Array<number | null> {
  const unused = new Map<string, number[]>();
  previews.forEach((preview, position) => {
    const key = sectionContentKey(preview);
    const list = unused.get(key);
    if (list) list.push(position);
    else unused.set(key, [position]);
  });
  return results.map((node) => unused.get(sectionContentKey(node))?.shift() ?? null);
}

/**
 * For each result section, the positions in `previews` of every preview it is
 * identical to (empty when none). The MCP generate_page sends this, since only
 * the editor knows which previews it actually drew.
 */
export function identicalPreviews(previews: readonly GeneratedNodeSnapshot[], results: readonly GeneratedNodeSnapshot[]): number[][] {
  const byKey = new Map<string, number[]>();
  previews.forEach((preview, position) => {
    const key = sectionContentKey(preview);
    byKey.set(key, [...(byKey.get(key) ?? []), position]);
  });
  return results.map((node) => [...(byKey.get(sectionContentKey(node)) ?? [])]);
}
