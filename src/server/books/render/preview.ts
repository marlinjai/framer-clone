// src/server/books/render/preview.ts
//
// The template preview (visual template composer plan, decision 12): an
// unsaved template document rendered against a sample (one of the probe
// documents of the save gate, fictional data) or against one of the company's
// real documents (an issued one from its frozen data, a draft from live data),
// with "VORSCHAU, KEIN BELEG" on every page so a preview of an issued invoice
// in a new layout can never pass for the original. Never stored, never
// checked as a document of record: the save gate runs on save, the
// completeness check at issue. Characters the font cannot draw show as "?".
//
// The answer carries the PDF and the layout map (every block's page and
// rectangle, the table columns, the layout issues), from which the composer
// draws its outlines over the real PDF. The render time is measured here and
// logged by the route (milliseconds and page count only, never content).

import { BooksError } from '../errors';
import type { BooksScope } from '../scope';
import { PROBE_NAMES, probe, probeInput } from '../template/probes';
import type { TemplateDocumentV2 } from '../template/schema';
import { previewSafe, previewSafeTemplate } from './drawable';
import { renderTemplate, type LayoutMap } from './engine';
import { fontFiles } from './fonts';
import { buildRenderModel, type RenderInput } from './model';
import { documentRenderInput } from './store';

export type PreviewSubject = { kind: 'sample'; variant: (typeof PROBE_NAMES)[number] } | { kind: 'document'; documentId: string };

export interface Preview {
  pdf: Uint8Array;
  layout: LayoutMap;
  /** Server time of the render alone, in milliseconds (input loading excluded). */
  renderMs: number;
}

export async function renderPreview(scope: BooksScope, document: TemplateDocumentV2, subject: PreviewSubject): Promise<Preview> {
  let input: RenderInput;
  if (subject.kind === 'sample') {
    if (!PROBE_NAMES.includes(subject.variant)) {
      throw new BooksError('INVALID_INPUT', 'INVALID_INPUT: subject.variant', { issues: [{ path: 'subject.variant', message: 'unknown sample' }] });
    }
    input = probeInput(probe(subject.variant));
  } else {
    input = await documentRenderInput(scope, subject.documentId);
  }
  const started = performance.now();
  const { bytes, layout } = await renderTemplate(previewSafe(buildRenderModel(input)), previewSafeTemplate(document), fontFiles(), {
    preview: true,
  });
  return { pdf: bytes, layout, renderMs: Math.round((performance.now() - started) * 10) / 10 };
}
