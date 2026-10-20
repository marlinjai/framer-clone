import { describe, it, expect } from 'vitest';
import {
  frameHeightsKey,
  resolveViewportFrameHeight,
  viewportFrameContentStyle,
  viewportFrameLabel,
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
