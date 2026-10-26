// src/server/catalog/imageHeader.ts
//
// What a catalogue image upload is, read from its own bytes (catalogue design,
// "Images live beside the documents"; 020's catalog_image): the type from the
// magic bytes (PNG, JPEG or WebP, whatever the request claims) and the pixel
// size from the header, never from a decode, so a small file declaring a huge
// canvas costs nothing. The 020 CHECKs are the backstop: at most 2 MB, 1 to
// 8000 pixels on each side.
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
//
// Pure: no database, no decoder.

import { CatalogError } from './errors';

export const IMAGE_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type ImageContentType = (typeof IMAGE_CONTENT_TYPES)[number];

/** The largest image file, in bytes (2 MB, the 020 CHECK). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** The longest side, in pixels (the 020 CHECK). */
export const MAX_IMAGE_PX = 8000;

export interface ImageHeader {
  contentType: ImageContentType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** The type the magic bytes say, or null for anything else. */
export function sniffImageType(bytes: Uint8Array): ImageContentType | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

function undecodable(type: ImageContentType): CatalogError {
  return new CatalogError('IMAGE_INVALID', `the ${type.slice(6).toUpperCase()} header cannot be read; save the image again`, {
    problem: 'undecodable',
  });
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
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

function webpSize(bytes: Uint8Array): { width: number; height: number } | null {
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

/**
 * Check an upload and read its type and pixel size: UNSUPPORTED_IMAGE_TYPE
 * (415) for anything but PNG, JPEG and WebP; IMAGE_TOO_LARGE (413) above 2 MB;
 * IMAGE_INVALID (422) for an unreadable header or a side outside 1 to 8000 px.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader {
  const contentType = sniffImageType(bytes);
  if (!contentType) {
    throw new CatalogError('UNSUPPORTED_IMAGE_TYPE', 'only PNG, JPEG and WebP images can be added', {
      allowed: [...IMAGE_CONTENT_TYPES],
    });
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new CatalogError('IMAGE_TOO_LARGE', 'an image may have at most 2 MB', { maxBytes: MAX_IMAGE_BYTES });
  }
  const size = contentType === 'image/png' ? pngSize(bytes) : contentType === 'image/jpeg' ? jpegSize(bytes) : webpSize(bytes);
  if (!size) throw undecodable(contentType);
  if (size.width < 1 || size.height < 1 || size.width > MAX_IMAGE_PX || size.height > MAX_IMAGE_PX) {
    throw new CatalogError('IMAGE_INVALID', `an image may have at most ${MAX_IMAGE_PX} pixels on each side`, {
      problem: 'too_many_pixels',
      maxPx: MAX_IMAGE_PX,
    });
  }
  return { contentType, ...size };
}
