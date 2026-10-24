// src/lib/books/engine/resources.ts
//
// What the browser's draft render draws with, besides the render input
// (WYSIWYG invoice editor plan, phase 1):
//
//   fonts     only the family the template uses, fetched by digest
//             (GET /api/books/fonts/<sha256>) and checked against the same
//             pins the server checks its files against (render/fontPins.ts).
//             A file that differs is refused (`font_hash_mismatch`): drawing
//             with other glyphs would be a page the server never draws.
//   coverage  which characters both faces draw, from the fetched bytes with
//             fontkit (the same library and the same rule as the server's
//             fonts.ts), so "?" replaces exactly the characters it replaces
//             on the server.
//   logos     the logos the render input lists (the template names them and
//             the company has them), fetched by hash
//             (GET /api/books/assets/<sha256>) and checked against it. One
//             that cannot be fetched is an error (`logo_fetch_failed`), never
//             a page drawn without it.
//
// Fonts and coverage are kept for the life of the worker (a file behind a
// digest never changes; three families at most), logos up to MAX_LOGOS, least
// recently used out; a failed fetch is not kept, so the next render tries
// again. Pure apart from the `fetch` passed in: no Node imports.

import fontkit from '@pdf-lib/fontkit';

import type { EngineFonts, EngineImage } from '@/server/books/render/engine';
import type { DraftResources } from '@/server/books/render/draftRender';
import { FONT_FILES, type FontFace } from '@/server/books/render/fontPins';
import type { CanDraw } from '@/server/books/render/previewSafe';
import { hasItalic } from '@/server/books/render/richText';
import type { FontFamily } from '@/server/books/template/schema';

import { BrowserRenderError } from './errors';
import type { LogoRef, RenderInputPayload } from './payload';

/** Fetch a same-origin path ("/api/books/..."); the worker passes `fetch` against its origin, a test anything answering a Response. */
export type Fetcher = (path: string) => Promise<Response>;

const fonts = new Map<FontFamily, Promise<EngineFonts>>();
/** The italic faces, fetched only for a draft with an italic run (most never have one). */
const italicFonts = new Map<FontFamily, Promise<{ italic: Uint8Array; boldItalic: Uint8Array }>>();
const coverage = new Map<string, CanDraw>();
const logos = new Map<string, Promise<EngineImage>>();

/** Forget every loaded file (a test seam: the next render fetches again). */
export function clearLoadedResources(): void {
  fonts.clear();
  italicFonts.clear();
  coverage.clear();
  logos.clear();
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A copy into a plain ArrayBuffer: Web Crypto refuses a view on a shared buffer.
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function get(fetcher: Fetcher, path: string, code: 'font_fetch_failed' | 'logo_fetch_failed', what: string): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetcher(path);
  } catch (err) {
    throw new BrowserRenderError(code, `${what} could not be loaded (${err instanceof Error ? err.message : String(err)}).`, { path });
  }
  if (!res.ok) throw new BrowserRenderError(code, `${what} could not be loaded (HTTP ${res.status}).`, { path, status: res.status });
  return new Uint8Array(await res.arrayBuffer());
}

async function fetchFace(fetcher: Fetcher, family: FontFamily, face: FontFace): Promise<Uint8Array> {
  const pin = FONT_FILES[family][face];
  const bytes = await get(fetcher, `/api/books/fonts/${pin.sha256}`, 'font_fetch_failed', `The font ${pin.file}`);
  const digest = await sha256Hex(bytes);
  if (digest !== pin.sha256) {
    throw new BrowserRenderError('font_hash_mismatch', `The font ${pin.file} is not the pinned file.`, {
      file: pin.file,
      expected: pin.sha256,
      actual: digest,
    });
  }
  return bytes;
}

/** Keep a promise for the life of the worker, unless it fails (then the next call tries again). */
function remember<K, V>(cache: Map<K, Promise<V>>, key: K, make: () => Promise<V>): Promise<V> {
  const known = cache.get(key);
  if (known) return known;
  const p = make();
  cache.set(key, p);
  p.catch(() => {
    if (cache.get(key) === p) cache.delete(key);
  });
  return p;
}

/** The two faces of a family, fetched and checked against their pins. */
export function loadFontFamily(fetcher: Fetcher, family: FontFamily): Promise<EngineFonts> {
  if (!Object.hasOwn(FONT_FILES, family)) {
    return Promise.reject(new BrowserRenderError('invalid_input', `Unknown font family ${JSON.stringify(family)}.`, { family }));
  }
  return remember(fonts, family, async () => {
    const [regular, bold] = await Promise.all([fetchFace(fetcher, family, 'regular'), fetchFace(fetcher, family, 'bold')]);
    return { regular, bold };
  });
}

/** The two italic faces of a family, fetched and checked against their pins. */
export function loadItalicFaces(fetcher: Fetcher, family: FontFamily): Promise<{ italic: Uint8Array; boldItalic: Uint8Array }> {
  if (!Object.hasOwn(FONT_FILES, family)) {
    return Promise.reject(new BrowserRenderError('invalid_input', `Unknown font family ${JSON.stringify(family)}.`, { family }));
  }
  return remember(italicFonts, family, async () => {
    const [italic, boldItalic] = await Promise.all([fetchFace(fetcher, family, 'italic'), fetchFace(fetcher, family, 'boldItalic')]);
    return { italic, boldItalic };
  });
}

interface Face {
  hasGlyphForCodePoint(cp: number): boolean;
}

/**
 * True when BOTH faces of a pair draw the code point: the server's rule (fonts.ts canDraw, canDrawItalic), over the
 * fetched bytes. The upright pair by default; `italic` for the italic pair.
 */
export function coverageOf(family: FontFamily, files: EngineFonts, italic = false): CanDraw {
  const key = `${family}|${italic ? 'italic' : 'upright'}`;
  let can = coverage.get(key);
  if (!can) {
    const pair = italic ? [files.italic, files.boldItalic] : [files.regular, files.bold];
    if (!pair[0] || !pair[1]) throw new BrowserRenderError('invalid_input', 'The italic faces were not loaded.', { family });
    // fontkit reads a Uint8Array; the server's `as Buffer` cast is a type cast only.
    const faces = pair.map((bytes) => fontkit.create(bytes as unknown as Buffer)) as unknown as Face[];
    const memo = new Map<number, boolean>();
    can = (cp) => {
      let v = memo.get(cp);
      if (v === undefined) {
        v = faces.every((f) => f.hasGlyphForCodePoint(cp));
        memo.set(cp, v);
      }
      return v;
    };
    coverage.set(key, can);
  }
  return can;
}

/** How many logos a worker keeps (a company uses one or two; a company switch brings others). */
const MAX_LOGOS = 8;

/** A logo by its hash, fetched and checked against it. */
export function loadLogo(fetcher: Fetcher, logo: LogoRef): Promise<EngineImage> {
  const known = logos.get(logo.sha256);
  if (known) {
    // Most recently used last.
    logos.delete(logo.sha256);
    logos.set(logo.sha256, known);
    return known;
  }
  const loading = remember(logos, logo.sha256, async () => {
    const bytes = await get(fetcher, `/api/books/assets/${logo.sha256}`, 'logo_fetch_failed', 'The logo');
    const digest = await sha256Hex(bytes);
    if (digest !== logo.sha256) {
      throw new BrowserRenderError('logo_hash_mismatch', 'The logo is not the image its hash names.', { expected: logo.sha256, actual: digest });
    }
    return { contentType: logo.contentType, bytes };
  });
  // Least recently used out, once this one is loaded (a logo that fails to load never pushes out a good one).
  loading.then(
    () => {
      for (const old of [...logos.keys()]) {
        if (logos.size <= MAX_LOGOS) break;
        if (old !== logo.sha256) logos.delete(old);
      }
    },
    () => {},
  );
  return loading;
}

/** Everything a draft render draws with, loaded (or taken from what this worker already loaded). */
export async function loadDraftResources(fetcher: Fetcher, payload: RenderInputPayload): Promise<DraftResources> {
  const doc = payload.input.document;
  const italic = hasItalic(doc.introFormat) || hasItalic(doc.outroFormat);
  const [upright, italicFaces, images] = await Promise.all([
    loadFontFamily(fetcher, payload.fontFamily),
    italic ? loadItalicFaces(fetcher, payload.fontFamily) : Promise.resolve(null),
    Promise.all(payload.logos.map(async (l) => [l.sha256, await loadLogo(fetcher, l)] as const)),
  ]);
  const files: EngineFonts = italicFaces ? { ...upright, ...italicFaces } : upright;
  return {
    fonts: files,
    canDraw: coverageOf(payload.fontFamily, files),
    canDrawItalic: italicFaces ? coverageOf(payload.fontFamily, files, true) : undefined,
    assets: new Map(images),
  };
}
