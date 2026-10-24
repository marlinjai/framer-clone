// src/server/books/render/engine/text.ts
//
// Line breaking for the layout engine, measured with the embedded faces (the
// same widths pdf-lib draws with, so a measured line never wraps differently
// when drawn). The same rule as the version 1 renderer: break at spaces; a
// single word wider than a whole line is the only thing split inside a word.

import type { PDFFont } from 'pdf-lib';

export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  if (text === '') return [''];
  const lines: string[] = [];
  let current = '';
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= width;
  for (const word of text.split(' ')) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    if (fits(word)) {
      current = word;
      continue;
    }
    let piece = '';
    for (const ch of word) {
      if (piece === '' || fits(piece + ch)) piece += ch;
      else {
        lines.push(piece);
        piece = ch;
      }
    }
    current = piece;
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** A piece of a formatted line: text in one style. */
export interface StyledPiece {
  text: string;
  bold: boolean;
  italic: boolean;
}

/** A width in points of `text` set in the given style at the size being wrapped. */
export type MeasureStyled = (text: string, bold: boolean, italic: boolean) => number;

/**
 * Break styled runs into lines of `width` points, by the same rule as `wrapText`: break at spaces, and split
 * inside a word only when the word alone is wider than a line. A word may change style in its middle (a bold
 * syllable); its pieces stay together. Each piece is measured in its own face, so a line drawn piece by piece is
 * exactly as wide as measured. Spaces at a break are dropped, as `wrapText` drops them, and several spaces print
 * as one. An empty input is one empty line.
 */
export function wrapStyled(runs: readonly StyledPiece[], width: number, measure: MeasureStyled): StyledPiece[][] {
  // Words: the pieces between spaces, each with the style of the space before it (drawn when not at a break).
  interface Word {
    pieces: StyledPiece[];
    width: number;
    space: StyledPiece | null;
  }
  const words: Word[] = [];
  let current: Word | null = null;
  let pendingSpace: StyledPiece | null = null;
  for (const run of runs) {
    for (const part of run.text.split(/( +)/)) {
      if (part === '') continue;
      if (part.startsWith(' ')) {
        current = null;
        pendingSpace = { text: ' ', bold: run.bold, italic: run.italic };
        continue;
      }
      if (!current) {
        current = { pieces: [], width: 0, space: words.length > 0 ? pendingSpace : null };
        words.push(current);
        pendingSpace = null;
      }
      current.pieces.push({ text: part, bold: run.bold, italic: run.italic });
      current.width += measure(part, run.bold, run.italic);
    }
  }
  if (words.length === 0) return [[]];

  const lines: StyledPiece[][] = [];
  let line: StyledPiece[] = [];
  let lineWidth = 0;
  const push = (p: StyledPiece) => {
    const last = line[line.length - 1];
    if (last && last.bold === p.bold && last.italic === p.italic) last.text += p.text;
    else line.push({ ...p });
  };
  for (const word of words) {
    const spaceWidth = line.length > 0 && word.space ? measure(' ', word.space.bold, word.space.italic) : 0;
    if (line.length > 0 && lineWidth + spaceWidth + word.width <= width) {
      if (word.space) push(word.space);
      for (const p of word.pieces) push(p);
      lineWidth += spaceWidth + word.width;
      continue;
    }
    if (line.length > 0) lines.push(line);
    line = [];
    lineWidth = 0;
    if (word.width <= width) {
      for (const p of word.pieces) push(p);
      lineWidth = word.width;
      continue;
    }
    // A word wider than a whole line: split it by characters, across its pieces.
    for (const p of word.pieces) {
      for (const ch of p.text) {
        const w = measure(ch, p.bold, p.italic);
        if (line.length > 0 && lineWidth + w > width) {
          lines.push(line);
          line = [];
          lineWidth = 0;
        }
        push({ text: ch, bold: p.bold, italic: p.italic });
        lineWidth += w;
      }
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}
