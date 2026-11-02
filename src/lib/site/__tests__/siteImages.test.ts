// src/lib/site/__tests__/siteImages.test.ts
//
// The site image rules (siteImages.ts): what each kind accepts, read from the
// bytes; every refusal with its status and a message naming the next step;
// SVG refused as such; the public path and its parser; the warnings for shapes
// that work but look poor; and the settings validation accepting an uploaded
// path beside an https address.

import { describe, expect, it } from 'vitest';

import { ico, jpegHeader, png, svgText, webpLossy } from '@/lib/images/__tests__/fixtures';
import {
  MAX_SITE_IMAGE_BYTES,
  checkSiteImage,
  editorSiteImageUrl,
  isSiteImagePath,
  parseSiteImageFile,
  parseSiteImagePath,
  siteImagePath,
  siteImageWarnings,
} from '../siteImages';
import { isImageReference, normalizeSiteSettings, validateSiteSettings } from '../siteSettings';

const SHA = 'a'.repeat(64);

function refusal(bytes: Uint8Array, kind: 'favicon' | 'sharing') {
  const result = checkSiteImage(bytes, kind);
  return result.ok ? null : result.problem;
}

describe('checkSiteImage', () => {
  it('accepts a PNG or an ICO favicon and reads its size', () => {
    expect(checkSiteImage(png(512, 512), 'favicon')).toEqual({ ok: true, contentType: 'image/png', width: 512, height: 512 });
    expect(checkSiteImage(ico([16, 32, 48]), 'favicon')).toEqual({ ok: true, contentType: 'image/x-icon', width: 48, height: 48 });
  });

  it('accepts a PNG, JPEG or WebP sharing image', () => {
    expect(checkSiteImage(png(1200, 630), 'sharing')).toMatchObject({ ok: true, contentType: 'image/png' });
    expect(checkSiteImage(jpegHeader(1200, 630), 'sharing')).toMatchObject({ ok: true, contentType: 'image/jpeg' });
    expect(checkSiteImage(webpLossy(1200, 630), 'sharing')).toMatchObject({ ok: true, contentType: 'image/webp' });
  });

  it('refuses a type the kind does not take with 415, naming what to upload instead', () => {
    expect(refusal(jpegHeader(64, 64), 'favicon')).toMatchObject({ code: 'unsupported_image_type', status: 415 });
    expect(refusal(jpegHeader(64, 64), 'favicon')?.message).toMatch(/PNG or an ICO/);
    expect(refusal(ico([32]), 'sharing')).toMatchObject({ code: 'unsupported_image_type', status: 415 });
    expect(refusal(new TextEncoder().encode('GIF89a..........'), 'sharing')?.message).toMatch(/PNG, JPEG or WebP/);
  });

  it('refuses SVG for both kinds, saying why and what to do', () => {
    const favicon = refusal(svgText(), 'favicon');
    expect(favicon).toMatchObject({ code: 'unsupported_image_type', status: 415 });
    expect(favicon?.message).toMatch(/SVG files cannot be uploaded, because an SVG can carry script/);
    expect(favicon?.message).toMatch(/https address of an SVG hosted elsewhere/);
    expect(refusal(svgText(), 'sharing')?.message).toMatch(/SVG files cannot be used as a sharing image/);
  });

  it('never trusts a name: a PNG renamed to .svg is a PNG, an SVG renamed to .png is refused', () => {
    // There is no name to pass: only the bytes reach the check.
    expect(checkSiteImage(png(64, 64), 'favicon').ok).toBe(true);
    expect(checkSiteImage(svgText(), 'favicon').ok).toBe(false);
  });

  it('refuses a file over 2 MB with 413', () => {
    const big = new Uint8Array(MAX_SITE_IMAGE_BYTES + 1);
    big.set(png(1, 1));
    expect(refusal(big, 'sharing')).toMatchObject({ code: 'image_too_large', status: 413 });
    expect(refusal(big, 'sharing')?.message).toMatch(/at most 2 MB/);
  });

  it('refuses an unreadable header, too many pixels and a favicon under 16 pixels with 422', () => {
    expect(refusal(png(1, 1).subarray(0, 12), 'sharing')).toMatchObject({ code: 'image_invalid', status: 422 });
    expect(refusal(jpegHeader(9000, 100), 'sharing')).toMatchObject({ code: 'image_invalid', status: 422 });
    expect(refusal(png(8, 8), 'favicon')?.message).toMatch(/at least 16 by 16/);
    expect(checkSiteImage(png(8, 8), 'sharing').ok).toBe(true);
  });
});

describe('site image paths', () => {
  it('names an upload by hash and type and reads it back', () => {
    expect(siteImagePath(SHA, 'image/png')).toBe(`/site-images/${SHA}.png`);
    expect(siteImagePath(SHA, 'image/jpeg')).toBe(`/site-images/${SHA}.jpg`);
    expect(siteImagePath(SHA, 'image/x-icon')).toBe(`/site-images/${SHA}.ico`);
    expect(parseSiteImagePath(`/site-images/${SHA}.webp`)).toEqual({ sha256: SHA, contentType: 'image/webp' });
    expect(parseSiteImageFile(`${SHA}.ico`)).toEqual({ sha256: SHA, contentType: 'image/x-icon' });
  });

  it('accepts nothing but the exact shape', () => {
    for (const bad of [
      '',
      `/site-images/${SHA}`,
      `/site-images/${SHA}.svg`,
      `/site-images/${SHA.toUpperCase()}.png`,
      `/site-images/${SHA}.png?x=1`,
      `/site-images/../${SHA}.png`,
      `https://example.com/site-images/${SHA}.png`,
      `site-images/${SHA}.png`,
    ]) {
      expect(isSiteImagePath(bad)).toBe(false);
    }
  });

  it('maps an upload to the editor preview address and anything else to null', () => {
    expect(editorSiteImageUrl('p 1', `/site-images/${SHA}.png`)).toBe(`/api/projects/p%201/images/${SHA}`);
    expect(editorSiteImageUrl('p', 'https://x.test/a.png')).toBeNull();
  });
});

describe('siteImageWarnings', () => {
  it('warns about a non-square or small favicon, never about a good one', () => {
    expect(siteImageWarnings('favicon', { width: 512, height: 512 })).toEqual([]);
    expect(siteImageWarnings('favicon', { width: 512, height: 256 }).join(' ')).toMatch(/squashed/);
    expect(siteImageWarnings('favicon', { width: 32, height: 32 }).join(' ')).toMatch(/180 by 180/);
  });

  it('warns about a sharing image far from 1.91 to 1 or under 600 by 315', () => {
    expect(siteImageWarnings('sharing', { width: 1200, height: 630 })).toEqual([]);
    expect(siteImageWarnings('sharing', { width: 1200, height: 628 })).toEqual([]);
    expect(siteImageWarnings('sharing', { width: 1000, height: 1000 }).join(' ')).toMatch(/cut off/);
    expect(siteImageWarnings('sharing', { width: 400, height: 210 }).join(' ')).toMatch(/600 by 315/);
  });
});

describe('settings validation', () => {
  it('accepts an uploaded path or an https address, and nothing else', () => {
    expect(isImageReference(`/site-images/${SHA}.png`)).toBe(true);
    expect(isImageReference('https://cdn.example.com/icon.svg')).toBe(true);
    expect(isImageReference('/site-images/not-a-hash.png')).toBe(false);
    expect(isImageReference('http://x.test/a.png')).toBe(false);

    const ok = validateSiteSettings(normalizeSiteSettings({ faviconUrl: `/site-images/${SHA}.ico`, ogImageUrl: `/site-images/${SHA}.jpg` }));
    expect(ok.faviconUrl).toBeUndefined();
    expect(ok.ogImageUrl).toBeUndefined();
    const bad = validateSiteSettings(normalizeSiteSettings({ faviconUrl: '/images/a.png', ogImageUrl: 'ftp://x' }));
    expect(bad.faviconUrl).toMatch(/Upload an image or enter a full https:\/\/ address/);
    expect(bad.ogImageUrl).toBeDefined();
  });
});
