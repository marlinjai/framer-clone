// Viewport frame height semantics on the model: viewportHeight is a minimum,
// the measured (volatile) rendered height grows the frame's bounds, and the
// measurement never reaches snapshots, patches (history, multiplayer) or other
// frames.
import { describe, it, expect } from 'vitest';
import { getSnapshot, onPatch } from 'mobx-state-tree';
import { createViewportNode } from '../ComponentModel';

const desktop = () => createViewportNode('vp-desktop', 'bp-d', 'Desktop', 1280, 100, 100, 1280, 800);
const phone = () => createViewportNode('vp-phone', 'bp-p', 'Phone', 320, 2248, 100, 375, 667);

describe('viewport frame height', () => {
  it('bounds use the minimum before any measurement', () => {
    expect(desktop().viewportBounds.height).toBe(800);
  });

  it('bounds grow with content taller than the minimum', () => {
    const vp = desktop();
    vp.setRenderedViewportHeight(2400);
    expect(vp.viewportBounds.height).toBe(2400);
  });

  it('bounds shrink back to the minimum when content gets shorter', () => {
    const vp = desktop();
    vp.setRenderedViewportHeight(2400);
    vp.setRenderedViewportHeight(300);
    expect(vp.viewportBounds.height).toBe(800);
    vp.setRenderedViewportHeight(undefined);
    expect(vp.viewportBounds.height).toBe(800);
  });

  it('a raised minimum (manual resize) wins over shorter content', () => {
    const vp = desktop();
    vp.setRenderedViewportHeight(1200);
    vp.setViewportProperties({ viewportHeight: 1500 });
    vp.setRenderedViewportHeight(1500); // the browser now lays the frame out at the new min
    expect(vp.viewportBounds.height).toBe(1500);
  });

  it('each breakpoint frame measures independently', () => {
    const d = desktop();
    const p = phone();
    d.setRenderedViewportHeight(1900);
    p.setRenderedViewportHeight(4200);
    expect(d.viewportBounds.height).toBe(1900);
    expect(p.viewportBounds.height).toBe(4200);
  });

  it('the measurement is not persisted, synced or recorded in history', () => {
    const vp = desktop();
    const patches: unknown[] = [];
    const dispose = onPatch(vp, p => patches.push(p));
    vp.setRenderedViewportHeight(2400);
    dispose();
    expect(patches).toEqual([]);
    const snap = getSnapshot(vp) as Record<string, unknown>;
    expect(snap).not.toHaveProperty('renderedViewportHeight');
    expect(snap.viewportHeight).toBe(800);
  });

  it('the stored viewport style mirrors the canvas frame: a minimum height, not a fixed one', () => {
    const style = desktop().props.style;
    expect(style.minHeight).toBe('800px');
    expect(style.height).toBeUndefined();
  });

  it('a cancelled resize restores the stored minimum exactly, including none', () => {
    const vp = desktop();
    vp.setViewportProperties({ viewportHeight: 2600 });
    vp.restoreViewportHeight(800);
    expect(vp.viewportHeight).toBe(800);
    vp.restoreViewportHeight(undefined);
    expect(vp.viewportHeight).toBeUndefined();
  });
});
