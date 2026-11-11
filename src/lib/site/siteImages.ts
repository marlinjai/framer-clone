// src/lib/site/siteImages.ts
//
// Uploaded site images: the favicon and the sharing (Open Graph) image of a
// site, and a page's own sharing image (plan docs/plans/2026-10-23-published-
// site-essentials.md, "Uploaded favicon and sharing image"). PURE, shared by
// the upload route, the published head and the editor dialogs.
//
// An upload is stored once per site and SHA-256 (src/server/sites/
// siteImages.ts) and named in the settings by a site-relative path,
// `/site-images/<sha256>.<ext>`, beside the https addresses typed by hand.
// The path is served on every host of the site (src/app/site-images/[file]),
// so it keeps working when a custom domain is connected later, and it is
// frozen with the settings into every published revision. The bytes behind
// a path never change, and an image can be deleted only once nothing names it
// (no setting, no page, no kept revision), so a revision shows the image it
// was published with for as long as it is kept. A save that names an image
// the site does not store is refused (SiteImageMissingError): a typed or
// copied path from another site, or one deleted since.
//
// What is accepted, always read from the bytes (src/lib/images/imageHeader.ts):
//   - favicon: PNG or ICO, 16 to 1024 pixels on each side. SVG is refused:
//     it is a document that can carry script, served from the site's own
//     origin it would be a place to run code there, and no header check can
//     prove an SVG harmless. A PNG of 512 by 512 pixels covers every browser
//     and the home screen icons; an SVG hosted elsewhere can still be entered
//     by its https address.
//   - sharing image: PNG, JPEG or WebP.
//   - both: at most 2 MB and 8000 pixels on each side.
// Shapes that work but look poor (a non-square or small favicon, a sharing
// image far from 1.91 to 1 or under 600 by 315) are warnings, never refusals.

import { readImageSize, sniffImageType, looksLikeSvg, type SniffedImageType } from '@/lib/images/imageHeader';

export const SITE_IMAGE_KINDS = ['favicon', 'sharing'] as const;
export type SiteImageKind = (typeof SITE_IMAGE_KINDS)[number];

export type SiteImageContentType = SniffedImageType;

/** The types each kind accepts. */
export const SITE_IMAGE_TYPES: Record<SiteImageKind, readonly SiteImageContentType[]> = {
  favicon: ['image/png', 'image/x-icon'],
  sharing: ['image/png', 'image/jpeg', 'image/webp'],
};

/** The largest upload, in bytes. */
export const MAX_SITE_IMAGE_BYTES = 2 * 1024 * 1024;
/** The longest side, in pixels. */
export const MAX_SITE_IMAGE_PX = 8000;
/** The smallest favicon side, in pixels. */
export const MIN_FAVICON_PX = 16;
/** The largest favicon side, in pixels (no browser or home screen uses more than 512). */
export const MAX_FAVICON_PX = 1024;
/** The most images one site stores. */
export const MAX_SITE_IMAGES = 100;
/** The most bytes one site's images may add up to (50 MB): with the count, what one site can put into the database. */
export const MAX_SITE_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;

/** The refusal at the per-site limit, naming the way forward. */
export const SITE_IMAGE_LIMIT_MESSAGE =
  `This site already stores the most images allowed (${MAX_SITE_IMAGES} images or 50 MB in all). ` +
  'Delete images you no longer use under "Uploaded images" in Site settings, or enter an https address instead.';

/** The public path prefix of an uploaded site image. */
export const SITE_IMAGE_PREFIX = '/site-images/';

const EXTENSIONS: Record<SiteImageContentType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
};
const TYPE_OF_EXTENSION: Record<string, SiteImageContentType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  ico: 'image/x-icon',
};

const FILE = /^([0-9a-f]{64})\.(png|jpg|webp|ico)$/;

export function isSiteImageKind(value: unknown): value is SiteImageKind {
  return typeof value === 'string' && (SITE_IMAGE_KINDS as readonly string[]).includes(value);
}

/** The public path of a stored image: `/site-images/<sha256>.<ext>`. */
export function siteImagePath(sha256: string, contentType: SiteImageContentType): string {
  return `${SITE_IMAGE_PREFIX}${sha256}.${EXTENSIONS[contentType]}`;
}

/** The hash and type named by the last path segment (`<sha256>.<ext>`), or null. */
export function parseSiteImageFile(file: string): { sha256: string; contentType: SiteImageContentType } | null {
  const match = FILE.exec(file);
  return match ? { sha256: match[1], contentType: TYPE_OF_EXTENSION[match[2]] } : null;
}

/** The hash and type of a site image path, or null for anything else (an https URL included). */
export function parseSiteImagePath(value: string): { sha256: string; contentType: SiteImageContentType } | null {
  if (typeof value !== 'string' || !value.startsWith(SITE_IMAGE_PREFIX)) return null;
  return parseSiteImageFile(value.slice(SITE_IMAGE_PREFIX.length));
}

/** True for `/site-images/<sha256>.<ext>`, exactly. */
export function isSiteImagePath(value: string): boolean {
  return parseSiteImagePath(value) !== null;
}

/**
 * The uploaded images a site names: the favicon and sharing image of the
 * settings, and what its pages name (`pageImages`: each page's own sharing
 * image, and the images its FX scenes show, src/lib/fxScene/fxScene.ts).
 * Hash -> path, so a save can check each against what the site stores.
 * Values that are not site image paths (an https address, nothing) are skipped.
 */
export function namedSiteImages(
  siteSettings: { faviconUrl?: unknown; ogImageUrl?: unknown } | null | undefined,
  pageImages: readonly unknown[],
): Map<string, string> {
  const named = new Map<string, string>();
  for (const value of [siteSettings?.faviconUrl, siteSettings?.ogImageUrl, ...pageImages]) {
    if (typeof value !== 'string') continue;
    const parsed = parseSiteImagePath(value);
    if (parsed) named.set(parsed.sha256, value);
  }
  return named;
}

/** The editor's own address of an uploaded image (the dialogs' preview, behind sign-in). */
export function editorSiteImageUrl(projectId: string, value: string): string | null {
  const parsed = parseSiteImagePath(value);
  return parsed ? `/api/projects/${encodeURIComponent(projectId)}/images/${parsed.sha256}` : null;
}

export type SiteImageProblem = {
  code: 'unsupported_image_type' | 'image_too_large' | 'image_invalid';
  status: 415 | 413 | 422;
  message: string;
};

export type SiteImageCheck =
  | { ok: true; contentType: SiteImageContentType; width: number; height: number }
  | { ok: false; problem: SiteImageProblem };

/** `1.4 MB`, `820 KB`, `512 bytes`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function refuse(code: SiteImageProblem['code'], message: string): SiteImageCheck {
  const status = code === 'unsupported_image_type' ? 415 : code === 'image_too_large' ? 413 : 422;
  return { ok: false, problem: { code, status, message } };
}

/** The refusal for a file over the size limit (the route answers it before reading the whole body). */
export function tooLargeProblem(byteSize?: number): SiteImageProblem {
  const actual = byteSize === undefined ? 'This file is larger than 2 MB' : `This file has ${formatBytes(byteSize)}`;
  return {
    code: 'image_too_large',
    status: 413,
    message: `${actual}; an image may have at most 2 MB. Make it smaller (for example export it as a JPEG or at a smaller size) and upload it again.`,
  };
}

/**
 * Check an upload for one kind: its type from the bytes, its size and its
 * pixel size from the header. A refusal carries the HTTP status, a code and a
 * message that says what to do next.
 */
export function checkSiteImage(bytes: Uint8Array, kind: SiteImageKind): SiteImageCheck {
  const type = sniffImageType(bytes);
  if (!type || !SITE_IMAGE_TYPES[kind].includes(type)) {
    if (looksLikeSvg(bytes)) {
      return refuse(
        'unsupported_image_type',
        kind === 'favicon'
          ? 'SVG files cannot be uploaded, because an SVG can carry script. Export the icon as a PNG (512 by 512 pixels works everywhere) and upload that, or enter the https address of an SVG hosted elsewhere.'
          : 'SVG files cannot be used as a sharing image. Export it as a PNG or JPEG (1200 by 630 pixels) and upload that.',
      );
    }
    return refuse(
      'unsupported_image_type',
      kind === 'favicon'
        ? 'A favicon must be a PNG or an ICO file. Save the icon as a PNG (512 by 512 pixels works everywhere) and upload it again.'
        : 'A sharing image must be a PNG, JPEG or WebP file. Export it in one of these formats and upload it again.',
    );
  }
  if (bytes.byteLength > MAX_SITE_IMAGE_BYTES) return { ok: false, problem: tooLargeProblem(bytes.byteLength) };
  const size = readImageSize(bytes, type);
  if (!size) {
    return refuse('image_invalid', 'This file cannot be read as an image, it may be damaged. Open it in an image editor, save it again and upload it.');
  }
  const { width, height } = size;
  if (width > MAX_SITE_IMAGE_PX || height > MAX_SITE_IMAGE_PX || width < 1 || height < 1) {
    return refuse('image_invalid', `This image is ${width} by ${height} pixels; an image may have at most ${MAX_SITE_IMAGE_PX} pixels on each side. Make it smaller and upload it again.`);
  }
  if (kind === 'favicon' && (width < MIN_FAVICON_PX || height < MIN_FAVICON_PX)) {
    return refuse('image_invalid', `This icon is ${width} by ${height} pixels; a favicon needs at least ${MIN_FAVICON_PX} by ${MIN_FAVICON_PX}. Use a larger square image (512 by 512 works everywhere).`);
  }
  if (kind === 'favicon' && (width > MAX_FAVICON_PX || height > MAX_FAVICON_PX)) {
    return refuse('image_invalid', `This icon is ${width} by ${height} pixels; a favicon may have at most ${MAX_FAVICON_PX} pixels on each side. Save it at 512 by 512 and upload it again.`);
  }
  return { ok: true, contentType: type, width, height };
}

/** The recommended sharing image size and its ratio. */
export const SHARING_IMAGE_SIZE = { width: 1200, height: 630 } as const;
const SHARING_RATIO = SHARING_IMAGE_SIZE.width / SHARING_IMAGE_SIZE.height;
/** How far the ratio may drift (relative) before a warning: 1200 by 628 or 1280 by 670 are fine. */
const SHARING_RATIO_TOLERANCE = 0.03;

/** What works but will look poor, in words for the owner. Empty when the image suits its use. */
export function siteImageWarnings(kind: SiteImageKind, size: { width: number; height: number }): string[] {
  const { width, height } = size;
  const warnings: string[] = [];
  if (kind === 'favicon') {
    if (width !== height) {
      warnings.push(`This icon is ${width} by ${height} pixels. Browsers show icons square, so it will look squashed; a square image works best.`);
    }
    if (Math.min(width, height) < 180) {
      warnings.push(`This icon is small (${width} by ${height} pixels). Phones use 180 by 180 for the home screen, so a larger square image (512 by 512) looks sharper.`);
    }
    return warnings;
  }
  if (Math.abs(width / height / SHARING_RATIO - 1) > SHARING_RATIO_TOLERANCE) {
    warnings.push(`This image is ${width} by ${height} pixels. Sharing previews are shown at 1.91 to 1 (1200 by 630), so parts of it may be cut off.`);
  }
  if (width < 600 || height < 315) {
    warnings.push(`This image is small (${width} by ${height} pixels). Many apps show images under 600 by 315 as a small thumbnail or not at all; 1200 by 630 works everywhere.`);
  }
  return warnings;
}
