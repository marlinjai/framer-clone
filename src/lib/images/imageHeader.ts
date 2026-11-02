// src/lib/images/imageHeader.ts
//
// What an uploaded image is, read from its own bytes: the type from the magic
// bytes (whatever the request or the file name claims) and the pixel size from
// the header, never from a decode, so a small file declaring a huge canvas
// costs nothing. Shared by the catalogue's images (src/server/catalog/
// imageHeader.ts, which adds its own limits and errors) and the site images
// (src/lib/site/siteImages.ts, favicon and sharing image). Pure and free of
// Node APIs, so the editor can run the same check on a file before sending it.
//
//   - PNG: the signature, then the image header chunk (IHDR) with the width and
//     height as 32-bit big-endian numbers.
//   - JPEG: the markers from the start of image on, up to the first
//     start-of-frame segment (SOF0 to SOF15 except the table markers DHT C4,
//     JPG C8 and DAC CC), which holds the height and width.
//   - WebP: the RIFF container with the WEBP form, then the first chunk: VP8
//     (lossy: the key frame's start code, then 14-bit sizes), VP8L (lossless:
//     the 0x2f signature, then 14-bit sizes minus one) or VP8X (extended:
//     24-bit sizes minus one).
//   - ICO: the icon directory (reserved 0, type 1, a count), then one 16 byte
//     entry per image (width and height as one byte each, 0 meaning 256, the
//     data's size and offset). Every entry's data must lie inside the file and
//     be a PNG or a bitmap header; the size is the largest entry's.
//   - SVG is recognised only to be named in a refusal (looksLikeSvg): it is
//     text that can carry script, and no caller accepts it.

export type SniffedImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/x-icon';

export interface ImageSize {
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function isPng(bytes: Uint8Array, at = 0): boolean {
  return bytes.length >= at + 8 && PNG_SIGNATURE.every((b, i) => bytes[at + i] === b);
}

function u16le(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32le(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** True for an icon directory header: reserved 0, type 1 (icon, not cursor), at least one image. */
function isIco(bytes: Uint8Array): boolean {
  return bytes.length >= 6 && u16le(bytes, 0) === 0 && u16le(bytes, 2) === 1 && u16le(bytes, 4) >= 1;
}

/** The type the magic bytes say, or null for anything else. */
export function sniffImageType(bytes: Uint8Array): SniffedImageType | null {
  if (isPng(bytes)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (isIco(bytes)) return 'image/x-icon';
  return null;
}

/**
 * True when the bytes read as an SVG document (an `<svg` element within the
 * first kilobyte of text). Only used to word a refusal precisely: nothing
 * accepts SVG uploads.
 */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = ascii(bytes, 0, Math.min(bytes.length, 1024)).replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  return head.startsWith('<') && /<svg[\s>/]/i.test(head);
}

function pngSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    // Markers without a length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan before any frame
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length) return null;
      return { height: (bytes[at + 5] << 8) | bytes[at + 6], width: (bytes[at + 7] << 8) | bytes[at + 8] };
    }
    at += 2 + length;
  }
  return null;
}

function webpSize(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return null;
    const b = bytes.subarray(21, 25);
    const width = 1 + (((b[1] & 0x3f) << 8) | b[0]);
    const height = 1 + (((b[3] & 0x0f) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6));
    return { width, height };
  }
  if (chunk === 'VP8X') {
    return {
      width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
    };
  }
  return null;
}

/** The most images one icon file may list (real ones hold a handful). */
export const MAX_ICO_ENTRIES = 64;

function icoSize(bytes: Uint8Array): ImageSize | null {
  const count = u16le(bytes, 4);
  if (count < 1 || count > MAX_ICO_ENTRIES) return null;
  const dataStart = 6 + 16 * count;
  if (bytes.length < dataStart) return null;
  let best: ImageSize | null = null;
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const width = bytes[entry] || 256;
    const height = bytes[entry + 1] || 256;
    const size = u32le(bytes, entry + 8);
    const offset = u32le(bytes, entry + 12);
    if (size < 8 || offset < dataStart || offset + size > bytes.length) return null;
    // The image data is a PNG or a bitmap without its file header (BITMAPINFOHEADER, 40 bytes).
    if (!isPng(bytes, offset) && u32le(bytes, offset) !== 40) return null;
    if (!best || width * height > best.width * best.height) best = { width, height };
  }
  return best;
}

/** The pixel size the header of a sniffed type declares, or null when the header cannot be read. */
export function readImageSize(bytes: Uint8Array, type: SniffedImageType): ImageSize | null {
  switch (type) {
    case 'image/png':
      return pngSize(bytes);
    case 'image/jpeg':
      return jpegSize(bytes);
    case 'image/webp':
      return webpSize(bytes);
    case 'image/x-icon':
      return icoSize(bytes);
  }
}
