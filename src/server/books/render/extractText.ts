// src/server/books/render/extractText.ts
//
// Read the drawn text back out of a PDF this renderer wrote, with where each
// piece was drawn, so the completeness check (completeness.ts) judges the
// rendered OUTPUT and the layout tests can check positions. Narrow on purpose:
// it understands what pdf-lib writes (an embedded Type0 font per face with a
// ToUnicode map, text shown as hex glyph ids with `Tj`, placed with `Tm`), and
// is not a general PDF text extractor.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';

export interface DrawnText {
  text: string;
  page: number;
  x: number;
  y: number;
  /** The font size the text was drawn at. */
  size: number;
  /** The drawing font's name (its BaseFont without a subset tag), such as "DejaVuSans-Oblique". */
  font: string;
}

function streamBytes(stream: unknown): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (stream instanceof PDFStream) return stream.getContents();
  return new Uint8Array();
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/** UTF-16BE hex (possibly with surrogate pairs) to a string. */
function utf16(hex: string): string {
  const units: number[] = [];
  for (let i = 0; i + 3 < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
  return String.fromCharCode(...units);
}

/** Parse a ToUnicode CMap into glyph id (hex, upper case) -> text. */
export function parseToUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(m[1].toUpperCase(), utf16(m[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const width = m[1].length;
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      const start = parseInt(m[3], 16);
      for (let g = lo; g <= hi; g++) {
        map.set(g.toString(16).toUpperCase().padStart(width, '0'), String.fromCodePoint(start + (g - lo)));
      }
    }
  }
  return map;
}

/** Every piece of text the PDF shows, with its page and position, in drawing order. */
export async function extractDrawnText(pdf: Uint8Array): Promise<DrawnText[]> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const out: DrawnText[] = [];
  doc.getPages().forEach((page, pageIndex) => {
    const fonts = new Map<string, { map: Map<string, string>; name: string }>();
    const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
    for (const [name, ref] of fontDict?.entries() ?? []) {
      const font = doc.context.lookup(ref as PDFRef, PDFDict);
      const toUnicode = font.get(PDFName.of('ToUnicode'));
      const cmap = toUnicode ? latin1(streamBytes(doc.context.lookup(toUnicode))) : '';
      const base = font.lookupMaybe(PDFName.of('BaseFont'), PDFName)?.decodeText() ?? '';
      // A subset font's name starts with a six-letter tag ("ABCDEF+DejaVuSans").
      fonts.set(name.decodeText(), { map: parseToUnicode(cmap), name: base.replace(/^[A-Z]{6}\+/, '') });
    }

    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
    let font = { map: new Map<string, string>(), name: '' };
    let size = 0;
    let x = 0;
    let y = 0;
    for (const stream of streams) {
      const body = latin1(streamBytes(stream));
      const ops = /\/([^\s/]+)\s+([\d.]+)\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|<([0-9A-Fa-f]*)>\s*Tj/g;
      let m: RegExpExecArray | null;
      while ((m = ops.exec(body)) !== null) {
        if (m[1] !== undefined) {
          font = fonts.get(m[1]) ?? { map: new Map(), name: '' };
          size = Number(m[2]);
        } else if (m[3] !== undefined) {
          x = Number(m[7]);
          y = Number(m[8]);
        } else {
          const hex = m[9].toUpperCase();
          let text = '';
          for (let i = 0; i + 3 < hex.length; i += 4) text += font.map.get(hex.slice(i, i + 4)) ?? '�';
          out.push({ text, page: pageIndex + 1, x, y, size, font: font.name });
        }
      }
    }
  });
  return out;
}

/** The PDF's drawn text as one string (pieces joined by single spaces). */
export async function extractPdfText(pdf: Uint8Array): Promise<string> {
  return (await extractDrawnText(pdf)).map((t) => t.text).join(' ');
}
