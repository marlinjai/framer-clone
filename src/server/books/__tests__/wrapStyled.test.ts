// src/server/books/__tests__/wrapStyled.test.ts
//
// The run-aware line breaker of the formatted texts (render/engine/text.ts),
// with a measure where every character is one point wide and a bold one two:
// the plain rule (break at spaces, split only a word wider than a line), a word
// that changes style in its middle, and spaces at a break dropped.

import { describe, expect, it } from 'vitest';

import { wrapStyled, wrapText, type StyledPiece } from '../render/engine/text';

const measure = (text: string, bold: boolean) => [...text].length * (bold ? 2 : 1);
const run = (text: string, bold = false, italic = false): StyledPiece => ({ text, bold, italic });
const plain = (lines: StyledPiece[][]) => lines.map((l) => l.map((p) => p.text).join(''));

describe('the run-aware line breaker', () => {
  it('breaks one plain run exactly as the plain wrapper does', () => {
    const text = 'Vielen Dank für Ihren Auftrag und die gute Zusammenarbeit';
    const font = { widthOfTextAtSize: (t: string) => [...t].length } as unknown as Parameters<typeof wrapText>[1];
    for (const width of [10, 14, 20, 33, 80]) {
      expect(plain(wrapStyled([run(text)], width, measure)), `width ${width}`).toEqual(wrapText(text, font, 1, width));
    }
  });

  it('keeps a word that changes style in its middle together, measured piece by piece', () => {
    // "Auftrag" is "Auf" plain (3) and "trag" bold (8): 11 points, it does not fit after "Ihr " in 12.
    const lines = wrapStyled([run('Ihr Auf'), run('trag', true), run(' kommt')], 12, measure);
    expect(lines).toEqual([[run('Ihr')], [run('Auf'), run('trag', true)], [run('kommt')]]);
  });

  it('merges adjacent pieces of the same style and keeps the space in the style it was typed in', () => {
    const lines = wrapStyled([run('eins '), run('zwei', false, true), run(' drei', false, true)], 100, measure);
    expect(lines).toEqual([[run('eins '), run('zwei drei', false, true)]]);
  });

  it('drops the spaces at a break and prints several spaces as one', () => {
    expect(plain(wrapStyled([run('aaa    bbb')], 5, measure))).toEqual(['aaa', 'bbb']);
    expect(plain(wrapStyled([run('aaa    bbb')], 50, measure))).toEqual(['aaa bbb']);
  });

  it('splits only a word wider than a whole line, across its styles', () => {
    expect(wrapStyled([run('ab'), run('cd', true)], 4, measure)).toEqual([[run('ab'), run('c', true)], [run('d', true)]]);
  });

  it('gives an empty text one empty line', () => {
    expect(wrapStyled([], 10, measure)).toEqual([[]]);
    expect(wrapStyled([run('   ')], 10, measure)).toEqual([[]]);
  });
});
