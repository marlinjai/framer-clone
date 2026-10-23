// src/server/books/__tests__/logoImage.test.ts
//
// The upload checks of a logo (render/logoImage.ts, visual template composer
// plan decision 15): PNG and JPEG accepted with their pixel size; the type
// named by the request must match the magic bytes; at most 1 MB; at most
// 2000 px on the longer side, read from the header BEFORE any decoding (a
// header that lies about a huge size is refused without inflating anything);
// damaged, truncated or unembeddable files refused with the reason named.

import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { isBooksError, type BooksError } from '../errors';
import { checkLogoImage, exifOrientation, isSrgbProfile, MAX_LOGO_BYTES, MAX_LOGO_PX, sniffLogoType } from '../render/logoImage';
import { makeJpeg, makePng, withJpegFrameMarker, withJpegSize } from './testImages';

async function refusal(bytes: Uint8Array, type: string): Promise<BooksError> {
  const err = await checkLogoImage(bytes, type).catch((e: unknown) => e);
  if (!isBooksError(err)) throw new Error(`expected a BooksError, got ${String(err)}`);
  return err;
}

describe('accepted logos', () => {
  it('accepts a PNG (RGBA and RGB) and answers its pixel size', async () => {
    expect(await checkLogoImage(makePng(120, 40), 'image/png')).toEqual({ contentType: 'image/png', widthPx: 120, heightPx: 40 });
    expect(await checkLogoImage(makePng(3, 7, { colorType: 2 }), 'image/png')).toEqual({ contentType: 'image/png', widthPx: 3, heightPx: 7 });
  });

  it('accepts a JPEG and answers its pixel size', async () => {
    expect(await checkLogoImage(makeJpeg(64, 32), 'image/jpeg')).toEqual({ contentType: 'image/jpeg', widthPx: 64, heightPx: 32 });
  });

  it('accepts exactly 2000 px on the longer side', async () => {
    expect(await checkLogoImage(makePng(MAX_LOGO_PX, 10), 'image/png')).toMatchObject({ widthPx: 2000, heightPx: 10 });
    expect(await checkLogoImage(makeJpeg(16, MAX_LOGO_PX, 30), 'image/jpeg')).toMatchObject({ widthPx: 16, heightPx: 2000 });
  });
});

describe('the type', () => {
  it('sniffs PNG and JPEG by their magic bytes only', () => {
    expect(sniffLogoType(makePng(2, 2))).toBe('image/png');
    expect(sniffLogoType(makeJpeg(8, 8))).toBe('image/jpeg');
    expect(sniffLogoType(new TextEncoder().encode('GIF89a......'))).toBeNull();
    expect(sniffLogoType(new Uint8Array(0))).toBeNull();
  });

  it('refuses another declared type, and bytes that are not what the type says (415)', async () => {
    expect((await refusal(makePng(2, 2), 'image/gif')).code).toBe('UNSUPPORTED_ASSET_TYPE');
    expect((await refusal(makePng(2, 2), 'image/svg+xml')).code).toBe('UNSUPPORTED_ASSET_TYPE');
    const swapped = await refusal(makePng(2, 2), 'image/jpeg');
    expect(swapped.code).toBe('UNSUPPORTED_ASSET_TYPE');
    expect(swapped.message).toContain('is a PNG but was sent as image/jpeg');
    const svg = await refusal(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png');
    expect(svg.code).toBe('UNSUPPORTED_ASSET_TYPE');
    expect(svg.message).toBe('the file is not a PNG');
  });
});

describe('the size', () => {
  it('refuses more than 1 MB (413)', async () => {
    const big = new Uint8Array(MAX_LOGO_BYTES + 1);
    big.set(makePng(2, 2));
    expect((await refusal(big, 'image/png')).code).toBe('ASSET_TOO_LARGE');
  });

  it('refuses more than 2000 px on either side, by the header, before decoding (422)', async () => {
    const wide = await refusal(makePng(2001, 1), 'image/png');
    expect(wide.code).toBe('ASSET_INVALID');
    expect(wide.details).toEqual({ problem: 'too_many_pixels' });
    expect(wide.message).toContain('2001 x 1 px');
    expect((await refusal(withJpegSize(makeJpeg(16, 16), 16, 2001), 'image/jpeg')).details).toEqual({ problem: 'too_many_pixels' });
    // A small file whose header claims 30000 x 30000: refused from the header (inflating it would allocate gigabytes).
    const liar = await refusal(makePng(4, 4, { declare: { width: 30_000, height: 30_000 } }), 'image/png');
    expect(liar.details).toEqual({ problem: 'too_many_pixels' });
  });
});

describe('damaged files (422 asset_invalid, undecodable)', () => {
  it('refuses a truncated PNG', async () => {
    const png = makePng(40, 40);
    for (const cut of [png.length - 1, png.length - 12, 40]) {
      const err = await refusal(png.subarray(0, cut), 'image/png');
      expect(err.code).toBe('ASSET_INVALID');
      expect(err.details).toEqual({ problem: 'undecodable' });
    }
  });

  it('refuses a PNG with a damaged chunk (checksum)', async () => {
    const png = makePng(40, 40);
    png[60] ^= 0xff;
    const err = await refusal(png, 'image/png');
    expect(err.details).toEqual({ problem: 'undecodable' });
    expect(err.message).toContain('checksum');
  });

  it('refuses a PNG whose image data does not match its header', async () => {
    // A valid file claiming fewer rows than its data holds, and more.
    for (const height of [9, 11]) {
      const err = await refusal(makePng(10, 10, { declare: { width: 10, height } }), 'image/png');
      expect(err.message).toBe('the PNG image data does not match its header');
    }
    // Image data that is not deflate at all, under a correct checksum.
    const notDeflate = makePng(10, 10, { idat: new TextEncoder().encode('not deflate data at all') });
    expect((await refusal(notDeflate, 'image/png')).message).toBe('the PNG image data cannot be decompressed');
  });

  it('refuses a truncated or garbled JPEG', async () => {
    const jpeg = makeJpeg(64, 64);
    expect((await refusal(jpeg.subarray(0, jpeg.length - 100), 'image/jpeg')).details).toEqual({ problem: 'undecodable' });
    expect((await refusal(jpeg.subarray(0, 4), 'image/jpeg')).details).toEqual({ problem: 'undecodable' });
    const garbled = new Uint8Array(jpeg);
    for (let i = jpeg.length - 300; i < jpeg.length - 2; i += 1) garbled[i] = 0xff;
    expect((await refusal(garbled, 'image/jpeg')).code).toBe('ASSET_INVALID');
  });

  it('refuses a JPEG coding PDF readers do not draw (lossless, arithmetic)', async () => {
    for (const marker of [0xc3, 0xc9]) {
      const err = await refusal(withJpegFrameMarker(makeJpeg(16, 16), marker), 'image/jpeg');
      expect(err.details).toEqual({ problem: 'not_embeddable' });
    }
  });
});

/** A minimal Exif block (a TIFF structure with one directory) carrying an orientation, in either byte order. */
function exif(orientation: number, opts: { little?: boolean; type?: number } = {}): Uint8Array {
  const b = Buffer.alloc(26);
  const le = opts.little ?? false;
  const u16 = (v: number, at: number) => (le ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at));
  const u32 = (v: number, at: number) => (le ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at));
  b.write(le ? 'II' : 'MM', 0, 'latin1');
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x0112, 10); // orientation
  u16(opts.type ?? 3, 12); // SHORT
  u32(1, 14);
  u16(orientation, 18);
  u32(0, 22);
  return new Uint8Array(b);
}

/** A PNG chunk's data as a colour profile chunk (iCCP): name, zero, method 0, the deflated profile. */
function iccp(name: string, profile: string): Uint8Array {
  return new Uint8Array(Buffer.concat([Buffer.from(`${name}\0\0`, 'latin1'), deflateSync(Buffer.from(profile, 'latin1'))]));
}

const be32 = (...values: number[]) => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return new Uint8Array(b);
};

/** A JPEG with one extra segment right after its start marker. */
function withSegment(jpeg: Uint8Array, marker: number, data: Uint8Array): Uint8Array {
  const head = Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]);
  return new Uint8Array(Buffer.concat([jpeg.subarray(0, 2), head, data, jpeg.subarray(2)]));
}

const exifSegment = (orientation: number) => new Uint8Array(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif(orientation)]));

describe('what a PDF would draw differently from a browser', () => {
  it('reads the orientation of an Exif block in both byte orders, and nothing from a malformed one', () => {
    expect(exifOrientation(exif(6))).toBe(6);
    expect(exifOrientation(exif(1))).toBe(1);
    expect(exifOrientation(exif(8, { little: true }))).toBe(8);
    expect(exifOrientation(exif(6, { type: 4 }))).toBeNull(); // not a SHORT
    expect(exifOrientation(new Uint8Array([1, 2, 3]))).toBeNull();
    const pastEnd = exif(6);
    pastEnd.set([0, 0, 0, 200], 4); // the directory offset points past the end
    expect(exifOrientation(pastEnd)).toBeNull();
    expect(exifOrientation(exif(6).subarray(0, 20))).toBeNull(); // the entry is cut off
  });

  it('refuses a colour profile, gamma or primaries that are not sRGB, accepts sRGB', async () => {
    const png = (chunks: Array<[string, Uint8Array]>) => makePng(8, 8, { chunks });
    expect(isSrgbProfile(new TextEncoder().encode('....sRGB IEC61966-2.1....'))).toBe(true);
    // Profile descriptions in UTF-16, big-endian (the multi-localised text of newer profiles).
    const utf16 = (t: string) => new Uint8Array([...t].flatMap((c) => [0, c.charCodeAt(0)]));
    expect(isSrgbProfile(utf16('Display P3'))).toBe(false);
    expect(isSrgbProfile(utf16('sRGB'))).toBe(true);
    // A profile.
    const p3 = await refusal(png([['iCCP', iccp('Display P3', 'desc Display P3 profile')]]), 'image/png');
    expect(p3).toMatchObject({ code: 'ASSET_INVALID', details: { problem: 'not_embeddable' } });
    expect(p3.message).toContain('colour profile other than sRGB');
    expect(await checkLogoImage(png([['iCCP', iccp('ICC Profile', 'desc sRGB IEC61966-2.1')]]), 'image/png')).toMatchObject({ widthPx: 8 });
    // A gamma: sRGB's (1/2.2, stored as 45455) passes, linear (100000) does not, unless an sRGB chunk says sRGB.
    expect(await checkLogoImage(png([['gAMA', be32(45455)]]), 'image/png')).toMatchObject({ widthPx: 8 });
    expect((await refusal(png([['gAMA', be32(100000)]]), 'image/png')).message).toContain('sRGB');
    expect(await checkLogoImage(png([['sRGB', new Uint8Array([0])], ['gAMA', be32(100000)]]), 'image/png')).toMatchObject({ widthPx: 8 });
    // Primaries: sRGB's pass, wide ones do not.
    expect(await checkLogoImage(png([['cHRM', be32(31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000)]]), 'image/png')).toMatchObject({ widthPx: 8 });
    expect((await refusal(png([['cHRM', be32(31270, 32900, 70800, 29200, 17000, 79700, 13100, 4600)]]), 'image/png')).message).toContain('sRGB');
    // A JPEG's profile, in application segment 2.
    const icc = (text: string) => new Uint8Array(Buffer.concat([Buffer.from('ICC_PROFILE\0\x01\x01', 'latin1'), Buffer.from(text, 'latin1')]));
    const jpeg = makeJpeg(16, 16);
    expect((await refusal(withSegment(jpeg, 0xe2, icc('desc Display P3')), 'image/jpeg')).details).toEqual({ problem: 'not_embeddable' });
    expect(await checkLogoImage(withSegment(jpeg, 0xe2, icc('desc sRGB IEC61966-2.1')), 'image/jpeg')).toMatchObject({ widthPx: 16 });
  });

  it('refuses a JPEG or PNG with a rotation flag, accepts an upright one', async () => {
    const jpeg = makeJpeg(32, 16);
    expect((await refusal(withSegment(jpeg, 0xe1, exifSegment(6)), 'image/jpeg')).details).toEqual({ problem: 'not_embeddable' });
    expect(await checkLogoImage(withSegment(jpeg, 0xe1, exifSegment(1)), 'image/jpeg')).toMatchObject({ widthPx: 32 });
    const rotated = await refusal(makePng(8, 8, { chunks: [['eXIf', exif(8)]] }), 'image/png');
    expect(rotated.message).toContain('rotation flag');
    expect(await checkLogoImage(makePng(8, 8, { chunks: [['eXIf', exif(1)]] }), 'image/png')).toMatchObject({ widthPx: 8 });
  });

  // Accepting an Adobe-marked CMYK JPEG is not tested: no encoder in the tree writes CMYK
  // (jpeg-js writes RGB only), and pdf-lib's handling of it is its own (an inverted decode array).
  it('refuses a CMYK JPEG without the Adobe colour marker', async () => {
    // Four channels declared in the frame header: refused from the header, before decoding.
    const jpeg = makeJpeg(16, 16);
    const cmyk = new Uint8Array(jpeg);
    const sof = cmyk.findIndex((b, i) => b === 0xff && cmyk[i + 1] === 0xc0);
    cmyk[sof + 9] = 4;
    const err = await refusal(cmyk, 'image/jpeg');
    expect(err.details).toEqual({ problem: 'not_embeddable' });
    expect(err.message).toContain('CMYK');
  });
});

describe('more files', () => {
  it('accepts interlaced PNGs of awkward sizes', async () => {
    for (const [w, h] of [[1, 1], [9, 3], [3, 9], [17, 13], [64, 1]]) {
      expect(await checkLogoImage(makePng(w, h, { interlace: true }), 'image/png'), `${w} x ${h}`).toEqual({ contentType: 'image/png', widthPx: w, heightPx: h });
    }
  });

  it('refuses an empty file and a palette PNG without its palette', async () => {
    const empty = await refusal(new Uint8Array(0), 'image/png');
    expect(empty).toMatchObject({ code: 'ASSET_INVALID', message: 'the file is empty' });
    // Declared as a palette image (colour type 3, one byte per pixel) but no PLTE chunk.
    const noPalette = makePng(4, 4, { declareColorType: 3, idat: deflateSync(Buffer.alloc(4 * (1 + 4))) });
    expect((await refusal(noPalette, 'image/png')).details).toEqual({ problem: 'not_embeddable' });
  });

  it('counts scans from the first one, so metadata holding scan markers is fine, and refuses more than 64', async () => {
    const jpeg = makeJpeg(16, 16);
    const comment = new Uint8Array(200).fill(0xda);
    for (let i = 0; i < comment.length; i += 2) comment[i] = 0xff;
    expect(await checkLogoImage(withSegment(jpeg, 0xfe, comment), 'image/jpeg')).toMatchObject({ widthPx: 16 });
    const many = Buffer.alloc(140);
    for (let i = 0; i < many.length; i += 2) {
      many[i] = 0xff;
      many[i + 1] = 0xda;
    }
    const flooded = new Uint8Array(Buffer.concat([jpeg.subarray(0, jpeg.length - 2), many, jpeg.subarray(jpeg.length - 2)]));
    const err = await refusal(flooded, 'image/jpeg');
    expect(err.message).toMatch(/scans, at most 64/);
  });
});

describe('the size inside the PDF', () => {
  it('refuses a small PNG that would become a huge image in every invoice PDF', async () => {
    // Each row is the row above plus one: PNG's filters make it tiny, pdf-lib stores it unfiltered.
    const width = 2000;
    const height = 2000;
    const raw = Buffer.alloc(height * (1 + width * 3));
    let seed = 12345;
    // A first row of fixed pseudo-random bytes (nothing for deflate to repeat), then every row "up" plus one.
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    for (let y = 0; y < height; y += 1) {
      const row = y * (1 + width * 3);
      raw[row] = y === 0 ? 0 : 2; // filter: none for the first row, "up" for the others
      for (let i = 1; i <= width * 3; i += 1) raw[row + i] = y === 0 ? next() : 1;
    }
    const smooth = makePng(width, height, { colorType: 2, idat: deflateSync(raw, { level: 9 }) });
    expect(smooth.length).toBeLessThan(MAX_LOGO_BYTES);
    const err = await refusal(smooth, 'image/png');
    expect(err.details).toEqual({ problem: 'not_embeddable' });
    expect(err.message).toMatch(/would add [\d.]+ MB to every invoice PDF/);
  }, 60_000);
});
