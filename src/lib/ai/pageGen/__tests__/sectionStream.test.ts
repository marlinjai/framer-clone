// The streaming section scanner (../sectionStream.ts): finds each complete
// element of the root "nodes" array while the tool input is still arriving,
// the root "outline" the moment it closes, and each element's own label and
// type the moment they are read.

import { describe, expect, it } from 'vitest';
import { createSectionScanner, SCAN_LIMITS, type OpenedElement, type ScanStep } from '../sectionStream';
import { EMIT_PAGE_INPUT, EMIT_PAGE_INPUT_PRETTY, EMIT_PAGE_INPUT_TEXT } from './__fixtures__/emitPageInput';

/** Feed the fragments in order and collect every step. */
function steps(fragments: string[]): ScanStep[] {
  const s = createSectionScanner();
  return fragments.map((f) => s.push(f));
}

/** Feed the fragments in order and collect the complete sections. */
function scan(fragments: string[]): unknown[] {
  return steps(fragments).flatMap((st) => st.sections.map((x) => x.value));
}

/** The complete sections of one step. */
const vals = (step: ScanStep): unknown[] => step.sections.map((x) => x.value);

/** Everything one input reports, merged over its fragments. */
function report(fragments: string[]) {
  const all = steps(fragments);
  const outlines = all.flatMap((st) => (st.outline ? [st.outline] : []));
  return {
    sections: all.flatMap((st) => st.sections),
    outlines,
    opened: all.flatMap((st) => st.opened),
  };
}

const ALL = EMIT_PAGE_INPUT.nodes;

describe('createSectionScanner', () => {
  it('yields every section of a whole input, parsed', () => {
    expect(scan([EMIT_PAGE_INPUT_TEXT])).toEqual(ALL);
    expect(scan([EMIT_PAGE_INPUT_PRETTY])).toEqual(ALL);
  });

  it('yields a section as soon as its closing brace arrives, not before', () => {
    const text = EMIT_PAGE_INPUT_TEXT;
    const firstEnd = text.indexOf(JSON.stringify(ALL[0])) + JSON.stringify(ALL[0]).length;
    const s = createSectionScanner();
    expect(vals(s.push(text.slice(0, firstEnd - 1)))).toEqual([]);
    expect(vals(s.push(text.slice(firstEnd - 1, firstEnd)))).toEqual([ALL[0]]);
    expect(vals(s.push(text.slice(firstEnd)))).toEqual(ALL.slice(1));
  });

  it('ignores escaped quotes, braces and brackets inside strings', () => {
    const input = { nodes: [{ type: 'p', props: { children: 'a \\"} ] [ { \\\\" }' } }, { type: 'div' }] };
    expect(scan([JSON.stringify(input)])).toEqual(input.nodes);
  });

  it('finds "nodes" when it is not the first key, and not inside a string value', () => {
    const input = { title: 'x "nodes": [{"type":"fake"}]', description: 'nodes', nodes: [{ type: 'section' }] };
    expect(scan([JSON.stringify(input)])).toEqual([{ type: 'section' }]);
  });

  it('ignores a "nodes" key below the root', () => {
    const input = { meta: { nodes: [{ type: 'fake' }] }, nodes: [{ type: 'real' }] };
    expect(scan([JSON.stringify(input)])).toEqual([{ type: 'real' }]);
  });

  it('reads a key written with unicode escapes', () => {
    expect(scan(['{"\\u006eodes":[{"type":"div"}]}'])).toEqual([{ type: 'div' }]);
  });

  it('yields nothing for an empty array, and nothing after it closes', () => {
    expect(scan(['{"nodes":[]}'])).toEqual([]);
    expect(scan(['{"nodes":[{"type":"a"}],"extra":[{"type":"b"}]}'])).toEqual([{ type: 'a' }]);
  });

  it('skips elements that are not objects', () => {
    expect(scan(['{"nodes":[1,"two",[3],null,{"type":"div"},true]}'])).toEqual([{ type: 'div' }]);
  });

  it('ignores "nodes" with a value that is not an array', () => {
    expect(scan(['{"nodes":{"type":"x"},"other":[{"type":"y"}]}'])).toEqual([]);
  });

  it('never throws on malformed input, and stops yielding once it is broken', () => {
    const cases = [
      '[{"type":"div"}]',
      'not json',
      '{"nodes":[{"type":"div"]}',
      '{"nodes":[{"type":"div"}}]',
      '}}}]]]',
      '{"nodes":[{"type":"div"},{"type":',
      '\u0000￿{',
    ];
    for (const text of cases) {
      const s = createSectionScanner();
      expect(() => s.push(text)).not.toThrow();
    }
    const s = createSectionScanner();
    expect(vals(s.push('{"nodes":[{"a":1}]]'))).toEqual([{ a: 1 }]);
    expect(s.broken).toBe(true);
    expect(vals(s.push('{"nodes":[{"a":2}]}'))).toEqual([]);
  });

  it('ignores non-string and empty fragments', () => {
    const s = createSectionScanner();
    expect(vals(s.push(''))).toEqual([]);
    expect(vals(s.push(undefined as unknown as string))).toEqual([]);
    expect(vals(s.push(EMIT_PAGE_INPUT_TEXT))).toEqual(ALL);
  });

  it('fuzz: a cut at every offset gives the same sections as the whole input', () => {
    for (const text of [EMIT_PAGE_INPUT_TEXT, EMIT_PAGE_INPUT_PRETTY]) {
      for (let cut = 0; cut <= text.length; cut += 1) {
        // A prefix yields a prefix of the full list (never a wrong or partial section).
        const prefix = scan([text.slice(0, cut)]);
        expect(ALL.slice(0, prefix.length)).toEqual(prefix);
        // The two halves together yield exactly the whole.
        expect(scan([text.slice(0, cut), text.slice(cut)])).toEqual(ALL);
      }
    }
  });

  it('fuzz: one character at a time, and in three cuts, gives the same sections', () => {
    const text = EMIT_PAGE_INPUT_TEXT;
    expect(scan([...text])).toEqual(ALL);
    const step = 37;
    for (let a = 0; a < text.length; a += step) {
      for (let b = a; b < text.length; b += step * 3) {
        expect(scan([text.slice(0, a), text.slice(a, b), text.slice(b)])).toEqual(ALL);
      }
    }
  });
});

const OUTLINE = [
  { title: 'Hero', kind: 'hero' },
  { title: 'Signature breads', kind: 'features' },
  { title: 'Story "with quotes" ]}', kind: 'generic' },
  { title: 'Footer', kind: 'footer' },
];
/** The fixture with the outline written first, as the prompt asks. */
const OUTLINE_FIRST = JSON.stringify({ outline: OUTLINE, ...EMIT_PAGE_INPUT });
const OUTLINE_FIRST_PRETTY = JSON.stringify({ outline: OUTLINE, ...EMIT_PAGE_INPUT }, null, 2);
/** The fixture with the outline written last (key order is not guaranteed). */
const OUTLINE_LAST = JSON.stringify({ ...EMIT_PAGE_INPUT, outline: OUTLINE });
/** What each element of the fixture says about itself, in input order. */
const OPENED: OpenedElement[] = ALL.flatMap((node, slot) => {
  const n = node as { type: string; label: string };
  // The fixture writes "type" before "label" in every section.
  return [
    { slot, key: 'type' as const, value: n.type },
    { slot, key: 'label' as const, value: n.label },
  ];
});

describe('createSectionScanner: outline and opened elements', () => {
  it('numbers the sections by their position in "nodes"', () => {
    expect(report([EMIT_PAGE_INPUT_TEXT]).sections.map((x) => x.slot)).toEqual([0, 1, 2, 3]);
    // Every element of the array, section or not, keeps its position as its slot.
    const r = report(['{"nodes":[{"type":"a"},[1],7,{"type":"b"}]}']);
    expect(r.sections).toEqual([
      { slot: 0, value: { type: 'a' } },
      { slot: 3, value: { type: 'b' } },
    ]);
  });

  it('yields the outline the moment its array closes, before any section opens', () => {
    const end = OUTLINE_FIRST.indexOf(JSON.stringify(OUTLINE)) + JSON.stringify(OUTLINE).length;
    const s = createSectionScanner();
    const before = s.push(OUTLINE_FIRST.slice(0, end - 1));
    expect(before.outline).toBeUndefined();
    expect(before.opened).toEqual([]);
    expect(s.push(OUTLINE_FIRST.slice(end - 1, end)).outline).toEqual(OUTLINE);
    const rest = s.push(OUTLINE_FIRST.slice(end));
    expect(rest.outline).toBeUndefined();
    expect(rest.sections.map((x) => x.value)).toEqual(ALL);
  });

  it('reports each element\'s own type and label as they are read, never a child\'s', () => {
    const r = report([EMIT_PAGE_INPUT_TEXT]);
    expect(r.opened).toEqual(OPENED);
    // The children's labels ("Card") are never reported.
    expect(r.opened.some((o) => o.value === 'Card')).toBe(false);
  });

  it('reports an element as opened before it is complete', () => {
    const text = EMIT_PAGE_INPUT_TEXT;
    const afterLabel = text.indexOf('"label":"Hero"') + '"label":"Hero"'.length;
    const s = createSectionScanner();
    const step = s.push(text.slice(0, afterLabel));
    expect(step.opened).toEqual(OPENED.slice(0, 2));
    expect(step.sections).toEqual([]);
  });

  it('reads the outline written after the nodes too, and the elements open either way', () => {
    const r = report([OUTLINE_LAST]);
    expect(r.outlines).toEqual([OUTLINE]);
    expect(r.opened).toEqual(OPENED);
    expect(r.sections.map((x) => x.value)).toEqual(ALL);
  });

  it('reports nothing for an outline that never closes, and still the sections before it', () => {
    const text = `${EMIT_PAGE_INPUT_TEXT.slice(0, -1)},"outline":[{"title":"Hero","kind":"hero"},{"title":"Fo`;
    const r = report([text]);
    expect(r.outlines).toEqual([]);
    expect(r.sections.map((x) => x.value)).toEqual(ALL);
  });

  it('ignores an outline that is not an array, sits below the root, or only appears in a string', () => {
    expect(report(['{"outline":{"title":"x"},"nodes":[{"type":"a"}]}']).outlines).toEqual([]);
    expect(report(['{"meta":{"outline":[{"title":"x"}]},"nodes":[{"type":"a"}]}']).outlines).toEqual([]);
    expect(report(['{"title":"\\"outline\\":[1]","nodes":[{"type":"a","props":{"outline":[2]}}]}']).outlines).toEqual([]);
    // Only the first outline counts.
    expect(report(['{"outline":[1],"outline":[2],"nodes":[]}']).outlines).toEqual([[1]]);
  });

  it('gives up an outline longer than its bound, and keeps scanning the nodes', () => {
    const long = Array.from({ length: 400 }, (_, i) => ({ title: `Section number ${i}`, kind: 'generic' }));
    expect(JSON.stringify(long).length).toBeGreaterThan(SCAN_LIMITS.outlineChars);
    const r = report([JSON.stringify({ outline: long, nodes: [{ type: 'a', label: 'A' }] })]);
    expect(r.outlines).toEqual([]);
    expect(r.opened).toEqual([
      { slot: 0, key: 'type', value: 'a' },
      { slot: 0, key: 'label', value: 'A' },
    ]);
    expect(r.sections.map((x) => x.value)).toEqual([{ type: 'a', label: 'A' }]);
  });

  it('ignores a label or type that is not a string, too long, or a key of a child object', () => {
    const r = report([
      JSON.stringify({
        nodes: [
          { label: 7, type: { x: 'y' }, props: { label: 'inner', type: 'inner' } },
          { label: 'x'.repeat(SCAN_LIMITS.valueChars + 1), type: 'div' },
          { 'label': 'Escaped key', type: 'p' },
        ],
      }),
    ]);
    expect(r.opened).toEqual([
      { slot: 1, key: 'type', value: 'div' },
      { slot: 2, key: 'label', value: 'Escaped key' },
      { slot: 2, key: 'type', value: 'p' },
    ]);
    expect(r.sections).toHaveLength(3);
  });

  it('reads an element\'s own preset, never a child\'s', () => {
    const r = report(['{"nodes":[{"type":"div","preset":"form","children":[{"type":"a","preset":"button"}]}]}']);
    expect(r.opened).toEqual([
      { slot: 0, key: 'type', value: 'div' },
      { slot: 0, key: 'preset', value: 'form' },
    ]);
  });

  it('keeps a full outline of escaped non-Latin titles (20 entries of 60 characters)', () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ title: 'Ж'.repeat(58) + String(i).padStart(2, '0'), kind: 'generic' }));
    const text = `{"outline":${JSON.stringify(long).replace(/Ж/g, '\\u0416')},"nodes":[]}`;
    expect(report([text]).outlines).toEqual([long]);
  });

  it('decodes escapes in a label, also split inside the escape', () => {
    const text = '{"nodes":[{"label":"Caf\\u00e9 \\"Korn\\"","type":"section"}]}';
    for (let cut = 0; cut <= text.length; cut += 1) {
      const r = report([text.slice(0, cut), text.slice(cut)]);
      expect(r.opened[0]).toEqual({ slot: 0, key: 'label', value: 'Café "Korn"' });
    }
  });

  it('never throws on hostile input around the outline', () => {
    const cases = [
      '{"outline":[',
      '{"outline":[}',
      '{"outline":]',
      '{"outline":[{"title":"\\',
      '{"nodes":[{"label":"\\u12',
      '{"nodes":[{"label":',
      '{"nodes":[{"label"::::}]}',
      `{"outline":[${'['.repeat(5000)}`,
    ];
    for (const text of cases) {
      expect(() => report([text])).not.toThrow();
      expect(() => report([...text])).not.toThrow();
    }
  });

  it('fuzz: a cut at every offset reports the same outline, openings and sections as the whole input', () => {
    for (const text of [OUTLINE_FIRST, OUTLINE_FIRST_PRETTY, OUTLINE_LAST, EMIT_PAGE_INPUT_TEXT]) {
      const whole = report([text]);
      for (let cut = 0; cut <= text.length; cut += 1) {
        expect(report([text.slice(0, cut), text.slice(cut)])).toEqual(whole);
        // A prefix reports a prefix: the outline only once complete, openings in order.
        const prefix = report([text.slice(0, cut)]);
        expect(whole.opened.slice(0, prefix.opened.length)).toEqual(prefix.opened);
        expect(prefix.outlines.length === 0 || JSON.stringify(prefix.outlines) === JSON.stringify(whole.outlines)).toBe(true);
      }
    }
  });

  it('fuzz: one character at a time gives the same report', () => {
    for (const text of [OUTLINE_FIRST, OUTLINE_LAST]) {
      expect(report([...text])).toEqual(report([text]));
    }
  });
});
