// The streaming section scanner (../sectionStream.ts): finds each complete
// element of the root "nodes" array while the tool input is still arriving.

import { describe, expect, it } from 'vitest';
import { createSectionScanner } from '../sectionStream';
import { EMIT_PAGE_INPUT, EMIT_PAGE_INPUT_PRETTY, EMIT_PAGE_INPUT_TEXT } from './__fixtures__/emitPageInput';

/** Feed the fragments in order and collect everything yielded. */
function scan(fragments: string[]): unknown[] {
  const s = createSectionScanner();
  return fragments.flatMap((f) => s.push(f));
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
    expect(s.push(text.slice(0, firstEnd - 1))).toEqual([]);
    expect(s.push(text.slice(firstEnd - 1, firstEnd))).toEqual([ALL[0]]);
    expect(s.push(text.slice(firstEnd))).toEqual(ALL.slice(1));
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
    expect(s.push('{"nodes":[{"a":1}]]')).toEqual([{ a: 1 }]);
    expect(s.broken).toBe(true);
    expect(s.push('{"nodes":[{"a":2}]}')).toEqual([]);
  });

  it('ignores non-string and empty fragments', () => {
    const s = createSectionScanner();
    expect(s.push('')).toEqual([]);
    expect(s.push(undefined as unknown as string)).toEqual([]);
    expect(s.push(EMIT_PAGE_INPUT_TEXT)).toEqual(ALL);
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
