// src/app/dev/books-engine/harnessCases.ts
//
// The cases of the browser parity harness (WYSIWYG invoice editor plan, phase
// 1, parity layer (b)), built on the server with the server's own modules:
// each case is a draft's render input as the render-input route sends it and
// the SHA-256 the server's draft path draws for it (fonts from disk, the
// server's coverage, the engine), exactly as the draft PDF route does. The
// harness page renders each one in the REAL worker bundle the bundler built
// and compares. NOT shipped: the harness files are pages and routes only when
// `BOOKS_ENGINE_HARNESS=1` (next.config.ts `pageExtensions`), never in a
// normal build.

import { createHash } from 'node:crypto';

import { RENDER_INPUT_FORMAT, type RenderInputPayload } from '@/lib/books/engine/payload';
import { previewSafe, previewSafeTemplate } from '@/server/books/render/drawable';
import { renderTemplate, type EngineImage } from '@/server/books/render/engine';
import { fontFiles } from '@/server/books/render/fonts';
import { buildRenderModel, type RenderInput } from '@/server/books/render/model';
import { PRESETS, preset } from '@/server/books/template/presets';
import { PROBE_NAMES, probe, probeInput } from '@/server/books/template/probes';
import { FONT_FAMILIES, type FontFamily, type TemplateDocumentV2 } from '@/server/books/template/schema';
import { logoCase } from '@/server/books/__tests__/testImages';

export interface HarnessCase {
  name: string;
  /** Latency cases are timed too (one page, three pages). */
  latency: '1p' | '3p' | null;
  payload: RenderInputPayload;
  sha256: string;
  pageCount: number;
}

function payloadOf(input: RenderInput, template: TemplateDocumentV2, logos: RenderInputPayload['logos'] = []): RenderInputPayload {
  return {
    format: RENDER_INPUT_FORMAT,
    documentId: input.document.id,
    documentVersion: input.document.version,
    fontFamily: template.theme.fontFamily,
    input,
    template,
    logos,
  };
}

async function serverDraft(input: RenderInput, template: TemplateDocumentV2, assets: ReadonlyMap<string, EngineImage> = new Map()) {
  const family = template.theme.fontFamily;
  const { bytes, layout } = await renderTemplate(previewSafe(buildRenderModel(input), family), previewSafeTemplate(template), fontFiles(family), { assets });
  return { sha256: createHash('sha256').update(bytes).digest('hex'), pageCount: layout.pageCount };
}

const withFamily = (doc: TemplateDocumentV2, family: FontFamily): TemplateDocumentV2 => ({ ...doc, theme: { ...doc.theme, fontFamily: family } });

/** A draft with as many lines as it takes to run to `pages` pages. */
async function draftOfPages(pages: number, template: TemplateDocumentV2): Promise<RenderInput> {
  const base = probeInput(probe('regular'), true);
  for (let n = 1; n < 400; n += 1) {
    const lines = Array.from({ length: n }, (_, i) => ({ ...base.lines[0], id: `line-${i}`, position: i + 1, title: `Leistung ${i + 1}` }));
    const input = { ...base, lines };
    if ((await serverDraft(input, template)).pageCount === pages) return input;
  }
  throw new Error(`no draft of ${pages} pages`);
}

export async function harnessCases(): Promise<HarnessCase[]> {
  const out: HarnessCase[] = [];
  const add = async (name: string, latency: HarnessCase['latency'], input: RenderInput, template: TemplateDocumentV2, assets: Map<string, EngineImage> = new Map()) => {
    const logos = [...assets.entries()].map(([sha256, a]) => ({ sha256, contentType: a.contentType }));
    out.push({ name, latency, payload: payloadOf(input, template, logos), ...(await serverDraft(input, template, assets)) });
  };
  for (const p of PRESETS) {
    for (const family of FONT_FAMILIES) {
      for (const name of PROBE_NAMES) await add(`${p}/${family}/${name}`, null, probeInput(probe(name), true), withFamily(preset(p), family));
    }
  }
  for (const family of FONT_FAMILIES) {
    for (const kind of ['png', 'jpeg'] as const) {
      const c = logoCase(family, kind);
      await add(`logo-${kind}/${family}/longInvoice`, null, probeInput(probe('longInvoice'), true), c.doc, c.assets);
    }
    const odd = probeInput(probe('regular'), true);
    odd.recipient = { ...odd.recipient!, name: 'Grüße 漢字 ✓ 🙂 Ωμέγα Жук' };
    await add(`undrawable/${family}`, null, odd, withFamily(preset('modern'), family));
    const template = withFamily(preset('klassisch'), family);
    await add(`latency-1p/${family}`, '1p', probeInput(probe('regular'), true), template);
    await add(`latency-3p/${family}`, '3p', await draftOfPages(3, template), template);
  }
  return out;
}
