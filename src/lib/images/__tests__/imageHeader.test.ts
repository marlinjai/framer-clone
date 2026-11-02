// src/lib/images/__tests__/imageHeader.test.ts
//
// The shared image header reader: the type from the magic bytes, the pixel
// size from each format's header (ICO's directory included), and a damaged
// icon directory read as unreadable, never trusted.

import { describe, expect, it } from 'vitest';

import { looksLikeSvg, readImageSize, sniffImageType } from '../imageHeader';
import { bitmapEntry, ico, icoWith, jpegHeader, png, pngHeader, svgText, webpLossy } from './fixtures';

describe('sniffImageType', () => {
  it('names PNG, JPEG, WebP and ICO from the bytes alone', () => {
    expect(sniffImageType(png(2, 2))).toBe('image/png');
    expect(sniffImageType(jpegHeader(10, 10))).toBe('image/jpeg');
    expect(sniffImageType(webpLossy(10, 10))).toBe('image/webp');
    expect(sniffImageType(ico([16, 32]))).toBe('image/x-icon');
  });

  it('names nothing else: GIF, SVG, a cursor file, an empty file', () => {
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(sniffImageType(svgText())).toBeNull();
    const cursor = ico([32]);
    cursor[2] = 2; // type 2 is a cursor
    expect(sniffImageType(cursor)).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe('readImageSize for ICO', () => {
  it('reads the largest entry, bitmap or PNG, with 0 meaning 256', () => {
    expect(readImageSize(ico([16, 48, 32]), 'image/x-icon')).toEqual({ width: 48, height: 48 });
    expect(readImageSize(ico([16, 256], { png: true }), 'image/x-icon')).toEqual({ width: 256, height: 256 });
  });

  it('refuses an entry pointing outside the file, data that is no image, or a cut directory', () => {
    const outside = ico([32]);
    new DataView(outside.buffer).setUint32(6 + 12, outside.length + 10, true);
    expect(readImageSize(outside, 'image/x-icon')).toBeNull();

    const garbage = ico([32]);
    garbage.fill(0x41, 6 + 16);
    expect(readImageSize(garbage, 'image/x-icon')).toBeNull();

    expect(readImageSize(ico([16, 32]).subarray(0, 20), 'image/x-icon')).toBeNull();
  });

  it('takes the size from the entry data and refuses one that disagrees with its directory entry', () => {
    // A 16 by 16 directory entry wrapping a PNG whose header says 9000 by 9000.
    expect(readImageSize(icoWith([{ declared: 16, data: pngHeader(9000, 9000) }]), 'image/x-icon')).toBeNull();
    expect(readImageSize(icoWith([{ declared: 16, data: pngHeader(16, 16) }]), 'image/x-icon')).toEqual({ width: 16, height: 16 });
    // A bitmap entry claiming 16 while its header says 64.
    expect(readImageSize(icoWith([{ declared: 16, data: bitmapEntry(64, 64) }]), 'image/x-icon')).toBeNull();
    // The directory's 0 means 256 or more, so a large PNG entry reads at its real size.
    expect(readImageSize(icoWith([{ declared: 0, data: png(300, 300) }]), 'image/x-icon')).toEqual({ width: 300, height: 300 });
  });
});

describe('looksLikeSvg', () => {
  it('recognises an SVG document, also after a prolog, a byte order mark or whitespace', () => {
    expect(looksLikeSvg(svgText())).toBe(true);
    expect(looksLikeSvg(svgText('﻿  <?xml version="1.0"?>\n<!-- x --><svg viewBox="0 0 1 1"/>'))).toBe(true);
    expect(looksLikeSvg(svgText('<html><body>no</body></html>'))).toBe(false);
    expect(looksLikeSvg(png(1, 1))).toBe(false);
  });
});
