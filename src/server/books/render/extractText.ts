// src/server/books/render/extractText.ts
//
// Read the drawn text back out of a PDF this renderer wrote, so the
// completeness check (completeness.ts) judges the rendered OUTPUT, not the
// intentions that went into it. Scope is deliberately narrow: pdf-lib writes
// every page's content as a FlateDecode stream whose strings are hex-encoded in
// WinAnsi (Windows-1252) and shown with `Tj`. That is exactly what is parsed
// here; it is not a general PDF text extractor.
//
// The strings come back in drawing order, joined by single spaces: a wrapped
// title (drawn as consecutive lines) reads as its original text again.

import { inflateSync } from 'node:zlib';

/** Windows-1252 bytes 0x80..0x9F (undefined positions stay as they are). */
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeWinAnsi(hex: string): string {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    out += String.fromCodePoint(CP1252[b] ?? b);
  }
  return out;
}

/** Every string the PDF's content streams show, in drawing order. */
export function extractPdfStrings(pdf: Uint8Array): string[] {
  const raw = Buffer.from(pdf).toString('latin1');
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const strings: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = streams.exec(raw)) !== null) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue; // not a deflated stream (none in this renderer's output)
    }
    if (!body.includes('BT')) continue;
    const shows = /<([0-9A-Fa-f]*)>\s*Tj/g;
    let s: RegExpExecArray | null;
    while ((s = shows.exec(body)) !== null) strings.push(decodeWinAnsi(s[1]));
  }
  return strings;
}

/** The PDF's drawn text as one string (strings joined by single spaces). */
export function extractPdfText(pdf: Uint8Array): string {
  return extractPdfStrings(pdf).join(' ');
}
