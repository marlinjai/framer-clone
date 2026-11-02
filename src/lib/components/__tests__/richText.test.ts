import { describe, expect, it } from 'vitest';
import { formatRuns, parseRuns } from '../richText';
import { parseInputValue } from '../inputs';

const input = { id: 'body', name: 'Body', type: 'richtext' as const };

describe('parseRuns', () => {
  it('reads plain text as one run', () => {
    expect(parseRuns('Hello world')).toEqual({ runs: [{ text: 'Hello world' }] });
  });

  it('reads empty text as no runs', () => {
    expect(parseRuns('')).toEqual({ runs: [] });
  });

  it('reads bold, italic and underline', () => {
    expect(parseRuns('a **b** *c* __d__')).toEqual({
      runs: [
        { text: 'a ' },
        { text: 'b', marks: ['strong'] },
        { text: ' ' },
        { text: 'c', marks: ['em'] },
        { text: ' ' },
        { text: 'd', marks: ['u'] },
      ],
    });
  });

  it('reads bold and italic together from three stars', () => {
    expect(parseRuns('***both***')).toEqual({ runs: [{ text: 'both', marks: ['strong', 'em'] }] });
  });

  it('reads bold inside italic', () => {
    expect(parseRuns('*a **b** c*')).toEqual({
      runs: [
        { text: 'a ', marks: ['em'] },
        { text: 'b', marks: ['strong', 'em'] },
        { text: ' c', marks: ['em'] },
      ],
    });
  });

  it('reads a link, with marks in its label and around it', () => {
    expect(parseRuns('See [the **shop**](/shop) or **[help](/help)**')).toEqual({
      runs: [
        { text: 'See ' },
        { text: 'the ', href: '/shop' },
        { text: 'shop', marks: ['strong'], href: '/shop' },
        { text: ' or ' },
        { text: 'help', marks: ['strong'], href: '/help' },
      ],
    });
  });

  it('keeps an unpaired marker as text', () => {
    expect(parseRuns('2 * 3 and [not a link and **open')).toEqual({ runs: [{ text: '2 * 3 and [not a link and **open' }] });
  });

  it('keeps an escaped marker as text', () => {
    expect(parseRuns('\\*not italic\\*')).toEqual({ runs: [{ text: '*not italic*' }] });
  });

  it('keeps a link with an empty address as text', () => {
    expect(parseRuns('[label]()')).toEqual({ runs: [{ text: '[label]()' }] });
  });

  it('gives runs the input check takes, and an unsafe address the check refuses', () => {
    expect(parseInputValue(input, parseRuns('**Hi** [there](/there)')).ok).toBe(true);
    const unsafe = parseInputValue(input, parseRuns('[x](javascript:alert(1))'));
    expect(unsafe.ok).toBe(false);
  });
});

describe('formatRuns', () => {
  it('writes back what parseRuns reads', () => {
    for (const source of ['Hello', 'a **b** *c* __d__', '***both***', 'See [the **shop**](/shop) or **[help](/help)**', '\\*literal\\*']) {
      const runs = parseRuns(source);
      expect(parseRuns(formatRuns(runs))).toEqual(runs);
    }
  });

  it('shows a plain string with its markers kept literal', () => {
    const shown = formatRuns('5 * 3 [x]');
    expect(parseRuns(shown)).toEqual({ runs: [{ text: '5 * 3 [x]' }] });
  });

  it('shows nothing for a value that is not formatted text', () => {
    expect(formatRuns(42)).toBe('');
    expect(formatRuns({ nope: true })).toBe('');
    expect(formatRuns(null)).toBe('');
  });
});
