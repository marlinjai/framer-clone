// src/server/books/render/logoImage.ts
//
// The checks an uploaded logo passes before it is stored (visual template
// composer plan, decision 15). A logo ends up on documents of record, and a
// file the PDF writer cannot embed must be refused at upload, never at issue,
// so every check runs here, in this order:
//
//   1. the type: PNG or JPEG only (what pdf-lib embeds; the composer
//      rasterises an SVG to PNG in the browser), named by the request AND
//      confirmed by the file's magic bytes (UNSUPPORTED_ASSET_TYPE, 415);
//   2. the size: at most 1 MB (ASSET_TOO_LARGE, 413; the route reads the body
//      bounded, so a larger one is never held in memory whole);
//   3. the header: the pixel size read from the PNG image header chunk
//      (IHDR) or the JPEG start-of-frame segment, at most 2000 px on the
//      longer side, BEFORE anything decodes the pixels: a 1 MB file can
//      declare 20000 x 20000 pixels, and decoding it would allocate gigabytes;
//   4. what a PDF would draw differently from a browser, refused with the
//      advice to save the image again: a rotation flag in the Exif metadata
//      (the exchangeable image file format a camera writes; a browser turns
//      the image, pdf-lib does not, so the composer and the invoice would
//      disagree); a colour profile other than sRGB (the standard colour space
//      of the web), or a gamma or primaries that are not sRGB's (a browser
//      applies them, pdf-lib draws the plain numbers as sRGB); a CMYK (cyan,
//      magenta, yellow, black) JPEG without the Adobe marker (pdf-lib inverts
//      every CMYK JPEG, which is only right for Adobe's);
//   5. the content, fully decoded: every PNG chunk's cyclic redundancy check
//      (CRC), the image data inflated to exactly the size its header promises;
//      the JPEG decoded by jpeg-js without tolerance for missing data, in a
//      coding every PDF reader draws (baseline, extended sequential or
//      progressive, 8 bit, at most 64 scans, so the central processing unit
//      (CPU) time of a decode stays bounded);
//   6. the proof: pdf-lib embeds it into a throwaway PDF and writes that PDF,
//      exactly as the engine will (render/engine), and that PDF stays under
//      2 MB: pdf-lib stores a PNG's pixels without PNG's row filters, so a
//      small, smooth PNG can become a twelve megabyte image in every invoice.
//
// A failure of 3 to 6 is ASSET_INVALID (422) with a message saying which.
// Pure apart from node:zlib; no database.

import { crc32, inflateSync } from 'node:zlib';

import { decode as decodeJpeg } from 'jpeg-js';
import { PDFDocument } from 'pdf-lib';

import { BooksError } from '../errors';

export const LOGO_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const;
export type LogoContentType = (typeof LOGO_CONTENT_TYPES)[number];

/** The largest logo file, in bytes (1 MB). */
export const MAX_LOGO_BYTES = 1024 * 1024;
/** The longest side of a logo, in pixels. */
export const MAX_LOGO_PX = 2000;
/** The most a logo may add to a PDF, in bytes (the trial PDF's size, 2 MB). */
export const MAX_EMBEDDED_BYTES = 2 * 1024 * 1024;

export interface CheckedLogo {
  contentType: LogoContentType;
  widthPx: number;
  heightPx: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The type the magic bytes say, or null for anything else. */
export function sniffLogoType(bytes: Uint8Array): LogoContentType | null {
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

function invalid(problem: 'undecodable' | 'too_many_pixels' | 'not_embeddable', message: string): BooksError {
  return new BooksError('ASSET_INVALID', message, { problem });
}

/**
 * The orientation tag (0x0112) of an Exif block (a TIFF, Tagged Image File
 * Format, structure: byte order, then the first directory of tags), or null
 * when there is none or the block cannot be read (an unreadable block is not a
 * rotation). The tag is one SHORT (type 3) value.
 */
export function exifOrientation(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return null;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    return view.getUint16(entry + 2, little) === 3 && view.getUint32(entry + 4, little) === 1 ? view.getUint16(entry + 8, little) : null;
  }
  return null;
}

function checkOrientation(tiff: Uint8Array): void {
  const orientation = exifOrientation(tiff);
  if (orientation !== null && orientation !== 1) {
    throw invalid(
      'not_embeddable',
      'the image carries a rotation flag a PDF does not apply; save it again upright (without the rotation flag)',
    );
  }
}

/** Text in an ICC colour profile, as ASCII or as UTF-16 (the two encodings profile descriptions use). */
function profileMentions(profile: Uint8Array, word: string): boolean {
  const text = Buffer.from(profile).toString('latin1');
  const utf16 = [...word].map((c) => `\0${c}`).join('');
  return text.includes(word) || text.includes(utf16);
}

/**
 * True for an ICC (International Color Consortium) profile of sRGB: its
 * description names sRGB or the standard that defines it (IEC 61966-2-1).
 * Display P3, Adobe RGB and the like describe themselves otherwise.
 */
export function isSrgbProfile(profile: Uint8Array): boolean {
  return ['sRGB', 'IEC61966', 'IEC 61966'].some((w) => profileMentions(profile, w));
}

function refuseProfile(): never {
  throw invalid(
    'not_embeddable',
    'the image carries a colour profile other than sRGB, so the invoice would show other colours than the screen; save it as sRGB',
  );
}

function checkPixels(widthPx: number, heightPx: number): void {
  if (widthPx < 1 || heightPx < 1) throw invalid('undecodable', 'the image declares no pixels');
  if (Math.max(widthPx, heightPx) > MAX_LOGO_PX) {
    throw invalid('too_many_pixels', `the image is ${widthPx} x ${heightPx} px; the longer side may be at most ${MAX_LOGO_PX} px`);
  }
}

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];

/** Channels per pixel and the allowed bit depths of each PNG colour type. */
const PNG_COLOR_TYPES: Record<number, { channels: number; depths: number[] }> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

/** The size of a PNG's filtered image data (one filter byte per row), per Adam7 pass when interlaced. */
function pngRawSize(width: number, height: number, bitsPerPixel: number, interlaced: boolean): number {
  const rows = (w: number, h: number) => (w === 0 || h === 0 ? 0 : h * (1 + Math.ceil((w * bitsPerPixel) / 8)));
  if (!interlaced) return rows(width, height);
  const passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ];
  return passes.reduce(
    (sum, [x0, y0, dx, dy]) => sum + rows(Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy)),
    0,
  );
}

function checkPng(bytes: Uint8Array): { widthPx: number; heightPx: number } {
  let at = 8;
  let header: { width: number; height: number; bitsPerPixel: number; interlaced: boolean } | null = null;
  const data: Uint8Array[] = [];
  let ended = false;
  const colour: { srgb: boolean; profile: Uint8Array | null; gamma: number | null; chrm: Uint8Array | null } = {
    srgb: false,
    profile: null,
    gamma: null,
    chrm: null,
  };
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw invalid('undecodable', 'the PNG is cut off');
    const length = u32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const end = at + 12 + length;
    if (end > bytes.length) throw invalid('undecodable', 'the PNG is cut off');
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== u32(bytes, at + 8 + length)) {
      throw invalid('undecodable', `the PNG is damaged (the ${type} chunk fails its checksum)`);
    }
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (!header && type !== 'IHDR') throw invalid('undecodable', 'the PNG does not start with its header');
    if (type === 'IHDR') {
      if (header || length !== 13) throw invalid('undecodable', 'the PNG header is malformed');
      const color = PNG_COLOR_TYPES[body[9]];
      const depth = body[8];
      if (!color || !color.depths.includes(depth) || body[10] !== 0 || body[11] !== 0 || body[12] > 1) {
        throw invalid('undecodable', 'the PNG header names an unknown pixel format');
      }
      header = { width: u32(body, 0), height: u32(body, 4), bitsPerPixel: color.channels * depth, interlaced: body[12] === 1 };
      // The pixel bound comes before any image data is inflated.
      checkPixels(header.width, header.height);
    } else if (type === 'IDAT') {
      data.push(body);
    } else if (type === 'eXIf') {
      checkOrientation(body);
    } else if (type === 'sRGB') {
      colour.srgb = true;
    } else if (type === 'iCCP') {
      colour.profile = body;
    } else if (type === 'gAMA' && length === 4) {
      colour.gamma = u32(body, 0);
    } else if (type === 'cHRM' && length === 32) {
      colour.chrm = body;
    } else if (type === 'IEND') {
      ended = true;
      at = end;
      break;
    }
    at = end;
  }
  if (!header || !ended || data.length === 0) throw invalid('undecodable', 'the PNG is cut off or has no image data');
  // An sRGB chunk says it all; otherwise a profile, a gamma or primaries must be sRGB's (a browser applies them).
  if (!colour.srgb) {
    if (colour.profile) {
      // The profile's name (up to 79 bytes and a zero), the compression method, then the deflated profile.
      const nameEnd = colour.profile.indexOf(0);
      let profile: Uint8Array;
      try {
        profile = inflateSync(colour.profile.subarray(nameEnd + 2), { maxOutputLength: MAX_LOGO_BYTES });
      } catch {
        throw invalid('undecodable', 'the PNG colour profile cannot be decompressed');
      }
      if (nameEnd < 0 || !isSrgbProfile(profile)) refuseProfile();
    }
    // sRGB's gamma is 1/2.2 (stored as 45455); its primaries in hundred-thousandths, white point first.
    if (colour.gamma !== null && Math.abs(colour.gamma - 45455) > 1000) refuseProfile();
    if (colour.chrm) {
      const srgb = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
      if (srgb.some((v, i) => Math.abs(u32(colour.chrm!, i * 4) - v) > 1000)) refuseProfile();
    }
  }
  const expected = pngRawSize(header.width, header.height, header.bitsPerPixel, header.interlaced);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
  } catch (err) {
    // More data than the header promises stops the inflate at the bound (never inflated further).
    if ((err as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw invalid('undecodable', 'the PNG image data does not match its header');
    }
    throw invalid('undecodable', 'the PNG image data cannot be decompressed');
  }
  if (raw.length !== expected) throw invalid('undecodable', 'the PNG image data does not match its header');
  return { widthPx: header.width, heightPx: header.height };
}

/** The JPEG frame types every PDF reader decodes (DCTDecode): baseline, extended sequential and progressive Huffman. */
const JPEG_SUPPORTED_FRAMES = new Set([0xc0, 0xc1, 0xc2]);
/** Every start-of-frame marker (C4, C8 and CC are other segments). */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function checkJpeg(bytes: Uint8Array): { widthPx: number; heightPx: number } {
  let at = 2;
  let frame: { width: number; height: number; components: number } | null = null;
  let adobe = false;
  let scanAt = -1;
  const profile: Uint8Array[] = [];
  // The segments up to the first scan: the frame header must come before it.
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) throw invalid('undecodable', 'the JPEG is malformed');
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1; // a fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      throw invalid('undecodable', 'the JPEG is malformed');
    }
    const length = u16(bytes, at + 2);
    if (length < 2 || at + 2 + length > bytes.length) throw invalid('undecodable', 'the JPEG is cut off');
    if (JPEG_FRAMES.has(marker)) {
      if (frame) throw invalid('undecodable', 'the JPEG has more than one frame');
      if (!JPEG_SUPPORTED_FRAMES.has(marker)) {
        throw invalid(
          'not_embeddable',
          'the JPEG uses a coding PDF readers do not draw (lossless, hierarchical or arithmetic); save it as a baseline JPEG or a PNG',
        );
      }
      if (length < 8) throw invalid('undecodable', 'the JPEG frame header is malformed');
      const precision = bytes[at + 4];
      const height = u16(bytes, at + 5);
      const width = u16(bytes, at + 7);
      const components = bytes[at + 9];
      if (precision !== 8) {
        throw invalid('not_embeddable', 'the JPEG is not 8 bits per channel; save it as a baseline JPEG or a PNG');
      }
      if (![1, 3, 4].includes(components)) throw invalid('not_embeddable', 'the JPEG has an unsupported number of colour channels');
      // A height of 0 is defined later in the scan (a define-number-of-lines
      // marker), which pdf-lib cannot read.
      if (height === 0) throw invalid('not_embeddable', 'the JPEG does not state its height in the frame header');
      checkPixels(width, height);
      frame = { width, height, components };
    }
    const segment = bytes.subarray(at + 4, at + 2 + length);
    // Application segment 1 (APP1) "Exif\0\0": the camera metadata, with the rotation flag.
    if (marker === 0xe1 && segment.length > 6 && String.fromCharCode(...segment.subarray(0, 6)) === 'Exif\0\0') {
      checkOrientation(segment.subarray(6));
    }
    // Application segment 2 (APP2) "ICC_PROFILE\0", sequence number, count: one piece of the colour profile.
    if (marker === 0xe2 && segment.length > 14 && String.fromCharCode(...segment.subarray(0, 12)) === 'ICC_PROFILE\0') {
      profile.push(segment.subarray(14));
    }
    // Application segment 14 (APP14) "Adobe": how the colour channels are stored.
    if (marker === 0xee && segment.length >= 5 && String.fromCharCode(...segment.subarray(0, 5)) === 'Adobe') adobe = true;
    if (marker === 0xda) {
      scanAt = at;
      break;
    }
    at += 2 + length;
  }
  if (!frame) throw invalid('undecodable', 'the JPEG has no frame header');
  if (frame.components === 4 && !adobe) {
    throw invalid(
      'not_embeddable',
      'the JPEG is CMYK without the Adobe colour marker and would print with wrong colours; save it as RGB',
    );
  }
  if (profile.length > 0 && frame.components === 3 && !isSrgbProfile(new Uint8Array(Buffer.concat(profile)))) refuseProfile();
  if (scanAt < 0) throw invalid('undecodable', 'the JPEG has no image data');
  // Each scan starts with a marker (in the coded data a 0xFF byte is always
  // followed by 0x00 or a restart marker). Counted from the first scan on:
  // metadata before it (an Exif thumbnail) may hold its own. Tables or
  // comments between scans can hold the same two bytes, so the count can only
  // be too high (a refusal), never too low.
  let scans = 0;
  for (let i = scanAt; i < bytes.length - 1; i += 1) if (bytes[i] === 0xff && bytes[i + 1] === 0xda) scans += 1;
  // A progressive JPEG has about ten; thousands of tiny scans would burn CPU in the decoder.
  if (scans > 64) throw invalid('undecodable', `the JPEG has ${scans} scans, at most 64`);
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw invalid('undecodable', 'the JPEG is cut off or has data after its end marker');
  }
  let decoded: { width: number; height: number };
  try {
    decoded = decodeJpeg(bytes, { useTArray: true, tolerantDecoding: false, maxResolutionInMP: 4.5, maxMemoryUsageInMB: 128 });
  } catch {
    throw invalid('undecodable', 'the JPEG cannot be decoded');
  }
  if (decoded.width !== frame.width || decoded.height !== frame.height) {
    throw invalid('undecodable', 'the JPEG does not decode to the size its header states');
  }
  return { widthPx: frame.width, heightPx: frame.height };
}

/**
 * Check an uploaded logo (the file header's six steps; the route has bounded
 * the size already). Answers its type and pixel size, or throws the BooksError
 * that names what is wrong.
 */
export async function checkLogoImage(bytes: Uint8Array, declared: string): Promise<CheckedLogo> {
  if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(declared)) {
    throw new BooksError('UNSUPPORTED_ASSET_TYPE', 'a logo is a PNG or a JPEG (image/png or image/jpeg)', { contentType: declared });
  }
  if (bytes.byteLength === 0) throw invalid('undecodable', 'the file is empty');
  const sniffed = sniffLogoType(bytes);
  if (sniffed !== declared) {
    throw new BooksError(
      'UNSUPPORTED_ASSET_TYPE',
      sniffed ? `the file is a ${sniffed === 'image/png' ? 'PNG' : 'JPEG'} but was sent as ${declared}` : `the file is not a ${declared === 'image/png' ? 'PNG' : 'JPEG'}`,
      { contentType: declared },
    );
  }
  if (bytes.byteLength > MAX_LOGO_BYTES) {
    throw new BooksError('ASSET_TOO_LARGE', `a logo has at most ${MAX_LOGO_BYTES} bytes`, { maxBytes: MAX_LOGO_BYTES });
  }
  const size = sniffed === 'image/png' ? checkPng(bytes) : checkJpeg(bytes);
  let embedded: number;
  try {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    const image = sniffed === 'image/png' ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    if (image.width !== size.widthPx || image.height !== size.heightPx) throw new Error('size mismatch');
    pdf.addPage([100, 100]).drawImage(image, { x: 0, y: 0, width: 10, height: 10 });
    embedded = (await pdf.save()).byteLength;
  } catch {
    throw invalid('not_embeddable', 'the image cannot be placed into a PDF');
  }
  if (embedded > MAX_EMBEDDED_BYTES) {
    const mb = (embedded / (1024 * 1024)).toFixed(1);
    throw invalid('not_embeddable', `the image would add ${mb} MB to every invoice PDF (at most 2 MB); save it smaller or as a JPEG`);
  }
  return { contentType: sniffed, ...size };
}
