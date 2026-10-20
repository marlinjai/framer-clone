// src/server/books/pdfBytes.ts
//
// The one check of what counts as PDF bytes in the Books: an upload, an
// imported original and every PDF a Books route serves on the editor origin
// start with `%PDF-`. A file that is really HTML or SVG never passes it.

/** Whether bytes start like a PDF (`%PDF-`). */
export function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}
