// The layout audit's rules on synthetic measurements (jsdom has no layout, so
// the classification is tested on numbers; the DOM runner has its own test).

import { describe, expect, it } from 'vitest';
import {
  auditFrames,
  classifyFrame,
  contrastRatio,
  estimateBackground,
  isIntentionallyLayered,
  parseColor,
  type FrameMeasurement,
  type MeasuredNode,
} from '../layoutAudit';

function node(id: string, over: Partial<MeasuredNode> = {}): MeasuredNode {
  return {
    id,
    tag: 'div',
    box: { x: 0, y: 0, w: 100, h: 100 },
    clientW: 100,
    clientH: 100,
    scrollW: 100,
    scrollH: 100,
    overflowX: 'visible',
    overflowY: 'visible',
    position: 'static',
    display: 'block',
    negativeMargin: false,
    transformed: false,
    gridPlaced: false,
    color: 'rgb(17, 17, 17)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backgroundImage: 'none',
    ...over,
  };
}

function frame(nodes: MeasuredNode[], over: Partial<FrameMeasurement> = {}): FrameMeasurement {
  return { breakpoint: 'desktop', width: 1280, isSmallest: false, contentScrollWidth: 1280, nodes, ...over };
}

const root = node('root', { box: { x: 0, y: 0, w: 1280, h: 2000 }, clientW: 1280, clientH: 2000, scrollW: 1280, scrollH: 2000, backgroundColor: 'rgb(255, 255, 255)' });
const kinds = (f: FrameMeasurement) => classifyFrame(f).map((x) => `${x.kind}:${x.nodeId}`);

describe('text clipping', () => {
  it('flags text cut off by its own box when overflow is hidden', () => {
    const stat = node('stat', {
      parentId: 'root',
      tag: 'p',
      box: { x: 10, y: 10, w: 120, h: 40 },
      clientW: 120,
      clientH: 40,
      scrollW: 120,
      scrollH: 64,
      overflowY: 'hidden',
      text: { content: '1,200+', fontSizePx: 48, fontWeight: 700 },
    });
    const findings = classifyFrame(frame([root, stat]));
    const hit = findings.find((f) => f.kind === 'text-clipped' && f.nodeId === 'stat');
    expect(hit).toBeDefined();
    expect(hit!.measured).toMatchObject({ contentHeight: 64, boxHeight: 40 });
    expect(hit!.severity).toBe('error');
  });

  it('calls visible overflow text-overflow (it spills, it is not hidden)', () => {
    const p = node('p', {
      parentId: 'root',
      tag: 'p',
      box: { x: 0, y: 0, w: 200, h: 20 },
      clientW: 200,
      clientH: 20,
      scrollW: 200,
      scrollH: 60,
      text: { content: 'A long paragraph', fontSizePx: 16, fontWeight: 400 },
    });
    expect(kinds(frame([root, p]))).toContain('text-overflow:p');
  });

  it('ignores sub-pixel rounding (scroll one pixel over client)', () => {
    const p = node('p', { parentId: 'root', scrollH: 101, overflowY: 'hidden', text: { content: 'x', fontSizePx: 16, fontWeight: 400 } });
    expect(kinds(frame([root, p])).filter((k) => k.startsWith('text-'))).toEqual([]);
  });

  it('flags text reaching outside a clipping ancestor (the stats-row case)', () => {
    const row = node('row', { parentId: 'root', box: { x: 0, y: 100, w: 600, h: 80 }, overflowX: 'hidden', overflowY: 'hidden' });
    const cell = node('cell', { parentId: 'row', box: { x: 0, y: 100, w: 200, h: 80 } });
    const num = node('num', {
      parentId: 'cell',
      tag: 'span',
      box: { x: 0, y: 100, w: 200, h: 110 },
      text: { content: '98%', fontSizePx: 96, fontWeight: 800 },
    });
    const hit = classifyFrame(frame([root, row, cell, num])).find((f) => f.kind === 'text-clipped' && f.nodeId === 'num');
    expect(hit?.relatedNodeId).toBe('row');
    expect(hit?.measured.cutOffPx).toBe(30);
  });
});

describe('overflow and overlap', () => {
  it('flags a child sticking out of a non-clipping parent (card into its button)', () => {
    const card = node('card', { parentId: 'root', box: { x: 0, y: 0, w: 300, h: 200 } });
    const body = node('body', { parentId: 'card', box: { x: 0, y: 0, w: 300, h: 260 } });
    const hit = classifyFrame(frame([root, card, body])).find((f) => f.kind === 'child-overflow');
    expect(hit).toMatchObject({ nodeId: 'body', relatedNodeId: 'card', measured: { overflowPx: 60, side: 'bottom' } });
  });

  it('does not flag a child cropped by a parent that clips (a cover photo)', () => {
    const frameBox = node('frame', { parentId: 'root', box: { x: 0, y: 0, w: 300, h: 200 }, overflowX: 'hidden', overflowY: 'hidden' });
    const img = node('img', { parentId: 'frame', tag: 'img', box: { x: -50, y: -50, w: 400, h: 300 } });
    expect(kinds(frame([root, frameBox, img]))).toEqual([]);
  });

  it('flags colliding in-flow siblings', () => {
    const card = node('card', { parentId: 'root', box: { x: 0, y: 0, w: 300, h: 240 } });
    const cta = node('cta', { parentId: 'root', tag: 'a', box: { x: 0, y: 220, w: 160, h: 48 } });
    const hit = classifyFrame(frame([root, card, cta])).find((f) => f.kind === 'overlap');
    expect(hit).toMatchObject({ nodeId: 'cta', relatedNodeId: 'card', measured: { overlapWidth: 160, overlapHeight: 20 } });
  });

  it.each([
    ['absolute', { position: 'absolute' }],
    ['fixed', { position: 'fixed' }],
    ['sticky', { position: 'sticky' }],
    ['negative margin', { negativeMargin: true }],
    ['transform', { transformed: true }],
    ['explicit grid placement', { gridPlaced: true }],
  ] as const)('treats %s as intentional layering', (_label, over) => {
    const a = node('a', { parentId: 'root', box: { x: 0, y: 0, w: 300, h: 240 } });
    const b = node('b', { parentId: 'root', box: { x: 0, y: 100, w: 300, h: 240 }, ...over });
    expect(isIntentionallyLayered(b)).toBe(true);
    expect(kinds(frame([root, a, b])).filter((k) => k.startsWith('overlap') || k.startsWith('child-overflow'))).toEqual([]);
  });

  it('ignores touching siblings (shared edge, no area)', () => {
    const a = node('a', { parentId: 'root', box: { x: 0, y: 0, w: 300, h: 100 } });
    const b = node('b', { parentId: 'root', box: { x: 0, y: 100, w: 300, h: 100 } });
    expect(kinds(frame([root, a, b]))).toEqual([]);
  });
});

describe('horizontal overflow on the smallest breakpoint', () => {
  const phoneRoot = node('root', { box: { x: 0, y: 0, w: 390, h: 1000 }, backgroundColor: 'rgb(255, 255, 255)' });

  it('reports the outermost node that reaches past the frame, only on the smallest frame', () => {
    const row = node('row', { parentId: 'root', box: { x: 0, y: 0, w: 640, h: 100 } });
    const item = node('item', { parentId: 'row', box: { x: 400, y: 0, w: 200, h: 100 } });
    const phone = frame([phoneRoot, row, item], { breakpoint: 'phone', width: 390, isSmallest: true, contentScrollWidth: 640 });
    const hits = classifyFrame(phone).filter((f) => f.kind === 'horizontal-overflow');
    expect(hits.map((h) => h.nodeId)).toEqual(['row']);
    expect(hits[0].measured).toMatchObject({ frameWidth: 390, outsidePx: 250 });
    // The same numbers on a larger frame are not a horizontal-scroll problem.
    expect(classifyFrame({ ...phone, isSmallest: false }).some((f) => f.kind === 'horizontal-overflow')).toBe(false);
  });

  it('accepts a deliberate crop: wide content inside a clipping box that fits', () => {
    const track = node('track', { parentId: 'root', box: { x: 0, y: 0, w: 390, h: 100 }, overflowX: 'hidden' });
    const slides = node('slides', { parentId: 'track', box: { x: 0, y: 0, w: 1200, h: 100 }, transformed: true });
    const phone = frame([phoneRoot, track, slides], { breakpoint: 'phone', width: 390, isSmallest: true, contentScrollWidth: 390 });
    expect(classifyFrame(phone).some((f) => f.kind === 'horizontal-overflow')).toBe(false);
  });

  it('falls back to the page root when the content is wider but no node shows it', () => {
    const phone = frame([phoneRoot], { breakpoint: 'phone', width: 390, isSmallest: true, contentScrollWidth: 460 });
    expect(classifyFrame(phone).find((f) => f.kind === 'horizontal-overflow')?.nodeId).toBe('root');
  });
});

describe('headlines', () => {
  const h1 = (wordsPerLine: number[], fontSizePx = 64) =>
    node('h1', { parentId: 'root', tag: 'h1', text: { content: 'Ride further', fontSizePx, fontWeight: 700, wordsPerLine } });

  it('flags a display headline wrapping onto too many lines', () => {
    expect(kinds(frame([root, h1([2, 2, 2, 1])]))).toContain('headline-lines:h1');
    expect(kinds(frame([root, h1([2, 2, 2])]))).not.toContain('headline-lines:h1');
    // Phone allows one more line.
    expect(kinds(frame([root, h1([2, 2, 2, 2])], { width: 390 }))).not.toContain('headline-lines:h1');
  });

  it('flags a single orphan word on the last line', () => {
    expect(kinds(frame([root, h1([3, 1])]))).toContain('orphan:h1');
    expect(kinds(frame([root, h1([2, 2])]))).not.toContain('orphan:h1');
    // A two-word headline split one and one is not an orphan problem.
    expect(kinds(frame([root, h1([1, 1])]))).not.toContain('orphan:h1');
  });

  it('leaves body text alone', () => {
    expect(kinds(frame([root, h1([2, 2, 2, 2, 1], 18)]))).toEqual([]);
  });
});

describe('contrast', () => {
  it('parses computed colours', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgb(0 0 0 / 50%)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor('transparent')?.a).toBe(0);
    expect(parseColor('color(display-p3 1 0 0)')).toBeUndefined();
  });

  it('computes WCAG ratios', () => {
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(21, 0);
    expect(contrastRatio({ r: 119, g: 119, b: 119, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(4.48, 1);
  });

  it('flags low contrast over a solid background, with the large-text threshold', () => {
    const panel = node('panel', { parentId: 'root', backgroundColor: 'rgb(255, 255, 255)' });
    const grey = (fontSizePx: number) =>
      node('t', { parentId: 'panel', color: 'rgb(150, 150, 150)', text: { content: 'Muted', fontSizePx, fontWeight: 400 } });
    // #969696 on white is about 2.96:1: fails both thresholds.
    expect(kinds(frame([root, panel, grey(16)]))).toContain('low-contrast:t');
    const mid = node('t', { parentId: 'panel', color: 'rgb(130, 130, 130)', text: { content: 'Mid', fontSizePx: 16, fontWeight: 400 } });
    // #828282 on white is about 3.8:1: fails body text, passes large text.
    expect(kinds(frame([root, panel, mid]))).toContain('low-contrast:t');
    expect(kinds(frame([root, panel, { ...mid, text: { ...mid.text!, fontSizePx: 28 } }]))).not.toContain('low-contrast:t');
  });

  it('does not judge text that only inherits the editor colour around the canvas', () => {
    const t = node('t', { parentId: 'root', color: 'rgb(255, 255, 255)', text: { content: 'Inherits', fontSizePx: 16, fontWeight: 400 } });
    const plainRoot = { ...root, color: 'rgb(255, 255, 255)' };
    expect(kinds(frame([plainRoot, t], { inheritedColor: 'rgb(255, 255, 255)' }))).not.toContain('low-contrast:t');
    // A root that sets its own colour makes every inherited colour the page's: judged.
    const styledRoot = { ...root, color: 'rgb(250, 250, 250)' };
    const t2 = { ...t, color: 'rgb(250, 250, 250)' };
    expect(kinds(frame([styledRoot, t2], { inheritedColor: 'rgb(255, 255, 255)' }))).toContain('low-contrast:t');
  });

  it('composites a translucent background over what is below', () => {
    const dark = node('dark', { parentId: 'root', backgroundColor: 'rgb(10, 10, 10)' });
    const veil = node('veil', { parentId: 'dark', backgroundColor: 'rgba(255, 255, 255, 0.9)' });
    const text = node('t', { parentId: 'veil', color: 'rgb(255, 255, 255)', text: { content: 'White on veil', fontSizePx: 16, fontWeight: 400 } });
    const byId = new Map([root, dark, veil, text].map((n) => [n.id, n]));
    const bg = estimateBackground(text, byId, { r: 255, g: 255, b: 255, a: 1 });
    expect(bg.color.r).toBeGreaterThan(220);
    expect(kinds(frame([root, dark, veil, text]))).toContain('low-contrast:t');
  });

  it('fails text straight on a photo without a scrim, by design', () => {
    const hero = node('hero', { parentId: 'root', backgroundImage: 'url("https://images.unsplash.com/photo-1")' });
    const h = node('h', { parentId: 'hero', color: 'rgb(255, 255, 255)', text: { content: 'Ride further', fontSizePx: 64, fontWeight: 700 } });
    const hit = classifyFrame(frame([root, hero, h])).find((f) => f.kind === 'image-text-contrast');
    expect(hit).toMatchObject({ nodeId: 'h', severity: 'error', relatedNodeId: 'hero', measured: { scrim: 'none' } });
  });

  it('passes white text over a strong dark scrim, warns over a weak one', () => {
    const withScrim = (a: number) =>
      node('hero', {
        parentId: 'root',
        backgroundImage: `linear-gradient(rgba(0, 0, 0, ${a}), rgba(0, 0, 0, ${a})), url("https://images.unsplash.com/photo-1")`,
      });
    const h = node('h', { parentId: 'hero', color: 'rgb(255, 255, 255)', text: { content: 'Ride further', fontSizePx: 18, fontWeight: 400 } });
    expect(kinds(frame([root, withScrim(0.6), h]))).not.toContain('image-text-contrast:h');
    const weak = classifyFrame(frame([root, withScrim(0.15), h])).find((f) => f.kind === 'image-text-contrast');
    expect(weak).toMatchObject({ severity: 'warning', measured: { scrim: 'yes' } });
  });

  it('a solid panel between the text and the photo decides', () => {
    const hero = node('hero', { parentId: 'root', backgroundImage: 'url("https://images.unsplash.com/photo-1")' });
    const panel = node('panel', { parentId: 'hero', backgroundColor: 'rgb(20, 20, 20)' });
    const h = node('h', { parentId: 'panel', color: 'rgb(255, 255, 255)', text: { content: 'Ride', fontSizePx: 18, fontWeight: 400 } });
    expect(classifyFrame(frame([root, hero, panel, h]))).toEqual([]);
  });
});

describe('auditFrames', () => {
  it('merges frames, puts errors first, dedupes and caps', () => {
    const h1 = node('h1', { parentId: 'root', text: { content: 'Headline here now', fontSizePx: 64, fontWeight: 700, wordsPerLine: [3, 1] } });
    const p = node('p', { parentId: 'root', box: { x: 0, y: 200, w: 100, h: 20 }, clientH: 20, scrollH: 60, overflowY: 'hidden', text: { content: 'x', fontSizePx: 16, fontWeight: 400 } });
    const all = auditFrames([frame([root, h1, p]), frame([root, h1, p], { breakpoint: 'tablet', width: 810 })], 100);
    expect(all[0].severity).toBe('error');
    expect(all.map((f) => `${f.kind}:${f.breakpoint}`)).toEqual([
      'text-clipped:desktop',
      'text-clipped:tablet',
      'orphan:desktop',
      'orphan:tablet',
    ]);
    expect(auditFrames([frame([root, h1, p])], 1)).toHaveLength(1);
  });
});
