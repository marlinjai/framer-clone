// @vitest-environment node
// src/lib/books/engine/__tests__/parity.test.ts
//
// The browser's draft render equals the server's, byte for byte (WYSIWYG
// invoice editor plan, decision 2 and phase 1, parity layer (a)). The browser
// side is imported through the BROWSER entry (render.ts, resources.ts,
// payload.ts: fonts fetched and checked against their pins, coverage built
// from the fetched bytes with fontkit, the payload sent through JSON and read
// back with its dates revived); the server side through the server's own
// modules (fonts.ts from disk, drawable.ts, the engine), exactly as the draft
// PDF route (store.ts `documentPdf`) and the issued render draw. Every
// template preset times every probe document, in all three font families,
// draft and not draft; plus characters no family draws (shown as "?" in a
// draft) and a logo. And every unhappy path answers its named error, never a
// page drawn differently: a font that cannot be fetched or is not the pinned
// file, a logo that cannot be fetched or is not its hash, an input that is not
// a draft or is malformed.
//
// What this layer cannot see is the bundler (a Buffer shim, a different
// module resolved for the browser): parity layer (b) renders in a real browser
// from the built worker chunk (scripts/books-engine-browser-parity).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { previewSafe, previewSafeTemplate } from '@/server/books/render/drawable';
import { renderTemplate, type EngineImage } from '@/server/books/render/engine';
import { FONT_FILES, fontFiles } from '@/server/books/render/fonts';
import { buildRenderModel } from '@/server/books/render/model';
import { PRESETS, preset } from '@/server/books/template/presets';
import { PROBE_NAMES, probe, probeInput, type ProbeName } from '@/server/books/template/probes';
import { FONT_FAMILIES, type FontFamily, type TemplateDocumentV2 } from '@/server/books/template/schema';
import { makePng } from '@/server/books/__tests__/testImages';

import { BrowserRenderError } from '../errors';
import { parseRenderInputPayload, RENDER_INPUT_FORMAT, type RenderInputPayload } from '../payload';
import { renderDraftPayload } from '../render';
import { clearLoadedResources, loadDraftResources, type Fetcher } from '../resources';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');

const LOGO = makePng(240, 80, { colorType: 6 });
const LOGO_SHA = sha(LOGO);

/** What the browser's fetch would answer: the font route and the asset route, from files (the routes have their own tests). */
function filesFetcher(overrides: Record<string, () => Response> = {}): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = async (p: string): Promise<Response> => {
    calls.push(p);
    if (overrides[p]) return overrides[p]();
    const font = /^\/api\/books\/fonts\/([0-9a-f]{64})$/.exec(p);
    if (font) {
      for (const faces of Object.values(FONT_FILES)) {
        for (const pin of Object.values(faces)) {
          if (pin.sha256 === font[1]) return new Response(readFileSync(path.join(FONT_DIR, pin.file)), { status: 200 });
        }
      }
      return new Response('{}', { status: 404 });
    }
    if (p === `/api/books/assets/${LOGO_SHA}`) return new Response(LOGO.slice(), { status: 200, headers: { 'content-type': 'image/png' } });
    return new Response('{}', { status: 404 });
  };
  return Object.assign(f, { calls });
}

function withFamily(doc: TemplateDocumentV2, family: FontFamily): TemplateDocumentV2 {
  return { ...doc, theme: { ...doc.theme, fontFamily: family } };
}

/** The payload as the render-input route sends it: through JSON, read back by the browser. */
function wire(input: ReturnType<typeof probeInput>, template: TemplateDocumentV2, logos: RenderInputPayload['logos'] = []): RenderInputPayload {
  const payload: RenderInputPayload = {
    format: RENDER_INPUT_FORMAT,
    documentId: input.document.id,
    documentVersion: input.document.version,
    fontFamily: template.theme.fontFamily,
    input,
    template,
    logos,
  };
  return parseRenderInputPayload(JSON.parse(JSON.stringify(payload)));
}

/** The server's draft PDF route (store.ts documentPdf), with its own modules. */
async function serverDraft(input: ReturnType<typeof probeInput>, template: TemplateDocumentV2, assets = new Map<string, EngineImage>()): Promise<Uint8Array> {
  const family = template.theme.fontFamily;
  return (await renderTemplate(previewSafe(buildRenderModel(input), family), previewSafeTemplate(template), fontFiles(family), { assets })).bytes;
}

/** The server's issued render (store.ts draw, engine layout): no "?" replacement. */
async function serverIssued(input: ReturnType<typeof probeInput>, template: TemplateDocumentV2): Promise<Uint8Array> {
  return (await renderTemplate(buildRenderModel(input), template, fontFiles(template.theme.fontFamily))).bytes;
}

beforeEach(() => clearLoadedResources());

const CASES = PRESETS.flatMap((p) => FONT_FAMILIES.map((family) => [p, family] as const));

describe('the browser draft render equals the server draft PDF route', () => {
  it.each(CASES)('%s in %s, every probe document, as a draft', async (presetName, family) => {
    const fetcher = filesFetcher();
    for (const name of PROBE_NAMES) {
      const input = probeInput(probe(name as ProbeName), true);
      const template = withFamily(preset(presetName), family);
      const browser = await renderDraftPayload(fetcher, wire(input, template));
      expect(sha(browser.bytes), `${presetName}/${family}/${name}`).toBe(sha(await serverDraft(input, template)));
    }
    // Each file fetched once for the whole family (kept by the worker), only the family in use.
    expect(fetcher.calls.sort()).toEqual([FONT_FILES[family].bold.sha256, FONT_FILES[family].regular.sha256].map((s) => `/api/books/fonts/${s}`).sort());
  }, 120_000);

  it.each(CASES)('%s in %s, every probe document, not a draft (the fetched fonts draw the issued bytes)', async (presetName, family) => {
    const fetcher = filesFetcher();
    for (const name of PROBE_NAMES) {
      const input = probeInput(probe(name as ProbeName), false);
      const template = withFamily(preset(presetName), family);
      const payload = wire({ ...input, draft: true }, template);
      const { fonts } = await loadDraftResources(fetcher, payload);
      const browser = await renderTemplate(buildRenderModel({ ...payload.input, draft: false }), payload.template, fonts);
      expect(sha(browser.bytes), `${presetName}/${family}/${name}`).toBe(sha(await serverIssued(input, template)));
    }
  }, 120_000);

  it.each(FONT_FAMILIES)('characters %s cannot draw are "?" exactly as on the server', async (family) => {
    const input = probeInput(probe('regular'), true);
    input.recipient = { ...input.recipient!, name: 'Grüße 漢字 ✓ 🙂 Ωμέγα Жук' };
    input.lines = input.lines.map((l, i) => (i === 0 ? { ...l, title: 'Beratung ☃ 漢 ff' } : l));
    const template = withFamily(preset('modern'), family);
    template.regions.body.push({ id: 'note', type: 'freeText', style: {}, heading: '注意', text: 'Text mit ✈ und ẞ', variant: 'normal' });
    const browser = await renderDraftPayload(filesFetcher(), wire(input, template));
    expect(sha(browser.bytes)).toBe(sha(await serverDraft(input, template)));
  });

  it.each(FONT_FAMILIES)('a draft with a logo in %s', async (family) => {
    const input = probeInput(probe('longInvoice'), true);
    const template = withFamily(preset('modern'), family);
    template.regions.firstPageHeader = [{ id: 'logo', type: 'logo', style: { align: 'right' }, widthMm: 40, assetSha256: LOGO_SHA }];
    const fetcher = filesFetcher();
    const browser = await renderDraftPayload(fetcher, wire(input, template, [{ sha256: LOGO_SHA, contentType: 'image/png' }]));
    const assets = new Map<string, EngineImage>([[LOGO_SHA, { contentType: 'image/png', bytes: LOGO }]]);
    expect(sha(browser.bytes)).toBe(sha(await serverDraft(input, template, assets)));
    expect(fetcher.calls).toContain(`/api/books/assets/${LOGO_SHA}`);
    expect(browser.layout.issues).toEqual([]);
  });

  it('a logo the company does not have is drawn empty and named, as on the server', async () => {
    const input = probeInput(probe('regular'), true);
    const template = preset('klassisch');
    template.regions.firstPageHeader = [{ id: 'logo', type: 'logo', style: {}, widthMm: 40, assetSha256: 'a'.repeat(64) }];
    const browser = await renderDraftPayload(filesFetcher(), wire(input, template, []));
    expect(sha(browser.bytes)).toBe(sha(await serverDraft(input, template)));
    expect(browser.layout.issues.map((i) => i.code)).toContain('LOGO_ASSET_MISSING');
  });

  it('the layout map equals the server one', async () => {
    const input = probeInput(probe('longInvoice'), true);
    const template = preset('kompakt');
    const browser = await renderDraftPayload(filesFetcher(), wire(input, template));
    const family = template.theme.fontFamily;
    const server = await renderTemplate(previewSafe(buildRenderModel(input), family), previewSafeTemplate(template), fontFiles(family), {});
    expect(browser.layout).toEqual(server.layout);
    expect(browser.layout.pageCount).toBeGreaterThan(1);
  });
});

describe('the browser draft render refuses instead of drawing differently', () => {
  const draft = () => wire(probeInput(probe('regular'), true), preset('klassisch'));
  const regularFont = `/api/books/fonts/${FONT_FILES['dejavu-sans'].regular.sha256}`;

  async function failure(p: Promise<unknown>): Promise<BrowserRenderError> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BrowserRenderError);
    return err as BrowserRenderError;
  }

  it('a font that cannot be fetched: font_fetch_failed, and the next render tries again', async () => {
    const broken = filesFetcher({ [regularFont]: () => new Response('nope', { status: 503 }) });
    const err = await failure(renderDraftPayload(broken, draft()));
    expect(err.code).toBe('font_fetch_failed');
    expect(err.details.status).toBe(503);
    const fetcher = filesFetcher();
    await expect(renderDraftPayload(fetcher, draft())).resolves.toBeTruthy();
    expect(fetcher.calls).toContain(regularFont);
  });

  it('a network failure on a font: font_fetch_failed', async () => {
    const f: Fetcher = async () => {
      throw new TypeError('Failed to fetch');
    };
    expect((await failure(renderDraftPayload(f, draft()))).code).toBe('font_fetch_failed');
  });

  it('a font that is not the pinned file: font_hash_mismatch', async () => {
    const other = readFileSync(path.join(FONT_DIR, FONT_FILES['noto-sans'].regular.file));
    const err = await failure(renderDraftPayload(filesFetcher({ [regularFont]: () => new Response(other) }), draft()));
    expect(err.code).toBe('font_hash_mismatch');
    expect(err.details.expected).toBe(FONT_FILES['dejavu-sans'].regular.sha256);
  });

  it('a listed logo that cannot be fetched: logo_fetch_failed (never drawn without it)', async () => {
    const template = preset('klassisch');
    template.regions.firstPageHeader = [{ id: 'logo', type: 'logo', style: {}, widthMm: 40, assetSha256: LOGO_SHA }];
    const payload = wire(probeInput(probe('regular'), true), template, [{ sha256: LOGO_SHA, contentType: 'image/png' }]);
    const gone = filesFetcher({ [`/api/books/assets/${LOGO_SHA}`]: () => new Response('{}', { status: 404 }) });
    const err = await failure(renderDraftPayload(gone, payload));
    expect(err.code).toBe('logo_fetch_failed');
    expect(err.details.status).toBe(404);
  });

  it('a logo whose bytes are not its hash: logo_hash_mismatch', async () => {
    const template = preset('klassisch');
    template.regions.firstPageHeader = [{ id: 'logo', type: 'logo', style: {}, widthMm: 40, assetSha256: LOGO_SHA }];
    const payload = wire(probeInput(probe('regular'), true), template, [{ sha256: LOGO_SHA, contentType: 'image/png' }]);
    const swapped = filesFetcher({ [`/api/books/assets/${LOGO_SHA}`]: () => new Response(makePng(10, 10)) });
    expect((await failure(renderDraftPayload(swapped, payload))).code).toBe('logo_hash_mismatch');
  });

  it('an input that is not a draft: invalid_input', async () => {
    const payload = draft();
    const err = await failure(renderDraftPayload(filesFetcher(), { ...payload, input: { ...payload.input, draft: false } }));
    expect(err.code).toBe('invalid_input');
  });

  it('a malformed template: invalid_input naming the path', async () => {
    const payload = draft();
    const template = structuredClone(payload.template) as unknown as { theme: { ink: string } };
    template.theme.ink = 'red';
    const err = await failure(renderDraftPayload(filesFetcher(), { ...payload, template: template as unknown as TemplateDocumentV2 }));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('theme.ink');
  });

  it.each([
    ['format', (j: Record<string, any>) => ({ ...j, format: 2 })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['fontFamily', (j: Record<string, any>) => ({ ...j, fontFamily: 'comic-sans' })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['template.theme.fontFamily', (j: Record<string, any>) => ({ ...j, fontFamily: 'noto-sans' })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['input.draft', (j: Record<string, any>) => ({ ...j, input: { ...j.input, draft: false } })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['input.document.issuedAt', (j: Record<string, any>) => ({ ...j, input: { ...j.input, document: { ...j.input.document, issuedAt: 'gestern' } } })], // eslint-disable-line @typescript-eslint/no-explicit-any
    ['logos.0.sha256', (j: Record<string, any>) => ({ ...j, logos: [{ sha256: 'x', contentType: 'image/png' }] })], // eslint-disable-line @typescript-eslint/no-explicit-any
  ])('a payload malformed at %s is refused by name', (where, mutate) => {
    const json = JSON.parse(JSON.stringify(draft()));
    let err: unknown = null;
    try {
      parseRenderInputPayload(mutate(json));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrowserRenderError);
    expect((err as BrowserRenderError).code).toBe('invalid_input');
    expect((err as BrowserRenderError).details.path).toBe(where);
  });

  it('the dates come back as dates (the PDF metadata date is the document\'s own)', () => {
    const payload = draft();
    expect(payload.input.document.issuedAt).toBeInstanceOf(Date);
    expect(payload.input.document.issuedAt!.toISOString()).toBe('2026-10-19T09:30:00.000Z');
    expect(payload.input.lines[0].createdAt).toBeInstanceOf(Date);
  });
});
