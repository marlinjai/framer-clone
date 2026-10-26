// src/server/catalog/__tests__/imageHeader.test.ts
//
// The catalogue's upload check (imageHeader.ts): the type from the bytes, the
// pixel size from the header of each format, and every refusal with its code.

import { describe, expect, it } from 'vitest';

import { isCatalogError } from '../errors';
import { MAX_IMAGE_BYTES, readImageHeader, sniffImageType } from '../imageHeader';
import { jpegHeader, png, webpExtended, webpLossless, webpLossy } from './imageFixtures';

function refusal(bytes: Uint8Array): string {
  try {
    readImageHeader(bytes);
  } catch (err) {
    if (isCatalogError(err)) return err.code;
    throw err;
  }
  return 'accepted';
}

describe('readImageHeader', () => {
  it('reads PNG, JPEG and the three WebP forms', () => {
    expect(readImageHeader(png(3, 2))).toEqual({ contentType: 'image/png', width: 3, height: 2 });
    expect(readImageHeader(jpegHeader(640, 480))).toEqual({ contentType: 'image/jpeg', width: 640, height: 480 });
    expect(readImageHeader(webpLossy(300, 200))).toEqual({ contentType: 'image/webp', width: 300, height: 200 });
    expect(readImageHeader(webpLossless(1024, 768))).toEqual({ contentType: 'image/webp', width: 1024, height: 768 });
    expect(readImageHeader(webpExtended(4000, 3000))).toEqual({ contentType: 'image/webp', width: 4000, height: 3000 });
  });

  it('takes the type from the bytes, never from a name', () => {
    expect(sniffImageType(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(refusal(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('UNSUPPORTED_IMAGE_TYPE');
  });

  it('refuses a file over 2 MB', () => {
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(png(1, 1));
    expect(refusal(big)).toBe('IMAGE_TOO_LARGE');
  });

  it('refuses an unreadable header and a canvas beyond 8000 pixels', () => {
    expect(refusal(png(1, 1).slice(0, 20))).toBe('IMAGE_INVALID');
    expect(refusal(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe('IMAGE_INVALID');
    expect(refusal(jpegHeader(9000, 10))).toBe('IMAGE_INVALID');
    expect(refusal(webpExtended(8001, 10))).toBe('IMAGE_INVALID');
  });
});
