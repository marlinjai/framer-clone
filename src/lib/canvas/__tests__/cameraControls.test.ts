import { describe, expect, it } from 'vitest';
import { clampZoom, computeFitTransform, unionRects, zoomAroundPoint, MAX_ZOOM, MIN_ZOOM } from '../cameraControls';

describe('computeFitTransform', () => {
  const visible = { x: 0, y: 48, width: 390, height: 740 };

  it('contain: fits the larger side and centres both ways', () => {
    const content = { x: 100, y: 50, width: 1000, height: 500 };
    const t = computeFitTransform(content, visible, { padding: 20 });
    expect(t.zoom).toBeCloseTo(350 / 1000);
    // Content centre lands on the visible centre.
    const cx = (content.x + content.width / 2) * t.zoom + t.panX;
    const cy = (content.y + content.height / 2) * t.zoom + t.panY;
    expect(cx).toBeCloseTo(visible.x + visible.width / 2);
    expect(cy).toBeCloseTo(visible.y + visible.height / 2);
  });

  it('width: fits the width only and puts the content top at the visible top plus padding', () => {
    const content = { x: 2000, y: 0, width: 320, height: 5000 };
    const t = computeFitTransform(content, visible, { mode: 'width', padding: 16, maxZoom: 2 });
    expect(t.zoom).toBeCloseTo((390 - 32) / 320);
    expect(content.x * t.zoom + t.panX).toBeCloseTo(16);
    expect(content.y * t.zoom + t.panY).toBeCloseTo(48 + 16);
  });

  it('never zooms past maxZoom (a small element is not blown up) and stays in the zoom range', () => {
    const t = computeFitTransform({ x: 0, y: 0, width: 10, height: 10 }, visible);
    expect(t.zoom).toBe(1);
    const huge = computeFitTransform({ x: 0, y: 0, width: 1e7, height: 10 }, visible);
    expect(huge.zoom).toBe(MIN_ZOOM);
  });

  it('survives empty content and a tiny visible area', () => {
    const t = computeFitTransform({ x: 0, y: 0, width: 0, height: 0 }, { x: 0, y: 0, width: 1, height: 1 });
    expect(Number.isFinite(t.zoom) && Number.isFinite(t.panX) && Number.isFinite(t.panY)).toBe(true);
  });
});

describe('zoomAroundPoint', () => {
  it('keeps the world point under the given screen point fixed', () => {
    const t = { zoom: 1, panX: 10, panY: 20 };
    const p = { x: 200, y: 300 };
    const next = zoomAroundPoint(t, p, 2);
    const worldBefore = { x: (p.x - t.panX) / t.zoom, y: (p.y - t.panY) / t.zoom };
    expect(worldBefore.x * next.zoom + next.panX).toBeCloseTo(p.x);
    expect(worldBefore.y * next.zoom + next.panY).toBeCloseTo(p.y);
  });

  it('clamps the zoom', () => {
    expect(zoomAroundPoint({ zoom: 1, panX: 0, panY: 0 }, { x: 0, y: 0 }, 99).zoom).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe('unionRects', () => {
  it('unions rectangles, null for none', () => {
    expect(unionRects([])).toBeNull();
    expect(unionRects([{ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: -5, width: 5, height: 5 }])).toEqual({ x: 0, y: -5, width: 25, height: 15 });
  });
});
