// Which result sections are exactly the previews the canvas drew (../sectionMatch.ts).
import { describe, expect, it } from 'vitest';
import { matchPreviewSections, sectionContentKey } from '../sectionMatch';
import type { GeneratedNodeSnapshot } from '../validate';

const n = (text: string, id: string): GeneratedNodeSnapshot =>
  ({ id, type: 'section', componentType: 'host', label: text, props: { children: text }, children: [{ id: `${id}-c`, parentId: id, type: 'p', componentType: 'host', label: '', props: {}, children: [] }] }) as unknown as GeneratedNodeSnapshot;

describe('matchPreviewSections', () => {
  it('matches by what the model wrote, ids aside, each preview once, in page order', () => {
    expect(sectionContentKey(n('A', 'x'))).toBe(sectionContentKey(n('A', 'y')));
    const previews = [n('A', 'p1'), n('B', 'p2'), n('A', 'p3')];
    // A repair moved B first, kept both As, and wrote a new C.
    expect(matchPreviewSections(previews, [n('B', 'r1'), n('A', 'r2'), n('C', 'r3'), n('A', 'r4'), n('A', 'r5')])).toEqual([1, 0, null, 2, null]);
    expect(matchPreviewSections([], [n('A', 'r1')])).toEqual([null]);
  });
});
