import { describe, it, expect } from 'vitest';
import {
  clipRectToFrame,
  frameHeightsKey,
  resolveViewportFrameHeight,
  viewportFrameContentStyle,
  viewportFrameLabel,
  viewportResizeUpdate,
} from '../viewportFrame';

describe('resolveViewportFrameHeight', () => {
  it('grows to content taller than the minimum', () => {
    expect(resolveViewportFrameHeight(800, 2400)).toBe(2400);
  });

  it('stays at the minimum for shorter content', () => {
    expect(resolveViewportFrameHeight(800, 300)).toBe(800);
  });

  it('falls back to the minimum before the first measurement', () => {
    expect(resolveViewportFrameHeight(667, undefined)).toBe(667);
    expect(resolveViewportFrameHeight(667, Number.NaN)).toBe(667);
  });

  it('rounds sub-pixel measurements', () => {
    expect(resolveViewportFrameHeight(667, 1200.4)).toBe(1200);
  });
});

describe('viewportFrameLabel', () => {
  it('shows the real rendered size and names the minimum once grown', () => {
    expect(viewportFrameLabel(375, 667, 3120)).toEqual({ size: '375×3120', minNote: 'min 667' });
  });

  it('shows just the minimum while the content fits', () => {
    expect(viewportFrameLabel(1280, 800, 500)).toEqual({ size: '1280×800', minNote: null });
    expect(viewportFrameLabel(1280, 800, undefined)).toEqual({ size: '1280×800', minNote: null });
  });
});

describe('viewportFrameContentStyle', () => {
  const style = viewportFrameContentStyle(1024);

  it('has a minimum height and no fixed height, so the frame can grow', () => {
    expect(style.minHeight).toBe('1024px');
    expect(style.height).toBeUndefined();
  });

  it('gives the page root a definite area of at least the minimum (no loop for 100% heights)', () => {
    expect(style.display).toBe('grid');
    expect(style.gridTemplateRows).toBe('minmax(1024px, auto)');
    expect(style.gridTemplateColumns).toBe('minmax(0, 1fr)');
    expect(style.alignItems).toBe('start');
  });

  it('never scrolls and clips positioned descendants', () => {
    expect(style.overflow).toBe('hidden');
    expect(style.position).toBe('relative');
    expect(style.contain).toBe('paint');
  });
});

describe('frameHeightsKey', () => {
  it('changes when any frame height changes', () => {
    const a = frameHeightsKey([{ id: 'd', renderedViewportHeight: 800 }, { id: 'p', renderedViewportHeight: 667 }]);
    const b = frameHeightsKey([{ id: 'd', renderedViewportHeight: 800 }, { id: 'p', renderedViewportHeight: 1900 }]);
    expect(a).not.toBe(b);
  });

  it('is empty without a page', () => {
    expect(frameHeightsKey(undefined)).toBe('');
  });
});

describe('clipRectToFrame', () => {
  const frame = { left: 100, top: 100, width: 375, height: 1200 };

  it('keeps a rect fully inside the frame', () => {
    const r = { left: 120, top: 200, width: 100, height: 50 };
    expect(clipRectToFrame(r, frame)).toEqual(r);
  });

  it('cuts off the part of wide content the frame clips on the side', () => {
    expect(clipRectToFrame({ left: 400, top: 200, width: 300, height: 50 }, frame))
      .toEqual({ left: 400, top: 200, width: 75, height: 50 });
  });

  it('returns null for content clipped away entirely (e.g. positioned past the frame)', () => {
    expect(clipRectToFrame({ left: 600, top: 3000, width: 50, height: 50 }, frame)).toBeNull();
  });

  it('passes the rect through when there is no frame (floating elements)', () => {
    const r = { left: 0, top: 0, width: 10, height: 10 };
    expect(clipRectToFrame(r, null)).toEqual(r);
  });
});

describe('viewportResizeUpdate', () => {
  // Desktop: stored minimum 800, grown to 2600 by its content.
  const startHeight = 2600;

  it('a width-only drag never writes the grown height as the minimum', () => {
    expect(viewportResizeUpdate({ newWidth: 1400.4, newHeight: startHeight, startHeight, vertical: false }))
      .toEqual({ viewportWidth: 1400 });
  });

  it('a corner drag that stayed level leaves the minimum alone', () => {
    expect(viewportResizeUpdate({ newWidth: 1300, newHeight: startHeight, startHeight, vertical: true }))
      .toEqual({ viewportWidth: 1300 });
  });

  it('a vertical drag that moved the edge sets the new minimum', () => {
    expect(viewportResizeUpdate({ newWidth: 1280, newHeight: 3000.2, startHeight, vertical: true }))
      .toEqual({ viewportWidth: 1280, viewportHeight: 3000 });
  });
});
