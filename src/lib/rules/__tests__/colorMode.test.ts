// A forced colour mode answers `prefers-color-scheme` in the forms it recognises, and
// leaves everything else exactly as stored (contract docs/plans/2026-11-02-theme-and-head.md,
// "Light and dark", slice T2). The invalid query is proven dead in real browsers by
// test/renderGate/themePublished.gate.ts.

import { describe, expect, it } from 'vitest';
import { withColorMode, wrappersInColorMode } from '../colorMode';
import { parseWrapper } from '../rules';

/** A wrapper exactly as the parser stores it. */
const stored = (text: string): string => {
  const read = parseWrapper(text);
  if (!read.ok) throw new Error(`${text}: ${read.reason}`);
  return read.value;
};

describe('withColorMode', () => {
  it('removes an operand the mode answers yes to, and drops a query it answers no to', () => {
    expect(withColorMode('(prefers-color-scheme: dark)', 'dark')).toEqual({ prelude: '' });
    expect(withColorMode('(prefers-color-scheme: dark)', 'light')).toEqual({ prelude: null });
    expect(withColorMode('(prefers-color-scheme:light)', 'light')).toEqual({ prelude: '' });
    expect(withColorMode('(PREFERS-COLOR-SCHEME: Dark)', 'dark')).toEqual({ prelude: '' });
  });

  it('keeps the other operands of an and-joined query', () => {
    expect(withColorMode('(prefers-color-scheme: dark) and (min-width: 600px)', 'dark')).toEqual({ prelude: '(min-width: 600px)' });
    expect(withColorMode('(min-width: 600px) and (prefers-color-scheme: dark)', 'light')).toEqual({ prelude: null });
    expect(withColorMode('(hover: hover) and (prefers-color-scheme: dark) and (min-width: 600px)', 'dark')).toEqual({
      prelude: '(hover: hover) and (min-width: 600px)',
    });
  });

  it('answers each query of a list on its own, and a list with nothing left is dropped', () => {
    expect(withColorMode('(prefers-color-scheme: dark), print', 'light')).toEqual({ prelude: 'print' });
    expect(withColorMode('print, (prefers-color-scheme: dark)', 'dark')).toEqual({ prelude: '' });
    expect(withColorMode('(prefers-color-scheme: dark), (prefers-color-scheme: dark) and (min-width: 1px)', 'light')).toEqual({ prelude: null });
  });

  it('inverts the answer under not, in both recognised places', () => {
    expect(withColorMode('not (prefers-color-scheme: dark)', 'dark')).toEqual({ prelude: null });
    expect(withColorMode('not (prefers-color-scheme: dark)', 'light')).toEqual({ prelude: '' });
    expect(withColorMode('(not (prefers-color-scheme: light)) and (min-width: 600px)', 'dark')).toEqual({ prelude: '(min-width: 600px)' });
    expect(withColorMode('(not (prefers-color-scheme: light)) and (min-width: 600px)', 'light')).toEqual({ prelude: null });
  });

  it('leaves the invalid `not ... and` query as stored, because a browser reads it as not all', () => {
    const invalid = 'not (prefers-color-scheme: dark) and (min-width: 600px)';
    for (const mode of ['light', 'dark'] as const) {
      const read = withColorMode(invalid, mode);
      expect(read.prelude).toBe(invalid);
      expect(read.warning).toMatch(/cannot answer/);
    }
  });

  it('leaves the boolean form as stored with no warning, since it matches in both modes', () => {
    expect(withColorMode('(prefers-color-scheme)', 'light')).toEqual({ prelude: '(prefers-color-scheme)' });
    expect(withColorMode('(prefers-color-scheme) and (min-width: 1px)', 'dark')).toEqual({ prelude: '(prefers-color-scheme) and (min-width: 1px)' });
  });

  it('leaves an or holding the feature as stored, and reports it', () => {
    const text = '((prefers-color-scheme: dark) or (min-width: 600px))';
    const read = withColorMode(text, 'light');
    expect(read.prelude).toBe(text);
    expect(read.warning).toContain('or (min-width: 600px)');
    expect(withColorMode('(prefers-color-scheme: dark) or (min-width: 600px)', 'dark').prelude).toBe('(prefers-color-scheme: dark) or (min-width: 600px)');
  });

  it('leaves a media type, an unbalanced prelude and a prelude without the feature as stored', () => {
    expect(withColorMode('screen and (prefers-color-scheme: dark)', 'light').prelude).toBe('screen and (prefers-color-scheme: dark)');
    expect(withColorMode('(prefers-color-scheme: dark', 'light').prelude).toBe('(prefers-color-scheme: dark');
    expect(withColorMode('(min-width: 600px)', 'light')).toEqual({ prelude: '(min-width: 600px)' });
    // A value other than light or dark is the browser's to read.
    expect(withColorMode('(prefers-color-scheme: no-preference)', 'light')).toEqual({ prelude: '(prefers-color-scheme: no-preference)' });
  });

  // T2 code review, finding 1: each of these never matches on a forced light or dark
  // site in Chromium and WebKit, so a rewrite must never make it live.
  it('leaves a list with a blank member as stored, since it would otherwise read as always true', () => {
    for (const prelude of [
      '(prefers-color-scheme: dark) and (min-width: 600px),',
      ', (prefers-color-scheme: dark)',
      '(prefers-color-scheme: dark), ,(min-width: 1px)',
    ]) {
      for (const mode of ['light', 'dark'] as const) {
        const read = withColorMode(prelude, mode);
        expect(read.prelude, `${prelude} under ${mode}`).toBe(prelude);
        expect(read.warning).toMatch(/empty query/);
      }
    }
  });

  it('leaves and without white space on both sides as stored, since a browser reads it as not all', () => {
    for (const prelude of [
      '(prefers-color-scheme: dark) and(min-width: 600px)',
      '(prefers-color-scheme: dark)and (min-width: 600px)',
      '(prefers-color-scheme: dark)(min-width: 600px)',
      'not(prefers-color-scheme: dark)',
    ]) {
      for (const mode of ['light', 'dark'] as const) {
        const read = withColorMode(prelude, mode);
        expect(read.prelude, `${prelude} under ${mode}`).toBe(prelude);
        expect(read.warning).toBeDefined();
      }
    }
  });

  it('leaves a list with an unread member whole as stored, unless another member makes it true', () => {
    const list = '(prefers-color-scheme: dark), screen and (prefers-color-scheme: dark)';
    const read = withColorMode(list, 'light');
    expect(read.prelude).toBe(list);
    expect(read.warning).toBeDefined();
    // A member the mode makes true makes the whole list true, whatever the others say.
    expect(withColorMode(list, 'dark').prelude).toBe('');
  });
});

describe('wrappersInColorMode', () => {
  it('answers @media wrappers as the parser stores them, and leaves every other wrapper alone', () => {
    const dark = stored('@media (prefers-color-scheme: dark)');
    const wide = stored('@media (min-width: 600px)');
    const supports = stored('@supports (display: grid)');
    expect(wrappersInColorMode([dark], 'dark')).toEqual([]);
    expect(wrappersInColorMode([dark], 'light')).toBeNull();
    expect(wrappersInColorMode([supports, dark, wide], 'dark')).toEqual([supports, wide]);
    expect(wrappersInColorMode([supports, wide], 'light')).toEqual([supports, wide]);
    expect(wrappersInColorMode([stored('@media (prefers-color-scheme: dark) and (min-width: 600px)')], 'dark')).toEqual(['@media (min-width: 600px)']);
  });

  it('keeps a wrapper it cannot answer byte for byte, and reports it', () => {
    const warnings: string[] = [];
    const wrapper = stored('@media not (prefers-color-scheme: dark) and (min-width: 600px)');
    expect(wrappersInColorMode([wrapper], 'light', (w) => warnings.push(w))).toEqual([wrapper]);
    expect(warnings).toHaveLength(1);
  });
});
