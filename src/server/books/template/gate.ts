// src/server/books/template/gate.ts
//
// The save gate (visual template composer plan, decision 8): a template
// version is written only when
//
//   1. the structural check passes (rules.ts: required blocks, regions, legal
//      items and columns, sizes, contrast, widths),
//   2. every text the template prints itself can be drawn in its font, and
//   3. the probe render passes: the template is rendered by the real engine
//      against each probe document (probes.ts) and the real completeness
//      check (render/completeness.ts, unchanged) finds every required field,
//      and the layout has no issue (nothing too tall for a page, a header
//      pushing into the address field, a footer leaving no room).
//
// The probe render runs only on save, never on preview. The check at issue
// (render/store.ts) still runs on every real document: the probes prove the
// template, the issue check proves each document.

import { PDFDocument } from 'pdf-lib';

import { BooksError } from '../errors';
import { missingFields } from '../render/completeness';
import { renderTemplate } from '../render/engine';
import type { Measure } from '../render/engine/style';
import { extractPdfText } from '../render/extractText';
import { fontFiles, fontkit, undrawable } from '../render/fonts';
import { buildRenderModel } from '../render/model';
import { allProbes, probeInput } from './probes';
import { structuralProblems, templateTexts, type TemplateProblem } from './rules';
import type { TemplateDocumentV2 } from './schema';

let measurer: Promise<Measure> | undefined;

/** Text widths in the embedded faces (the widths the engine draws with), built once per process. */
export function fontMeasure(): Promise<Measure> {
  measurer ??= (async () => {
    const pdf = await PDFDocument.create({ updateMetadata: false });
    pdf.registerFontkit(fontkit);
    const files = fontFiles();
    const regular = await pdf.embedFont(files.regular, { subset: true });
    const bold = await pdf.embedFont(files.bold, { subset: true });
    return (text: string, size: number, isBold: boolean) => (isBold ? bold : regular).widthOfTextAtSize(text, size);
  })();
  return measurer;
}

export interface GateOptions {
  /** The engine (a test seam: a broken renderer proves the probe check names what is missing). */
  render?: typeof renderTemplate;
}

/** Every reason the template cannot be saved (empty when it can). */
export async function templateProblems(doc: TemplateDocumentV2, options: GateOptions = {}): Promise<TemplateProblem[]> {
  const render = options.render ?? renderTemplate;
  const structural = structuralProblems(doc, await fontMeasure());
  const drawable: TemplateProblem[] = templateTexts(doc).flatMap((t) => {
    const chars = undrawable(t.text);
    return chars.length === 0
      ? []
      : [{ code: 'UNDRAWABLE_TEXT' as const, message: `the ${t.field} holds characters the document font cannot print: ${chars.join(' ')}`, blockId: t.blockId, field: t.field }];
  });
  // A structurally broken template would only repeat its problems as missing fields.
  if (structural.length > 0 || drawable.length > 0) return [...structural, ...drawable];

  const out: TemplateProblem[] = [];
  for (const p of allProbes()) {
    const { bytes, layout } = await render(buildRenderModel(probeInput(p)), doc, fontFiles());
    for (const issue of layout.issues) {
      out.push({
        code: 'LAYOUT_PROBLEM',
        message: `the layout does not fit the page (${issue.code.toLowerCase()})`,
        blockId: issue.blockId ?? undefined,
        region: issue.region,
        field: issue.code,
        probe: p.name,
      });
    }
    for (const field of missingFields(p.document, p.lines, await extractPdfText(bytes), p.context)) {
      out.push({ code: 'PROBE_INCOMPLETE', message: `a ${p.name} document would lack ${field}`, field, probe: p.name });
    }
  }
  // One layout problem per block and kind is enough (every probe tends to repeat it).
  const seen = new Set<string>();
  return out.filter((pr) => {
    const key = pr.code === 'LAYOUT_PROBLEM' ? `${pr.field}|${pr.blockId}|${pr.region}` : `${pr.probe}|${pr.field}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Refuse a template that may not be saved (TEMPLATE_INVALID with the problems). */
export async function assertTemplateSavable(doc: TemplateDocumentV2): Promise<void> {
  const problems = await templateProblems(doc);
  if (problems.length > 0) {
    throw new BooksError('TEMPLATE_INVALID', 'the template cannot be saved', { problems });
  }
}
