// Where the phone quick toolbar and the long-press menu sit: above the
// element, below it when there is no room, docked above the bottom bar when
// neither fits, never over the bars or the keyboard, never off screen.
import { describe, expect, it } from 'vitest';
import { QUICKBAR_GAP, QUICKBAR_MARGIN, placeMenuAtPoint, placeQuickbar, visibleBottom } from '../placement';

// A 390x844 phone: top bar to 48, bottom bar from 780.
const area = { width: 390, top: 48, bottom: 780 };
const bar = { width: 300, height: 44 };

const overlaps = (a: { top: number; height: number }, b: { top: number; height: number }) =>
  a.top < b.top + b.height && b.top < a.top + a.height;

describe('placeQuickbar', () => {
  it('sits above the element, centred on it, with a gap', () => {
    const target = { left: 100, top: 300, width: 190, height: 80 };
    const r = placeQuickbar(target, bar, area);
    expect(r.placement).toBe('above');
    expect(r.top).toBe(300 - QUICKBAR_GAP - 44);
    expect(r.left).toBe(100 + 95 - 150);
    expect(overlaps({ top: r.top, height: 44 }, target)).toBe(false);
  });

  it('goes below when the element is near the top bar', () => {
    const target = { left: 20, top: 70, width: 200, height: 60 };
    const r = placeQuickbar(target, bar, area);
    expect(r.placement).toBe('below');
    expect(r.top).toBe(70 + 60 + QUICKBAR_GAP);
    expect(overlaps({ top: r.top, height: 44 }, target)).toBe(false);
  });

  it('docks above the bottom bar when neither side has room (a full-height section)', () => {
    const target = { left: 0, top: 40, width: 390, height: 760 };
    const r = placeQuickbar(target, bar, area);
    expect(r.placement).toBe('docked');
    expect(r.top + 44).toBe(780 - QUICKBAR_MARGIN);
  });

  it('never goes under the keyboard', () => {
    // The keyboard covers 340px of 844: the visible bottom is 504.
    const bottom = visibleBottom(844, 780, 340);
    expect(bottom).toBe(504);
    const target = { left: 50, top: 470, width: 100, height: 30 };
    const r = placeQuickbar(target, bar, { ...area, bottom });
    expect(r.placement).toBe('above');
    expect(r.top + 44).toBeLessThanOrEqual(504 - QUICKBAR_MARGIN);
  });

  it('an element hidden by the keyboard still gets a bar inside the visible area', () => {
    const bottom = visibleBottom(844, 780, 340);
    const r = placeQuickbar({ left: 50, top: 600, width: 100, height: 30 }, bar, { ...area, bottom });
    expect(r.top + 44).toBeLessThanOrEqual(bottom - QUICKBAR_MARGIN);
    expect(r.top).toBeGreaterThanOrEqual(area.top + QUICKBAR_MARGIN);
  });

  it('without a keyboard the bottom bar is the limit', () => {
    expect(visibleBottom(844, 780, 0)).toBe(780);
  });

  it('is clamped inside the side margins', () => {
    const left = placeQuickbar({ left: 0, top: 400, width: 20, height: 20 }, bar, area);
    expect(left.left).toBe(QUICKBAR_MARGIN);
    const right = placeQuickbar({ left: 370, top: 400, width: 20, height: 20 }, bar, area);
    expect(right.left).toBe(390 - QUICKBAR_MARGIN - 300);
  });

  it('a bar wider than the screen starts at the margin', () => {
    const r = placeQuickbar({ left: 100, top: 400, width: 20, height: 20 }, { width: 500, height: 44 }, area);
    expect(r.left).toBe(QUICKBAR_MARGIN);
  });
});

describe('placeMenuAtPoint', () => {
  const menu = { width: 200, height: 300 };
  it('opens right of and below the finger', () => {
    expect(placeMenuAtPoint({ x: 50, y: 100 }, menu, area)).toEqual({ left: 62, top: 112 });
  });
  it('flips left and up near the right and bottom edges', () => {
    const r = placeMenuAtPoint({ x: 300, y: 700 }, menu, area);
    expect(r.left).toBe(300 - 12 - 200);
    expect(r.top).toBe(700 - 12 - 300);
  });
  it('stays inside the visible area', () => {
    const r = placeMenuAtPoint({ x: 195, y: 200 }, { width: 380, height: 760 }, area);
    expect(r.left).toBeGreaterThanOrEqual(QUICKBAR_MARGIN);
    expect(r.top).toBeGreaterThanOrEqual(area.top + QUICKBAR_MARGIN);
  });
});
