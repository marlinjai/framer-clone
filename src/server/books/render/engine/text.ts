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
