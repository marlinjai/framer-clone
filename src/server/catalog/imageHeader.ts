// src/server/catalog/imageHeader.ts
//
// What a catalogue image upload is, read from its own bytes (catalogue design,
// "Images live beside the documents"; 020's catalog_image): the type from the
// magic bytes (PNG, JPEG or WebP, whatever the request claims) and the pixel
// size from the header, never from a decode. The format readers are shared
// with the site images (src/lib/images/imageHeader.ts); this module adds the
// catalogue's types, limits and errors. The 020 CHECKs are the backstop: at
// most 2 MB, 1 to 8000 pixels on each side.
//
// Pure: no database, no decoder.

import { readImageSize, sniffImageType as sniffAnyImageType } from '@/lib/images/imageHeader';

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

/** The catalogue type the magic bytes say, or null for anything else (an icon file included). */
export function sniffImageType(bytes: Uint8Array): ImageContentType | null {
  const type = sniffAnyImageType(bytes);
  return type && (IMAGE_CONTENT_TYPES as readonly string[]).includes(type) ? (type as ImageContentType) : null;
}

function undecodable(type: ImageContentType): CatalogError {
  return new CatalogError('IMAGE_INVALID', `the ${type.slice(6).toUpperCase()} header cannot be read; save the image again`, {
    problem: 'undecodable',
  });
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
  const size = readImageSize(bytes, contentType);
  if (!size) throw undecodable(contentType);
  if (size.width < 1 || size.height < 1 || size.width > MAX_IMAGE_PX || size.height > MAX_IMAGE_PX) {
    throw new CatalogError('IMAGE_INVALID', `an image may have at most ${MAX_IMAGE_PX} pixels on each side`, {
      problem: 'too_many_pixels',
      maxPx: MAX_IMAGE_PX,
    });
  }
  return { contentType, ...size };
}
