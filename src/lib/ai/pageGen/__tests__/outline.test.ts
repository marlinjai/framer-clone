// The outline of a running generation (../outline.ts): the model's declared
// entries, the open-element fallback, how the two merge per slot, and that the
// outline never reaches validation.

import { describe, expect, it } from 'vitest';
import { createOutlineBuilder, kindFromElement, normalizeOutline, OUTLINE_MAX_ENTRIES, withoutOutline } from '../outline';

describe('normalizeOutline', () => {
  it('keeps every position, so the slots line up with the sections', () => {
    expect(normalizeOutline([{ title: 'Hero', kind: 'hero' }, 'junk', null, [1], { title: 'Footer', kind: 'footer' }])).toEqual([
      { title: 'Hero', kind: 'hero' },
      { title: '', kind: 'generic' },
      { title: '', kind: 'generic' },
      { title: '', kind: 'generic' },
      { title: 'Footer', kind: 'footer' },
    ]);
  });

  it('takes a known kind in any case, and generic for anything else', () => {
    expect(normalizeOutline([{ title: 'a', kind: ' FAQ ' }, { title: 'b', kind: 'carousel' }, { title: 'c', kind: 3 }, { title: 'd' }]).map((e) => e.kind)).toEqual([
      'faq',
      'generic',
      'generic',
      'generic',
    ]);
  });

  it('sanitises and caps titles, and drops a title that is not text', () => {
    const [a, b, c] = normalizeOutline([
      { title: 'Hero‮\u0000 with​ tricks', kind: 'hero' },
      { title: 'x'.repeat(200), kind: 'hero' },
      { title: { toString: 'no' }, kind: 'hero' },
    ]);
    expect(a.title).toBe('Hero with tricks');
    expect([...b.title].length).toBeLessThanOrEqual(60);
    expect(c.title).toBe('');
  });

  it('keeps at most OUTLINE_MAX_ENTRIES entries', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `S${i}`, kind: 'generic' }));
    expect(normalizeOutline(many)).toHaveLength(OUTLINE_MAX_ENTRIES);
  });
});

describe('kindFromElement', () => {
  it.each([
    ['Hero', 'section', 'hero'],
    ['Site header', 'header', 'hero'],
    [undefined, 'header', 'hero'],
    ['Pricing plans', 'section', 'pricing'],
    ['Häufige Fragen', 'section', 'faq'],
    ['Kundenstimmen', 'section', 'testimonials'],
    ['Galerie', 'section', 'gallery'],
    ['Kontakt', 'section', 'form'],
    [undefined, 'form', 'form'],
    ['Booking', 'div', 'generic'],
    ['Closing call to action', 'section', 'cta'],
    ['Leistungen', 'section', 'features'],
    ['Anything', 'footer', 'footer'],
    ['Fußzeile', 'div', 'footer'],
    ['Story', 'section', 'generic'],
    [undefined, undefined, 'generic'],
  ])('%s / %s is %s', (label, type, kind) => {
    expect(kindFromElement(label, type)).toBe(kind);
  });
});

it('a div with the form preset is a form', () => {
  expect(kindFromElement('Booking', 'div', 'form')).toBe('form');
  expect(kindFromElement('Booking', 'div', 'button')).toBe('generic');
});

describe('createOutlineBuilder', () => {
  it('a declared outline gives the entries at once', () => {
    const b = createOutlineBuilder();
    expect(b.declare([{ title: 'Hero', kind: 'hero' }, { title: 'Footer', kind: 'footer' }])).toBe(true);
    expect(b.entries()).toEqual([
      { title: 'Hero', kind: 'hero' },
      { title: 'Footer', kind: 'footer' },
    ]);
  });

  it('without an outline, each element that opens adds its slot, label first for the title', () => {
    const b = createOutlineBuilder();
    expect(b.open({ slot: 0, key: 'type', value: 'section' })).toBe(true);
    expect(b.entries()).toEqual([{ title: '', kind: 'generic' }]);
    expect(b.open({ slot: 0, key: 'label', value: 'Pricing' })).toBe(true);
    expect(b.entries()).toEqual([{ title: 'Pricing', kind: 'pricing' }]);
    // Reported again: nothing new.
    expect(b.open({ slot: 0, key: 'label', value: 'Other' })).toBe(false);
    // A preset read later can still change the shape.
    expect(b.open({ slot: 1, key: 'type', value: 'div' })).toBe(true);
    expect(b.open({ slot: 1, key: 'preset', value: 'form' })).toBe(true);
    expect(b.entries()[1]).toEqual({ title: '', kind: 'form' });
  });

  it('a gap (an element that opened without a readable label or type) is a generic block', () => {
    const b = createOutlineBuilder();
    b.open({ slot: 0, key: 'label', value: 'Hero' });
    b.open({ slot: 2, key: 'type', value: 'footer' });
    expect(b.entries()).toEqual([
      { title: 'Hero', kind: 'hero' },
      { title: '', kind: 'generic' },
      { title: '', kind: 'footer' },
    ]);
  });

  it('declared entries win at their slots, opened elements fill the slots past the outline', () => {
    const b = createOutlineBuilder();
    b.declare([{ title: 'Hero', kind: 'hero' }]);
    expect(b.open({ slot: 0, key: 'label', value: 'Something else' })).toBe(false);
    expect(b.open({ slot: 1, key: 'label', value: 'FAQ' })).toBe(true);
    expect(b.entries()).toEqual([
      { title: 'Hero', kind: 'hero' },
      { title: 'FAQ', kind: 'faq' },
    ]);
  });

  it('an outline written after the nodes replaces what the elements said, slot by slot', () => {
    const b = createOutlineBuilder();
    b.open({ slot: 0, key: 'label', value: 'Top' });
    b.open({ slot: 1, key: 'label', value: 'Middle' });
    b.open({ slot: 2, key: 'label', value: 'Bottom' });
    expect(b.declare([{ title: 'Hero', kind: 'hero' }, { title: 'Features', kind: 'features' }])).toBe(true);
    expect(b.entries()).toEqual([
      { title: 'Hero', kind: 'hero' },
      { title: 'Features', kind: 'features' },
      { title: 'Bottom', kind: 'generic' },
    ]);
    // Only the first outline counts.
    expect(b.declare([{ title: 'Other', kind: 'cta' }])).toBe(false);
  });

  it('says nothing changed when the merged outline is the same', () => {
    const b = createOutlineBuilder();
    expect(b.declare([])).toBe(false);
    expect(b.entries()).toEqual([]);
  });

  it('never grows past OUTLINE_MAX_ENTRIES, and ignores a slot that is not a position', () => {
    const b = createOutlineBuilder();
    expect(b.open({ slot: OUTLINE_MAX_ENTRIES, key: 'label', value: 'Too far' })).toBe(false);
    expect(b.open({ slot: -1, key: 'label', value: 'Negative' })).toBe(false);
    expect(b.open({ slot: 1.5, key: 'label', value: 'Fraction' })).toBe(false);
    expect(b.entries()).toEqual([]);
  });
});

describe('withoutOutline', () => {
  it('drops the outline and keeps everything else', () => {
    const input = { outline: [{ title: 'Hero', kind: 'hero' }], title: 'T', nodes: [{ type: 'section' }] };
    expect(withoutOutline(input)).toEqual({ title: 'T', nodes: [{ type: 'section' }] });
    // The input itself is left alone.
    expect(input.outline).toHaveLength(1);
  });

  it('returns anything without an outline as it is', () => {
    const input = { nodes: [] };
    expect(withoutOutline(input)).toBe(input);
    expect(withoutOutline(null)).toBe(null);
    expect(withoutOutline([1])).toEqual([1]);
    expect(withoutOutline('x')).toBe('x');
  });
});
