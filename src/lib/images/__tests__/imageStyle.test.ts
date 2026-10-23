import { describe, expect, it } from 'vitest';
import {
  formatFocalPosition,
  overlayLayersOf,
  parseAspectRatio,
  parseFocalPosition,
  photoUrlOf,
  scrimLayer,
  scrimStrengthOf,
  splitLayers,
  withPhotoUrl,
  withScrimStrength,
} from '../imageStyle';

const PHOTO = 'https://images.unsplash.com/photo-1?w=2400&q=80';
const SCRIM = 'linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45))';

describe('background layers', () => {
  it('splits at top-level commas only', () => {
    expect(splitLayers(`${SCRIM}, url("${PHOTO}")`)).toEqual([SCRIM, `url("${PHOTO}")`]);
    expect(splitLayers("url('a,b.jpg'), linear-gradient(red, blue)")).toEqual(["url('a,b.jpg')", 'linear-gradient(red, blue)']);
    expect(splitLayers('  ,  ')).toEqual([]);
  });

  it('finds the photo and the overlays', () => {
    const bg = `${SCRIM}, url("${PHOTO}")`;
    expect(photoUrlOf(bg)).toBe(PHOTO);
    expect(photoUrlOf(`url(${PHOTO})`)).toBe(PHOTO);
    expect(photoUrlOf(SCRIM)).toBeUndefined();
    expect(photoUrlOf(undefined)).toBeUndefined();
    expect(overlayLayersOf(bg)).toEqual([SCRIM]);
  });

  it('sets, replaces and removes the photo while keeping the overlays on top', () => {
    expect(withPhotoUrl(SCRIM, PHOTO)).toBe(`${SCRIM}, url("${PHOTO}")`);
    expect(withPhotoUrl(`${SCRIM}, url("/old.jpg")`, '/new.jpg')).toBe(`${SCRIM}, url("/new.jpg")`);
    expect(withPhotoUrl(`${SCRIM}, url("/old.jpg")`, '')).toBe(SCRIM);
    expect(withPhotoUrl(undefined, '/a.jpg')).toBe('url("/a.jpg")');
    expect(withPhotoUrl('url("/a.jpg")', undefined)).toBe('');
    expect(withPhotoUrl(undefined, '/a"b.jpg')).toBe('url("/a%22b.jpg")');
  });

  it('reads and writes an even scrim strength', () => {
    expect(scrimStrengthOf(`url("${PHOTO}")`)).toBe(0);
    expect(scrimStrengthOf(`${SCRIM}, url("${PHOTO}")`)).toBe(0.45);
    expect(scrimStrengthOf('linear-gradient(to top, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0) 65%)')).toBeUndefined();
    expect(withScrimStrength(`url("${PHOTO}")`, 0.3)).toBe(`${scrimLayer(0.3)}, url("${PHOTO}")`);
    expect(withScrimStrength(`${SCRIM}, url("${PHOTO}")`, 0)).toBe(`url("${PHOTO}")`);
    expect(scrimLayer(1.7)).toBe('linear-gradient(rgba(0, 0, 0, 1), rgba(0, 0, 0, 1))');
  });
});

describe('focal positions', () => {
  it('reads keywords in either order, percentages and the centre fallback', () => {
    expect(parseFocalPosition('center center')).toEqual({ x: 50, y: 50 });
    expect(parseFocalPosition('left top')).toEqual({ x: 0, y: 0 });
    expect(parseFocalPosition('top right')).toEqual({ x: 100, y: 0 });
    expect(parseFocalPosition('bottom')).toEqual({ x: 50, y: 100 });
    expect(parseFocalPosition('right')).toEqual({ x: 100, y: 50 });
    expect(parseFocalPosition('30% 70%')).toEqual({ x: 30, y: 70 });
    expect(parseFocalPosition('140% -3%')).toEqual({ x: 100, y: 0 });
    expect(parseFocalPosition('20px 10px')).toEqual({ x: 50, y: 50 });
    expect(parseFocalPosition(undefined)).toEqual({ x: 50, y: 50 });
  });

  it('formats whole, clamped percentages', () => {
    expect(formatFocalPosition({ x: 62.4, y: 31.6 })).toBe('62% 32%');
    expect(formatFocalPosition({ x: -4, y: 120 })).toBe('0% 100%');
    expect(formatFocalPosition({ x: Number.NaN, y: 10 })).toBe('50% 10%');
  });
});

describe('parseAspectRatio', () => {
  it('reads ratios and refuses the rest', () => {
    expect(parseAspectRatio('16 / 9')).toBeCloseTo(16 / 9);
    expect(parseAspectRatio('4/5')).toBeCloseTo(0.8);
    expect(parseAspectRatio('1.5')).toBe(1.5);
    expect(parseAspectRatio(2)).toBe(2);
    expect(parseAspectRatio('auto')).toBeUndefined();
    expect(parseAspectRatio('0 / 1')).toBeUndefined();
    expect(parseAspectRatio('16 / 0')).toBeUndefined();
  });
});
