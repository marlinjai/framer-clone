// The self-hosted font library: what it contains, the @font-face text it
// generates, the page scan and the normalisation of generated font families.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BANNED_FONT_FAMILIES,
  FONT_CATEGORIES,
  FONT_LIBRARY,
  collectPageFonts,
  familiesFromFontShorthand,
  fontFaceCss,
  fontStack,
  getFontFamily,
  normalizeFontFamily,
  parseFontFamilyList,
  type FontScanNode,
} from '../registry';

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
};

describe('FONT_LIBRARY', () => {
  it('holds 12 to 16 families, every category filled, ids and names unique', () => {
    expect(FONT_LIBRARY.length).toBeGreaterThanOrEqual(12);
    expect(FONT_LIBRARY.length).toBeLessThanOrEqual(16);
    for (const cat of FONT_CATEGORIES) expect(FONT_LIBRARY.some((f) => f.category === cat.id)).toBe(true);
    expect(new Set(FONT_LIBRARY.map((f) => f.id)).size).toBe(FONT_LIBRARY.length);
    expect(new Set(FONT_LIBRARY.map((f) => f.cssFamily.toLowerCase())).size).toBe(FONT_LIBRARY.length);
  });

  it('never contains Inter, Geist or Space Grotesk', () => {
    for (const banned of BANNED_FONT_FAMILIES) {
      expect(FONT_LIBRARY.some((f) => f.cssFamily.toLowerCase().includes(banned.toLowerCase()))).toBe(false);
    }
  });

  it.each(FONT_LIBRARY.map((f) => [f.id, f] as const))(
    '%s: pinned exactly in devDependencies, OFL licensed, every face file present',
    (_id, family) => {
      expect(pkg.devDependencies[family.pkg]).toBe(family.version);
      const pkgJson = require.resolve(`${family.pkg}/package.json`);
      const meta = JSON.parse(readFileSync(pkgJson, 'utf8')) as { version: string; license: string };
      expect(meta.version).toBe(family.version);
      expect(meta.license).toBe('OFL-1.1');
      expect(family.faces.some((f) => f.subset === 'latin' && f.style === 'normal')).toBe(true);
      for (const face of family.faces) {
        expect(face.file).toMatch(/\.woff2$/);
        expect(existsSync(join(dirname(pkgJson), 'files', face.file))).toBe(true);
      }
    },
  );
});

describe('fontFaceCss', () => {
  it('declares only the requested families, from the app origin, never a Google host', () => {
    const css = fontFaceCss(['fraunces', 'manrope', 'not-a-font']);
    const families = [...css.matchAll(/font-family:'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(families)).toEqual(new Set(['Fraunces', 'Manrope']));
    const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^\/fonts\/(fraunces|manrope)\/5\.3\.0\/[a-z0-9-]+\.woff2$/);
    expect(css).not.toMatch(/googleapis|gstatic|https?:/);
    expect(css).toContain('font-display:swap');
    expect(css).toContain('font-weight:100 900');
    expect(css).toContain('font-style:italic');
    expect(css).toContain('unicode-range:U+0000-00FF');
  });

  it('gives a single-weight family one weight, and is empty for nothing', () => {
    expect(fontFaceCss(['instrument-serif'])).toContain('font-weight:400;');
    expect(fontFaceCss([])).toBe('');
  });

  it('cannot carry anything that closes a <style> element', () => {
    expect(fontFaceCss(FONT_LIBRARY.map((f) => f.id))).not.toMatch(/[<>]/);
  });
});

describe('parsing font values', () => {
  it('splits a family list, unquoting names', () => {
    expect(parseFontFamilyList(`'Fraunces', "Times New Roman", serif`)).toEqual(['Fraunces', 'Times New Roman', 'serif']);
  });

  it('finds the family list in a font shorthand', () => {
    expect(familiesFromFontShorthand("italic 600 48px/1.1 'Fraunces', serif")).toBe("'Fraunces', serif");
    expect(familiesFromFontShorthand('bold large Sora')).toBe('Sora');
    expect(familiesFromFontShorthand('inherit')).toBe('');
  });
});

describe('collectPageFonts', () => {
  const tree: FontScanNode = {
    type: 'main',
    props: { style: { fontFamily: fontStack(getFontFamily('hanken-grotesk')!) } },
    children: [
      { type: 'section', props: { style: { padding: '8px' } }, children: [{ type: 'h1', props: { children: 'Hi' } }] },
      { type: 'h2', props: { style: { fontFamily: { base: "'Fraunces', serif", mobile: 'Sora, sans-serif' } } } },
      { type: 'p', props: { style: { font: "500 14px/1.4 'JetBrains Mono', monospace" } } },
      { type: 'p', props: { style: { fontFamily: 'Georgia, serif' } } },
    ],
  };

  it('finds families in plain values, responsive maps and the font shorthand, in order of appearance', () => {
    expect(collectPageFonts([tree]).ids).toEqual(['hanken-grotesk', 'fraunces', 'sora', 'jetbrains-mono']);
  });

  it('takes the display family from the first h1, inherited from its ancestors', () => {
    expect(collectPageFonts([tree]).displayId).toBe('hanken-grotesk');
  });

  it('falls back to the first h2 and scans several roots (floating elements)', () => {
    const floating: FontScanNode = { type: 'div', props: { style: { fontFamily: 'Outfit' } } };
    const result = collectPageFonts([{ type: 'div', children: [{ type: 'h2', props: { style: { fontFamily: 'Fraunces' } } }] }, floating, null]);
    expect(result).toEqual({ ids: ['fraunces', 'outfit'], displayId: 'fraunces' });
  });

  it('is empty for a page on system fonts', () => {
    expect(collectPageFonts([{ type: 'div', props: { style: { fontFamily: 'system-ui, sans-serif' } } }])).toEqual({ ids: [], displayId: undefined });
  });
});

describe('normalizeFontFamily', () => {
  it('gives a library family its canonical stack', () => {
    expect(normalizeFontFamily('Fraunces, serif')).toEqual({ value: "'Fraunces', Georgia, 'Times New Roman', serif", changed: true });
    const canonical = fontStack(getFontFamily('manrope')!);
    expect(normalizeFontFamily(canonical)).toEqual({ value: canonical, changed: false });
  });

  it('keeps a system stack', () => {
    expect(normalizeFontFamily('Georgia, serif').changed).toBe(false);
    expect(normalizeFontFamily('system-ui, -apple-system, sans-serif').changed).toBe(false);
  });

  it('replaces banned and unhosted families by the default of their category, with a reason', () => {
    const inter = normalizeFontFamily('Inter, sans-serif');
    expect(inter.value).toBe(fontStack(getFontFamily('hanken-grotesk')!));
    expect(inter.reason).toContain('banned');
    expect(normalizeFontFamily("'Lora', serif").value).toBe(fontStack(getFontFamily('fraunces')!));
    expect(normalizeFontFamily("'Fira Code', monospace").value).toBe(fontStack(getFontFamily('jetbrains-mono')!));
    expect(normalizeFontFamily("'Space Grotesk'").value).toBe(fontStack(getFontFamily('hanken-grotesk')!));
  });
});
