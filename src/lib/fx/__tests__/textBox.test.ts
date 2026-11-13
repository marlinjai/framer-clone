// @vitest-environment node
// The free-positioned text box layer (kind `textBox`, plan docs/plans/2026-11-13-fx-layers-in-layers-panel.md,
// slice L3): its schema through the strict reader (every setting clamped, nothing valid refused), its
// round trip through serialize and parse, and the pure layout the layer draws with. The picture itself
// is checked in a real browser (test/behaviour/fxTextBox.spec.ts).

import { describe, expect, it } from 'vitest';

import '../builtins';
import { FX_LIMITS, PRESETS, deserializeScene, parseFx, serializeScene, toStoredFx } from '../format';
import goldJson from '../presets/preset-gold-noise-gradient.json';
import { anchorFractions, anchorOffset, wrapText } from '../layers/textBox';
import { getLayerSchema } from '../registry';
import { TEXT_BOX_ANCHORS, FONT_OPTIONS } from '../schemas';

const textBoxDefaults = () => Object.fromEntries(Object.entries(getLayerSchema('textBox')!.defaultParams).map(([k, s]) => [k, s.value]));

/** A stored scene holding one text box with the given settings (the rest take their defaults). */
function stored(params: Record<string, unknown>, extra: unknown[] = []) {
  return {
    version: 1,
    start: 'immediate',
    calm: 'frame',
    scene: {
      version: 1,
      id: 'box',
      size: { mode: 'fill' },
      background: '#000000',
      fps: 60,
      dpr: [1, 1],
      layers: [{ id: 'words', type: 'textBox', name: 'Words', visible: true, blend: 'normal', params }, ...extra],
    },
  };
}

function read(params: Record<string, unknown>) {
  const result = parseFx(stored(params));
  if (!result.ok) throw new Error(result.message);
  const layer = result.fx.scene.layers.find((l) => l.id === 'words')!;
  return { values: Object.fromEntries(Object.entries(layer.params).map(([k, s]) => [k, s.value])), notes: result.notes };
}

describe('the textBox kind', () => {
  it('is a built-in content layer with the settings of the plan', () => {
    const schema = getLayerSchema('textBox');
    expect(schema?.kind).toBe('content');
    expect(Object.keys(schema!.defaultParams)).toEqual([
      'text',
      'font',
      'weight',
      'size',
      'lineHeight',
      'letterSpacing',
      'align',
      'color',
      'strokeColor',
      'strokeWidth',
      'position',
      'anchor',
      'width',
      'rotation',
      'opacity',
      'reveal',
      'parallax',
    ]);
  });

  it('offers the lockup\'s fixed system fonts and nine anchors', () => {
    const params = getLayerSchema('textBox')!.defaultParams;
    expect(params.font).toMatchObject({ type: 'select', options: FONT_OPTIONS });
    expect(params.anchor).toMatchObject({ type: 'select', options: TEXT_BOX_ANCHORS });
    expect(TEXT_BOX_ANCHORS).toHaveLength(9);
  });

  it('refuses nothing valid: a full set of in-range settings is read exactly, with no note', () => {
    const given = {
      text: 'Line one\nLine two',
      font: 'Georgia',
      weight: '700',
      size: 0.12,
      lineHeight: 1.5,
      letterSpacing: 0.05,
      align: 'left',
      color: '#c9a04a',
      strokeColor: '#101010',
      strokeWidth: 0.05,
      position: [0.25, 0.75],
      anchor: 'bottom left',
      width: 0.4,
      rotation: -12,
      opacity: 0.8,
      reveal: 2.5,
      parallax: 0.2,
    };
    const { values, notes } = read(given);
    expect(notes).toEqual([]);
    expect(values).toEqual(given);
  });

  it('settings left out take their defaults without a note', () => {
    const { values, notes } = read({});
    expect(notes).toEqual([]);
    expect(values).toEqual(textBoxDefaults());
  });

  it.each([
    ['size', 5, 0.5],
    ['size', -1, 0.01],
    ['lineHeight', 99, 2.5],
    ['lineHeight', 0, 0.8],
    ['letterSpacing', 9, 0.5],
    ['letterSpacing', -9, -0.1],
    ['strokeWidth', 3, 0.2],
    ['strokeWidth', -3, 0],
    ['width', 4, 1],
    ['width', 0, 0.05],
    ['rotation', 720, 180],
    ['rotation', -720, -180],
    ['opacity', 7, 1],
    ['opacity', -7, 0],
    ['reveal', 60, 5],
    ['reveal', -1, 0],
    ['parallax', 9, 0.6],
    ['parallax', -9, 0],
  ])('clamps %s = %s to %s and says so', (key, given, expected) => {
    const { values, notes } = read({ [key]: given });
    expect(values[key]).toBe(expected);
    expect(notes.some((n) => n.includes('Words'))).toBe(true);
  });

  it('moves a position outside the scene back inside it', () => {
    const { values, notes } = read({ position: [-2, 9] });
    expect(values.position).toEqual([0, 1]);
    expect(notes).toHaveLength(1);
  });

  it.each([
    ['font', 'Comic Sans'],
    ['font', 'url(https://example.com/f.woff)'],
    ['weight', '950'],
    ['weight', 700],
    ['align', 'justify'],
    ['anchor', 'upper left'],
    ['color', 'url(https://example.com/a.png)'],
    ['strokeColor', 'not a colour'],
    ['size', 'big'],
    ['position', [0.5]],
    ['position', 'center'],
    ['text', 42],
  ])('a wrong %s (%j) falls back to the default instead of being drawn', (key, given) => {
    const { values } = read({ [key]: given });
    expect(values[key]).toEqual(textBoxDefaults()[key]);
  });

  it('cuts a text longer than FX_LIMITS.text and keeps line breaks', () => {
    const long = `${'a'.repeat(FX_LIMITS.text - 3)}\nb\nc\nd`;
    const { values, notes } = read({ text: long });
    expect((values.text as string).length).toBe(FX_LIMITS.text);
    expect(notes.some((n) => n.includes('cut'))).toBe(true);
    expect(read({ text: 'one\ntwo\nthree' }).values.text).toBe('one\ntwo\nthree');
  });

  it('keeps markup as plain text: it is drawn to a canvas, never parsed', () => {
    const markup = '<img src=x onerror=alert(1)>';
    expect(read({ text: markup }).values.text).toBe(markup);
  });
});

describe('a scene with a text box', () => {
  it('survives serialize, store and read again unchanged (the storing path)', () => {
    const first = parseFx(stored({ text: 'Hello\nthere', position: [0.1, 0.9], anchor: 'top right', rotation: 5 }));
    if (!first.ok) throw new Error(first.message);
    expect(first.notes).toEqual([]);
    const written = JSON.parse(JSON.stringify(toStoredFx(first.fx)));
    const again = parseFx(written);
    if (!again.ok) throw new Error(again.message);
    expect(again.notes).toEqual([]);
    expect(JSON.stringify(again.fx)).toBe(JSON.stringify(first.fx));
    expect(JSON.stringify(serializeScene(again.fx.scene))).toBe(JSON.stringify(serializeScene(first.fx.scene)));
  });

  it('can be the source of a god rays pass, which is kept pointing at it', () => {
    const godRays = {
      id: 'rays',
      type: 'godRays',
      name: 'God Rays',
      visible: true,
      blend: 'normal',
      params: { sourceLayerId: 'words' },
    };
    const result = parseFx(stored({ text: 'Sun' }, [godRays]));
    if (!result.ok) throw new Error(result.message);
    const rays = result.fx.scene.layers.find((l) => l.id === 'rays')!;
    expect(rays.params.sourceLayerId.value).toBe('words');
    expect(result.notes).toEqual([]);
  });

  it('is left out with a note, not refused, by a reader that does not know the kind (the rollback path)', () => {
    const result = parseFx(stored({}, [{ id: 'x', type: 'someFutureKind', params: {} }]));
    if (!result.ok) throw new Error(result.message);
    expect(result.fx.scene.layers.map((l) => l.id)).toEqual(['words']);
    expect(result.notes.some((n) => n.includes('someFutureKind'))).toBe(true);
  });

  it('leaves every preset exactly as it was: none holds a text box, and each still serializes to its own file', () => {
    for (const preset of PRESETS) {
      const scene = preset.load();
      expect(scene.layers.some((l) => l.type === 'textBox')).toBe(false);
    }
    const gold = PRESETS.find((p) => p.id === 'gold-noise-gradient')!.load();
    expect(JSON.stringify(serializeScene(gold))).toBe(JSON.stringify(serializeScene(deserializeScene(goldJson))));
    expect(gold.layers.map((l) => l.type)).toEqual((goldJson as { layers: { type: string }[] }).layers.map((l) => l.type));
  });
});

describe('wrapText', () => {
  // Every character is 10 wide, so a line of n characters measures 10n.
  const measure = (t: string) => t.length * 10;

  it('keeps a text that fits on one line', () => {
    expect(wrapText('hello world', 200, measure)).toEqual(['hello world']);
  });

  it('wraps at spaces', () => {
    expect(wrapText('one two three four', 90, measure)).toEqual(['one two', 'three', 'four']);
  });

  it('keeps the line breaks the text has, blank lines included, and drops trailing ones', () => {
    expect(wrapText('a\n\nb\n\n', 100, measure)).toEqual(['a', '', 'b']);
    expect(wrapText('a\r\nb', 100, measure)).toEqual(['a', 'b']);
  });

  it('never splits an emoji when it cuts a long word', () => {
    const out = wrapText('😀😀😀😀😀😀', 45, measure);
    expect(out.length).toBeGreaterThan(1);
    expect(out.join('')).toBe('😀😀😀😀😀😀');
    for (const l of out) expect(Array.from(l).every((c) => c === '😀')).toBe(true);
  });

  it('cuts a word wider than the whole line, so nothing leaves the box', () => {
    expect(wrapText('abcdefghij', 40, measure)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('x abcdefghij', 40, measure)).toEqual(['x', 'abcd', 'efgh', 'ij']);
  });

  it('adds no blank line when the last piece of a cut word is a single character wider than the line', () => {
    expect(wrapText('AB\nCD', 5, measure)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('keeps a joined emoji and an accented letter whole when it cuts a word', () => {
    const family = '👨‍👩‍👧';
    expect(wrapText(`${family}${family}`, 1, () => 10).every((l) => l === family)).toBe(true);
    expect(wrapText('e\u0301e\u0301', 1, () => 10)).toEqual(['e\u0301', 'e\u0301']);
  });

  it('gives nothing for an empty or blank text', () => {
    expect(wrapText('', 100, measure)).toEqual([]);
    expect(wrapText('  \n \n', 100, measure)).toEqual([]);
  });

  it('terminates when a single character is wider than the line', () => {
    expect(wrapText('abc', 5, measure)).toEqual(['a', 'b', 'c']);
  });
});

describe('the nine anchors', () => {
  it.each([
    ['top left', [0, 0]],
    ['top center', [0.5, 0]],
    ['top right', [1, 0]],
    ['middle left', [0, 0.5]],
    ['center', [0.5, 0.5]],
    ['middle right', [1, 0.5]],
    ['bottom left', [0, 1]],
    ['bottom center', [0.5, 1]],
    ['bottom right', [1, 1]],
  ])('%s sits at %j of the text rectangle', (anchor, expected) => {
    expect(anchorFractions(anchor)).toEqual(expected);
  });

  it('an unknown anchor is the centre', () => {
    expect(anchorFractions('nowhere')).toEqual([0.5, 0.5]);
  });

  it('puts the anchor of the text rectangle (padding excluded) on the anchor point', () => {
    // A plane 10 by 4 whose canvas is 1000 by 400 pixels with 50 pixels of padding: the text is 9 by 3.
    const layout = { canvasWidth: 1000, canvasHeight: 400, pad: 50 };
    const plane = { width: 10, height: 4 };
    expect(anchorOffset('center', plane, layout)).toEqual([0, 0]);
    const [x, y] = anchorOffset('top left', plane, layout);
    expect(x).toBeCloseTo(4.5);
    expect(y).toBeCloseTo(-1.5);
    const [bx, by] = anchorOffset('bottom right', plane, layout);
    expect(bx).toBeCloseTo(-4.5);
    expect(by).toBeCloseTo(1.5);
  });
});
