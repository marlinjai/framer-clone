// @vitest-environment node
// The text box's canvas layout (drawTextBox) under the extremes its settings allow, with a stand-in
// canvas whose text is 0.6 of the font size wide per character. The review of slice L3 found the
// padding of a stroke or of letter spacing shrinking or flipping the plane on a narrow screen, glyphs
// drawn bigger than `size`, and lines silently cut; these hold that none of it comes back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { anchorOffset, drawTextBox, type TextBoxSpec } from '../layers/textBox';

let fontPx = 10;
function fakeCanvas() {
  const ctx = {
    clearRect() {},
    fillText() {},
    strokeText() {},
    measureText: (t: string) => ({ width: Array.from(t).length * fontPx * 0.6 }),
    set font(v: string) {
      fontPx = Number(/(\d+(?:\.\d+)?)px/.exec(v)?.[1] ?? 10);
    },
  };
  return { width: 0, height: 0, getContext: () => ctx };
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
});
afterEach(() => vi.unstubAllGlobals());

const base: TextBoxSpec = {
  text: 'Hello world',
  font: 'Arial',
  weight: '500',
  size: 0.08,
  lineHeight: 1.2,
  letterSpacing: 0,
  align: 'center',
  color: '#fff',
  strokeColor: '#000',
  strokeWidth: 0,
  width: 0.6,
  viewportWidth: 8,
  viewportHeight: 4.66,
};

/** What the layer does with the layout: the plane the text rectangle stands for the box on. */
function plane(spec: TextBoxSpec) {
  const { layout } = drawTextBox(spec);
  const boxWidth = spec.width * spec.viewportWidth;
  const planeWidth = boxWidth * (layout.canvasWidth / layout.textWidth);
  return { layout, boxWidth, planeWidth, planeHeight: (planeWidth * layout.canvasHeight) / layout.canvasWidth };
}

describe('drawTextBox', () => {
  const extremes: [string, Partial<TextBoxSpec>][] = [
    ['phone, large narrow text', { viewportWidth: 2.1, viewportHeight: 4.66, width: 0.2, size: 0.2 }],
    ['phone, letter spacing', { viewportWidth: 2.1, viewportHeight: 4.66, width: 0.35, letterSpacing: 0.2 }],
    ['biggest size in the narrowest box', { size: 0.5, width: 0.05, viewportWidth: 2.1 }],
    ['thick stroke and wide spacing', { strokeWidth: 0.2, letterSpacing: 0.5 }],
    ['negative spacing', { letterSpacing: -0.1 }],
    ['200 characters', { text: 'word '.repeat(40).trim(), size: 0.05, viewportWidth: 2.1 }],
  ];

  it.each(extremes)('keeps a positive plane within texture limits: %s', (_name, change) => {
    const { layout, planeWidth, planeHeight } = plane({ ...base, ...change });
    expect(layout.textWidth).toBeGreaterThanOrEqual(8);
    expect(layout.canvasWidth).toBe(layout.textWidth + 2 * layout.pad);
    expect(layout.canvasHeight).toBeLessThanOrEqual(4096);
    expect(layout.canvasWidth).toBeLessThanOrEqual(4096);
    expect(Number.isFinite(planeWidth) && planeWidth > 0).toBe(true);
    expect(Number.isFinite(planeHeight) && planeHeight > 0).toBe(true);
  });

  it('draws the text rectangle exactly as wide as the box, whatever the stroke or spacing', () => {
    for (const change of [{}, { strokeWidth: 0.2 }, { letterSpacing: 0.5 }, { strokeWidth: 0.2, letterSpacing: 0.5 }]) {
      const { layout, boxWidth, planeWidth } = plane({ ...base, ...change });
      const textWorldWidth = (planeWidth * layout.textWidth) / layout.canvasWidth;
      expect(textWorldWidth).toBeCloseTo(boxWidth, 6);
    }
  });

  it('draws glyphs `size` of the scene height tall in world units, whatever the stroke or spacing', () => {
    for (const change of [{}, { strokeWidth: 0.2 }, { letterSpacing: 0.5 }, { width: 0.2 }]) {
      const spec = { ...base, ...change };
      const { layout, boxWidth } = plane(spec);
      // World height of the font: pixels of the font over pixels per world unit.
      const worldFont = layout.fontPx * (boxWidth / layout.textWidth);
      expect(worldFont).toBeCloseTo(spec.size * spec.viewportHeight, 6);
    }
  });

  it('does not drop lines that would be visible: seven short lines in a narrow box all stay', () => {
    const text = Array.from({ length: 7 }, (_, i) => `L${i}`).join('\n');
    const { layout } = plane({ ...base, size: 0.1, width: 0.2, text });
    expect(layout.lines).toHaveLength(7);
  });

  it('a 200 character text on a phone keeps every line', () => {
    const text = 'word '.repeat(40).trim();
    const { layout } = plane({ ...base, text, size: 0.05, width: 0.6, viewportWidth: 2.1 });
    expect(layout.lines.join(' ')).toBe(text);
  });

  it('gives a small canvas, not a failure, for empty text', () => {
    const { layout } = plane({ ...base, text: '' });
    expect(layout.lines).toEqual([]);
    expect(layout.canvasHeight).toBeGreaterThanOrEqual(4);
  });

  it('puts the text rectangle on the anchor point', () => {
    const { layout, planeWidth, planeHeight } = plane({ ...base, strokeWidth: 0.2, letterSpacing: 0.3 });
    const [x] = anchorOffset('top left', { width: planeWidth, height: planeHeight }, layout);
    // The left edge of the text rectangle is the anchor: the plane's centre is half the box width to its right.
    expect(x).toBeCloseTo((base.width * base.viewportWidth) / 2, 6);
  });
});
