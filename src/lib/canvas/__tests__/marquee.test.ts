// Marquee (rubber-band) selection: the geometry and the hit test that decide
// what a rectangle drawn on the canvas selects.
import { describe, it, expect } from 'vitest';
import {
  boxFromPoints,
  boxesIntersect,
  marqueeHitTest,
  overlapArea,
  pastThreshold,
  type MarqueeCandidate,
} from '../marquee';

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

describe('boxFromPoints', () => {
  it('normalises a drag in any direction', () => {
    expect(boxFromPoints({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(box(10, 20, 30, 40));
    expect(boxFromPoints({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(box(10, 20, 30, 40));
    expect(boxFromPoints({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(box(10, 20, 30, 40));
  });
});

describe('pastThreshold', () => {
  it('a jitter stays a click, a real move becomes a drag', () => {
    expect(pastThreshold({ x: 0, y: 0 }, { x: 3, y: -3 })).toBe(false);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(true);
  });
});

describe('boxesIntersect', () => {
  it('overlapping boxes intersect, separate ones do not', () => {
    expect(boxesIntersect(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(true);
    expect(boxesIntersect(box(0, 0, 10, 10), box(20, 20, 5, 5))).toBe(false);
  });

  it('containment counts as intersection, both ways', () => {
    expect(boxesIntersect(box(0, 0, 100, 100), box(10, 10, 5, 5))).toBe(true);
    expect(boxesIntersect(box(10, 10, 5, 5), box(0, 0, 100, 100))).toBe(true);
  });

  it('touching edges and empty boxes never hit', () => {
    expect(boxesIntersect(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(false);
    expect(boxesIntersect(box(0, 0, 10, 10), box(5, 5, 0, 0))).toBe(false);
    expect(boxesIntersect(box(0, 0, 0, 10), box(0, 0, 10, 10))).toBe(false);
  });
});

describe('overlapArea', () => {
  it('measures the shared area, zero when apart', () => {
    expect(overlapArea(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(25);
    expect(overlapArea(box(0, 0, 10, 10), box(50, 50, 10, 10))).toBe(0);
  });
});

describe('marqueeHitTest', () => {
  // A section holding a card (title + button) and a footer beside it.
  //   section  (0,0 400x200)
  //     card   (20,20 160x160)
  //       title  (30,30 100x20)
  //       button (30,140 80x30)
  //   footer   (0,220 400x60)
  const candidates: MarqueeCandidate[] = [
    { id: 'section', rect: box(0, 0, 400, 200) },
    { id: 'card', parentId: 'section', rect: box(20, 20, 160, 160) },
    { id: 'title', parentId: 'card', rect: box(30, 30, 100, 20) },
    { id: 'button', parentId: 'card', rect: box(30, 140, 80, 30) },
    { id: 'footer', rect: box(0, 220, 400, 60) },
  ];

  it('selects nothing when the rectangle touches nothing', () => {
    expect(marqueeHitTest(box(500, 500, 20, 20), candidates)).toEqual([]);
    expect(marqueeHitTest(box(0, 0, 100, 100), [])).toEqual([]);
  });

  it('keeps only the topmost level: a parent wins over its children', () => {
    // Crosses section, card and title: only the section is selected.
    expect(marqueeHitTest(box(25, 25, 50, 10), candidates)).toEqual(['section']);
  });

  it('selects every top-level node the rectangle crosses, in document order', () => {
    expect(marqueeHitTest(box(10, 190, 50, 50), candidates)).toEqual(['section', 'footer']);
  });

  it('selects children when their parent is not a candidate (a frame root left out)', () => {
    const insideCard = candidates.filter(c => c.id !== 'section' && c.id !== 'card');
    const orphaned = insideCard.map(c => (c.parentId === 'card' ? { ...c, parentId: undefined } : c));
    expect(marqueeHitTest(box(25, 25, 50, 130), orphaned)).toEqual(['title', 'button']);
  });

  it('drops a child even when only a more distant ancestor is hit', () => {
    // The card is not hit (the rectangle misses it), but the section is: the
    // title sits under the section through the card, so it is left out.
    const withSkippedLevel: MarqueeCandidate[] = [
      { id: 'section', rect: box(0, 0, 400, 200) },
      { id: 'card', parentId: 'section', rect: box(300, 300, 1, 1) },
      { id: 'title', parentId: 'card', rect: box(30, 30, 100, 20) },
    ];
    expect(marqueeHitTest(box(25, 25, 50, 10), withSkippedLevel)).toEqual(['section']);
  });

  it('reports a repeated id (list rows) once, if any of its rects is hit', () => {
    const rows: MarqueeCandidate[] = [
      { id: 'row', rect: box(0, 0, 100, 20) },
      { id: 'row', rect: box(0, 30, 100, 20) },
      { id: 'other', rect: box(0, 60, 100, 20) },
    ];
    expect(marqueeHitTest(box(10, 35, 10, 5), rows)).toEqual(['row']);
    expect(marqueeHitTest(box(10, 5, 10, 70), rows)).toEqual(['row', 'other']);
  });

  it('survives a malformed parent chain without hanging', () => {
    const cyclic: MarqueeCandidate[] = [
      { id: 'a', parentId: 'b', rect: box(0, 0, 10, 10) },
      { id: 'b', parentId: 'a', rect: box(100, 100, 10, 10) },
    ];
    expect(marqueeHitTest(box(0, 0, 5, 5), cyclic)).toEqual(['a']);
  });
});
