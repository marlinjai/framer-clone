// src/lib/images/__tests__/fixtures.ts
//
// Synthetic image files for the image header and site image tests (not a test
// file itself): the catalogue's PNG, JPEG and WebP fixtures, plus an icon file
// (ICO) holding PNG or bitmap entries and an SVG document.

import { png } from '@/server/catalog/__tests__/imageFixtures';

export { jpegHeader, png, webpExtended, webpLossless, webpLossy } from '@/server/catalog/__tests__/imageFixtures';

/** A 40-byte BITMAPINFOHEADER and a few bytes of pixels, as an ICO stores a bitmap entry. */
function bitmapEntry(width: number, height: number): Uint8Array {
  const data = new Uint8Array(48);
  const view = new DataView(data.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, height * 2, true);
  return data;
}

/** An ICO file with one entry per size; `png: true` stores PNG data, else bitmaps. 256 is written as 0. */
export function ico(sizes: number[], options: { png?: boolean } = {}): Uint8Array {
  const images = sizes.map((s) => (options.png ? png(s, s) : bitmapEntry(s, s)));
  const header = new Uint8Array(6 + 16 * sizes.length);
  const view = new DataView(header.buffer);
  view.setUint16(0, 0, true);
  view.setUint16(2, 1, true);
  view.setUint16(4, sizes.length, true);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const at = 6 + 16 * i;
    header[at] = s >= 256 ? 0 : s;
    header[at + 1] = s >= 256 ? 0 : s;
    view.setUint16(at + 4, 1, true);
    view.setUint16(at + 6, 32, true);
    view.setUint32(at + 8, images[i].length, true);
    view.setUint32(at + 12, offset, true);
    offset += images[i].length;
  });
  const out = new Uint8Array(offset);
  out.set(header, 0);
  let at = header.length;
  for (const image of images) {
    out.set(image, at);
    at += image.length;
  }
  return out;
}

/** An SVG document (by default one that carries a script). */
export function svgText(body = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'): Uint8Array {
  return new TextEncoder().encode(body);
}
