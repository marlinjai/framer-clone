// Geometry of the on-canvas spacing handles: padding, margin and gap bands
// from rects and computed values, and where each band's handle goes.
import { describe, it, expect } from 'vitest';
import {
  HANDLE_MIN_OFFSET,
  boxBands,
  contentBox,
  gapBands,
  handleForRegion,
  outerBox,
  type Edges,
  type SpacingRegion,
} from '../spacingGeometry';

const edges = (top: number, right = top, bottom = top, left = right): Edges => ({ top, right, bottom, left });
const ZERO = edges(0);
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });
const byId = (regions: SpacingRegion[]) => Object.fromEntries(regions.map(r => [r.id, r]));

describe('boxBands', () => {
  it('places padding inside the border, at zoom 1', () => {
    const r = byId(boxBands({
      rect: rect(100, 50, 200, 100), border: edges(2), padding: edges(10, 20, 30, 40),
      margin: ZERO, scale: 1, includeMargin: false,
    }));
    expect(r['padding-top'].rect).toEqual(rect(102, 52, 196, 10));
    expect(r['padding-bottom'].rect).toEqual(rect(102, 148 - 30, 196, 30));
    // Left and right fill the height between top and bottom bands.
    expect(r['padding-left'].rect).toEqual(rect(102, 62, 40, 148 - 30 - 62));
    expect(r['padding-right'].rect).toEqual(rect(298 - 20, 62, 20, 56));
    expect(r['padding-left'].value).toBe(40);
    expect(r['margin-top']).toBeUndefined();
  });

  it('scales CSS px to screen px with the zoom', () => {
    const r = byId(boxBands({
      rect: rect(0, 0, 400, 200), border: ZERO, padding: edges(16),
      margin: edges(8), scale: 2, includeMargin: true,
    }));
    expect(r['padding-top'].rect.height).toBe(32);
    expect(r['padding-top'].value).toBe(16); // the value stays CSS px
    expect(r['margin-top'].rect).toEqual(rect(0, -16, 400, 16));
    expect(r['margin-left'].rect).toEqual(rect(-16, 0, 16, 200));
    expect(r['margin-right'].rect).toEqual(rect(400, 0, 16, 200));
    expect(r['margin-bottom'].rect).toEqual(rect(0, 200, 400, 16));
  });

  it('draws a negative margin as a zero-thick band but keeps its value', () => {
    const r = byId(boxBands({
      rect: rect(0, 0, 100, 100), border: ZERO, padding: ZERO,
      margin: edges(-10, 0, 0, 0), scale: 1, includeMargin: true,
    }));
    expect(r['margin-top'].rect.height).toBe(0);
    expect(r['margin-top'].value).toBe(-10);
  });

  it('contentBox and outerBox follow padding, border and margin', () => {
    expect(contentBox(rect(0, 0, 100, 50), edges(1), edges(4), 2)).toEqual(rect(10, 10, 80, 30));
    expect(outerBox(rect(10, 10, 100, 50), edges(5, 0, -3, 2), 1)).toEqual(rect(8, 5, 102, 55));
  });
});

describe('gapBands', () => {
  const content = rect(0, 0, 300, 100);

  it('a flex row: one band per neighbour pair, the gap thick, the content box tall', () => {
    const bands = gapBands({
      content, flow: 'row', wrap: false, rowGap: 0, columnGap: 10, scale: 1,
      children: [rect(0, 0, 50, 40), rect(60, 0, 50, 80), rect(120, 0, 50, 20)],
    });
    expect(bands).toHaveLength(2);
    expect(bands[0]).toMatchObject({ id: 'gap-column-0', target: { kind: 'gap', axis: 'column' }, value: 10 });
    expect(bands[0].rect).toEqual(rect(50, 0, 10, 100));
    expect(bands[1].rect).toEqual(rect(110, 0, 10, 100));
  });

  it('centres the gap in extra space from justify-content, so it is not mistaken for gap', () => {
    const [band] = gapBands({
      content, flow: 'row', wrap: false, rowGap: 0, columnGap: 10, scale: 1,
      children: [rect(0, 0, 50, 40), rect(250, 0, 50, 40)],
    });
    expect(band.rect).toEqual(rect(145, 0, 10, 100));
  });

  it('a zero gap still yields a zero-wide band at the seam (so a handle can create a gap)', () => {
    const [band] = gapBands({
      content, flow: 'row', wrap: false, rowGap: 0, columnGap: 0, scale: 1,
      children: [rect(0, 0, 50, 40), rect(50, 0, 50, 40)],
    });
    expect(band.rect).toEqual(rect(50, 0, 0, 100));
  });

  it('a flex column uses row-gap along y; reverse order comes from the rects', () => {
    const bands = gapBands({
      content: rect(0, 0, 100, 300), flow: 'column', wrap: false, rowGap: 5, columnGap: 99, scale: 2,
      children: [rect(0, 120, 100, 50), rect(0, 0, 100, 50), rect(0, 60, 100, 50)],
    });
    expect(bands.map(b => b.target)).toEqual([{ kind: 'gap', axis: 'row' }, { kind: 'gap', axis: 'row' }]);
    expect(bands[0].rect).toEqual(rect(0, 50, 100, 10));
    expect(bands[1].rect).toEqual(rect(0, 110, 100, 10));
    expect(bands[0].value).toBe(5);
  });

  it('a nowrap row keeps items that do not overlap vertically on one line', () => {
    const bands = gapBands({
      content, flow: 'row', wrap: false, rowGap: 0, columnGap: 10, scale: 1,
      children: [rect(0, 0, 50, 20), rect(60, 80, 50, 20)],
    });
    expect(bands).toHaveLength(1);
    expect(bands[0].target).toEqual({ kind: 'gap', axis: 'column' });
  });

  it('a wrapping row: column gaps per line and a row gap between lines', () => {
    const bands = gapBands({
      content: rect(0, 0, 120, 110), flow: 'row', wrap: true, rowGap: 10, columnGap: 10, scale: 1,
      children: [rect(0, 0, 50, 50), rect(60, 0, 50, 50), rect(0, 60, 50, 50)],
    });
    const column = bands.filter(b => b.target.kind === 'gap' && b.target.axis === 'column');
    const row = bands.filter(b => b.target.kind === 'gap' && b.target.axis === 'row');
    expect(column).toHaveLength(1);
    expect(column[0].rect).toEqual(rect(50, 0, 10, 50)); // spans its own line
    expect(row).toHaveLength(1);
    expect(row[0].rect).toEqual(rect(0, 50, 120, 10)); // spans the content box
  });

  it('a grid merges column gaps that line up into one stripe', () => {
    const cells = [0, 60].flatMap(top => [0, 60, 120].map(left => rect(left, top, 50, 50)));
    const bands = gapBands({
      content: rect(0, 0, 170, 110), flow: 'row', wrap: true, rowGap: 10, columnGap: 10, scale: 1,
      children: cells,
    });
    const column = bands.filter(b => b.target.kind === 'gap' && b.target.axis === 'column');
    expect(column.map(b => b.rect)).toEqual([rect(50, 0, 10, 110), rect(110, 0, 10, 110)]);
    expect(bands.filter(b => b.target.kind === 'gap' && b.target.axis === 'row')).toHaveLength(1);
  });

  it('no bands for fewer than two laid-out children or overlapping items', () => {
    expect(gapBands({ content, flow: 'row', wrap: false, rowGap: 0, columnGap: 10, scale: 1,
      children: [rect(0, 0, 50, 50), rect(0, 0, 0, 0)] })).toEqual([]);
    expect(gapBands({ content, flow: 'row', wrap: false, rowGap: 0, columnGap: 10, scale: 1,
      children: [rect(0, 0, 50, 50), rect(20, 0, 50, 50)] })).toEqual([]);
  });
});

describe('handleForRegion', () => {
  const element = rect(100, 100, 200, 200);
  const bands = byId(boxBands({
    rect: element, border: ZERO, padding: edges(40, 0, 0, 0), margin: ZERO, scale: 1, includeMargin: true,
  }));

  it('sits in the middle of a thick band', () => {
    const h = handleForRegion(bands['padding-top'], element)!;
    expect(h.orientation).toBe('horizontal');
    expect(h.bar.left + h.bar.width / 2).toBe(200);
    expect(h.bar.top + h.bar.height / 2).toBe(120);
  });

  it('a thin padding band moves its handle inward, a thin margin band outward', () => {
    const pb = handleForRegion(bands['padding-bottom'], element)!;
    expect(pb.bar.top + pb.bar.height / 2).toBe(300 - HANDLE_MIN_OFFSET);
    const mt = handleForRegion(bands['margin-top'], element)!;
    expect(mt.bar.top + mt.bar.height / 2).toBe(100 - HANDLE_MIN_OFFSET);
    const ml = handleForRegion(bands['margin-left'], element)!;
    expect(ml.orientation).toBe('vertical');
    expect(ml.bar.left + ml.bar.width / 2).toBe(100 - HANDLE_MIN_OFFSET);
    const pr = handleForRegion(bands['padding-right'], element)!;
    expect(pr.bar.left + pr.bar.width / 2).toBe(300 - HANDLE_MIN_OFFSET);
  });

  it('the hit area is larger than the bar and the same size at any zoom', () => {
    const zoomed = byId(boxBands({
      rect: rect(0, 0, 800, 800), border: ZERO, padding: edges(40), margin: ZERO, scale: 4, includeMargin: false,
    }));
    const a = handleForRegion(bands['padding-top'], element)!;
    const b = handleForRegion(zoomed['padding-top'], rect(0, 0, 800, 800))!;
    expect(b.hit.width).toBe(a.hit.width);
    expect(b.hit.height).toBe(a.hit.height);
    expect(a.hit.width).toBeGreaterThan(a.bar.width);
  });

  it('hides a pushed-in padding handle on a small element, and any handle on a short band', () => {
    const small = rect(0, 0, 40, 30);
    const r = byId(boxBands({ rect: small, border: ZERO, padding: ZERO, margin: ZERO, scale: 1, includeMargin: true }));
    expect(handleForRegion(r['padding-top'], small)).toBeNull();
    expect(handleForRegion(r['margin-top'], small)).not.toBeNull(); // 40 wide is room enough
    const tiny = rect(0, 0, 10, 10);
    const t = byId(boxBands({ rect: tiny, border: ZERO, padding: ZERO, margin: ZERO, scale: 1, includeMargin: true }));
    expect(handleForRegion(t['margin-top'], tiny)).toBeNull();
  });

  it('a gap handle sits in the middle of the gap, across it', () => {
    const [band] = gapBands({
      content: rect(0, 0, 300, 100), flow: 'row', wrap: false, rowGap: 0, columnGap: 0, scale: 1,
      children: [rect(0, 0, 50, 40), rect(50, 0, 50, 40)],
    });
    const h = handleForRegion(band, rect(0, 0, 300, 100))!;
    expect(h.orientation).toBe('vertical');
    expect(h.bar.left + h.bar.width / 2).toBe(50);
    expect(h.bar.top + h.bar.height / 2).toBe(50);
  });
});
