// src/server/catalog/__tests__/imageFixtures.ts
//
// Small synthetic image files for the catalogue tests (not a test file itself):
// a real PNG (encoded with node:zlib, so a browser shows it in the stand-in) and
// the headers of a JPEG and the three WebP forms, which is all the catalogue
// reads from an upload (imageHeader.ts).

import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A width x height PNG filled with one RGB colour. */
export function png(width: number, height: number, rgb: [number, number, number] = [200, 160, 90]): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** The start of a baseline JPEG up to its frame header (an APP0 segment, then SOF0). */
export function jpegHeader(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

function riff(chunkType: string, payload: number[]): Uint8Array {
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), Buffer.from(chunkType, 'ascii'), Buffer.alloc(4), Buffer.from(payload)]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return new Uint8Array(Buffer.concat([Buffer.from('RIFF', 'ascii'), size, body]));
}

/** A lossy WebP header (VP8 key frame). */
export function webpLossy(width: number, height: number): Uint8Array {
  return riff('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f, 0, 0]);
}

/** A lossless WebP header (VP8L). */
export function webpLossless(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return riff('VP8L', [0x2f, w & 0xff, ((w >> 8) & 0x3f) | ((h & 0x03) << 6), (h >> 2) & 0xff, (h >> 10) & 0x0f, 0, 0, 0, 0, 0]);
}

/** An extended WebP header (VP8X). */
export function webpExtended(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return riff('VP8X', [0, 0, 0, 0, w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]);
}
