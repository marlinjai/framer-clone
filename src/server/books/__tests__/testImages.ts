// src/server/books/__tests__/testImages.ts
//
// Test images built at run time (no binary fixtures in the repository): PNGs
// written chunk by chunk with node:zlib (deflate and CRC-32), JPEGs encoded by
// jpeg-js. Deterministic: the same arguments give the same bytes in every
// process, which the engine's fresh-process determinism check relies on.

import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

import { encode as encodeJpeg } from 'jpeg-js';

import type { EngineImage } from '../render/engine';
import { preset } from '../template/presets';
import type { FontFamily, TemplateDocumentV2 } from '../template/schema';

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

export interface PngOptions {
  /** RGBA (6, the default) or RGB (2). */
  colorType?: 2 | 6;
  /** Declare this size in the header instead of the real one (the pixels stay `width` x `height`). */
  declare?: { width: number; height: number };
  /** Replace the compressed image data (with a correct checksum). */
  idat?: Uint8Array;
}

/** A `width` x `height` PNG of a diagonal colour ramp (8 bits per channel). */
export function makePng(width: number, height: number, opts: PngOptions = {}): Uint8Array {
  const colorType = opts.colorType ?? 6;
  const channels = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * channels);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * channels;
      raw[at] = (x * 7) & 0xff;
      raw[at + 1] = (y * 5) & 0xff;
      raw[at + 2] = ((x + y) * 3) & 0xff;
      if (channels === 4) raw[at + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(opts.declare?.width ?? width, 0);
  ihdr.writeUInt32BE(opts.declare?.height ?? height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', opts.idat ?? deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

/** A `width` x `height` baseline JPEG of a colour ramp. */
export function makeJpeg(width: number, height: number, quality = 80): Uint8Array {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      data[at] = (x * 3) & 0xff;
      data[at + 1] = (y * 3) & 0xff;
      data[at + 2] = 128;
      data[at + 3] = 255;
    }
  }
  return new Uint8Array(encodeJpeg({ data, width, height }, quality).data);
}

/** Overwrite the width and height in a JPEG's baseline frame header (SOF0). */
export function withJpegSize(jpeg: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(jpeg);
  for (let i = 2; i < out.length - 9; i += 1) {
    if (out[i] === 0xff && out[i + 1] === 0xc0) {
      out[i + 5] = height >> 8;
      out[i + 6] = height & 0xff;
      out[i + 7] = width >> 8;
      out[i + 8] = width & 0xff;
      return out;
    }
  }
  throw new Error('withJpegSize: no baseline frame header');
}

/** Replace a JPEG's frame marker (to make it lossless, arithmetic and so on). */
export function withJpegFrameMarker(jpeg: Uint8Array, marker: number): Uint8Array {
  const out = new Uint8Array(jpeg);
  for (let i = 2; i < out.length - 1; i += 1) {
    if (out[i] === 0xff && out[i + 1] === 0xc0) {
      out[i + 1] = marker;
      return out;
    }
  }
  throw new Error('withJpegFrameMarker: no baseline frame header');
}

/** The SHA-256 of bytes, the name an asset is stored under. */
export function assetSha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Modern set in `family` with a generated logo (300 x 100 px) top right on
 * the first page and small in the following-page header: the same template
 * in the parent test and in the fresh process of engineChild.ts.
 */
export function logoCase(family: FontFamily, kind: 'png' | 'jpeg'): { doc: TemplateDocumentV2; assets: Map<string, EngineImage>; sha: string } {
  const bytes = kind === 'png' ? makePng(300, 100) : makeJpeg(300, 100);
  const sha = assetSha(bytes);
  const doc = preset('modern');
  doc.theme.fontFamily = family;
  doc.regions.firstPageHeader = [{ id: 'logo', type: 'logo', style: { align: 'right' }, widthMm: 40, assetSha256: sha }];
  doc.regions.followingPageHeader = [
    { id: 'logoSmall', type: 'logo', style: { align: 'left', spaceBelowPt: 4 }, widthMm: 20, assetSha256: sha },
    ...doc.regions.followingPageHeader,
  ];
  return { doc, assets: new Map([[sha, { contentType: kind === 'png' ? 'image/png' : 'image/jpeg', bytes }]]), sha };
}
