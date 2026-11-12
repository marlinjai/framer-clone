// The address of a branch's public preview link (src/lib/sites/previewHost.ts): which hosts have its shape.

import { describe, expect, it } from 'vitest';
import { isPreviewHost, isPreviewLabel, previewHostOf, previewTokenOfHost, PREVIEW_TOKEN_PATTERN } from '../previewHost';

const BASE = 'sites.lumitra.co';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz234567';

describe('previewTokenOfHost', () => {
  it('reads the token of a well-formed preview address, in any letter case, with a port or a trailing dot', () => {
    expect(TOKEN).toMatch(PREVIEW_TOKEN_PATTERN);
    for (const host of [`preview-${TOKEN}.${BASE}`, `PREVIEW-${TOKEN.toUpperCase()}.SITES.LUMITRA.CO`, `preview-${TOKEN}.${BASE}:443`, `preview-${TOKEN}.${BASE}.`]) {
      expect(previewTokenOfHost(host, BASE), host).toBe(TOKEN);
    }
  });

  it('answers null for every other host', () => {
    for (const host of [
      `preview-${TOKEN.slice(1)}.${BASE}`, // too short
      `preview-${TOKEN}a.${BASE}`, // too long
      `preview-${TOKEN.slice(0, 31)}1.${BASE}`, // 1 is not base32
      `preview-${TOKEN.slice(0, 31)}_.${BASE}`,
      `preview.${BASE}`,
      `preview-.${BASE}`,
      `${TOKEN}.${BASE}`,
      `x.preview-${TOKEN}.${BASE}`, // deeper
      `preview-${TOKEN}.x.${BASE}`,
      `preview-${TOKEN}.example.com`, // another base, a custom domain
      `preview-${TOKEN}.evil${BASE}`,
      BASE,
      'app.lumitra.co',
      '',
    ]) {
      expect(previewTokenOfHost(host, BASE), host).toBeNull();
    }
    expect(previewTokenOfHost(null, BASE)).toBeNull();
    expect(previewTokenOfHost(undefined, BASE)).toBeNull();
  });

  it('knows no preview address while no sites base host is configured', () => {
    for (const base of [undefined, null, '', '  ']) {
      expect(previewTokenOfHost(`preview-${TOKEN}.${BASE}`, base)).toBeNull();
      expect(isPreviewHost(`preview-${TOKEN}.${BASE}`, base)).toBe(false);
      expect(previewHostOf(TOKEN, base)).toBeNull();
    }
  });
});

describe('isPreviewHost', () => {
  it('is true for any label kept for previews under the base, well-formed token or not', () => {
    for (const host of [`preview-${TOKEN}.${BASE}`, `preview-nope.${BASE}`, `preview-.${BASE}`, `PREVIEW-X.${BASE}`, `preview-a.b.${BASE}`]) {
      expect(isPreviewHost(host, BASE), host).toBe(true);
    }
  });

  it('is false for published sites, the base itself, custom domains and other bases', () => {
    for (const host of [`acme.${BASE}`, `previews.${BASE}`, `preview.${BASE}`, `mypreview-x.${BASE}`, `x.preview-y.${BASE}`, BASE, `preview-${TOKEN}.example.com`, 'www.acme-shop.de', '']) {
      expect(isPreviewHost(host, BASE), host).toBe(false);
    }
  });
});

describe('isPreviewLabel and previewHostOf', () => {
  it('keeps every label that starts with the prefix, whatever its case', () => {
    expect(isPreviewLabel('preview-abc')).toBe(true);
    expect(isPreviewLabel('Preview-ABC')).toBe(true);
    expect(isPreviewLabel('preview')).toBe(false);
    expect(isPreviewLabel('previewer')).toBe(false);
  });

  it('builds the address a token is read back from', () => {
    const host = previewHostOf(TOKEN, ` ${BASE.toUpperCase()}. `);
    expect(host).toBe(`preview-${TOKEN}.${BASE}`);
    expect(previewTokenOfHost(host, BASE)).toBe(TOKEN);
  });
});
