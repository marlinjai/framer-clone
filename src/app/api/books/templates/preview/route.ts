// src/app/api/books/templates/preview/route.ts
//
// POST /api/books/templates/preview
//   { document: TemplateDocumentV2, subject: { kind: 'sample', variant } | { kind: 'document', documentId } }
//   -> 200 { pdf: base64, layout: LayoutMap, renderMs, problems: TemplateProblem[] }
//
// The composer's live preview (visual template composer plan, decision 12):
// the unsaved template rendered by the real engine against a sample (a probe
// document, fictional data) or one of the company's documents, stamped
// "VORSCHAU, KEIN BELEG" on every page, never stored (`no-store`). Behind the
// Books write guard (`editBooks`, the right that edits templates); another
// company's document answers 404 like an unknown one. The document is checked
// against the template schema (400 `invalid_input` with the paths) but not
// against the save gate: an incomplete layout previews as it is, with its
// layout issues in the map, so the composer can show what is wrong.
// `problems` carries the gate's fast first step (the structural rules: required
// blocks, legal items and columns, sizes, contrast, widths), so the composer
// shows them while the user edits; the probe render runs only on save.
//
// JSON with the PDF in base64, decided by measurement (Build notes): a one-page
// preview is a few tens of kilobytes, and one answer carries the PDF and the
// layout map together. The request body is bounded (256 KB). The log line
// carries the render time and the page count only, never content.

import { z } from 'zod';

import { jsonError } from '@/lib/api/respond';
import { invalid } from '@/server/books/errors';
import { boundedText } from '@/server/books/http/boundedBody';
import { booksRoute } from '@/server/books/http/route';
import { renderPreview } from '@/server/books/render/preview';
import { fontMeasure } from '@/server/books/template/gate';
import { PROBE_NAMES } from '@/server/books/template/probes';
import { structuralProblems } from '@/server/books/template/rules';
import { templateDocumentV2Schema } from '@/server/books/template/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256 * 1024;

const bodySchema = z
  .object({
    document: templateDocumentV2Schema,
    subject: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('sample'), variant: z.enum(PROBE_NAMES) }).strict(),
      z.object({ kind: z.literal('document'), documentId: z.string().min(1).max(100) }).strict(),
    ]),
  })
  .strict();

export const POST = booksRoute('write', async (ctx, req) => {
  const text = await boundedText(req, MAX_BODY_BYTES);
  if (text === null) return jsonError('body_too_large', 'the preview request is larger than 256 KB', 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonError('bad_json', 'invalid JSON body', 400);
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw invalid('INVALID_INPUT', parsed.error.issues);

  const preview = await renderPreview(ctx.scope, parsed.data.document, parsed.data.subject);
  const problems = structuralProblems(parsed.data.document, await fontMeasure());
  console.info(`[books] template preview: ${preview.layout.pageCount} page(s), ${preview.renderMs} ms`);
  return Response.json(
    { pdf: Buffer.from(preview.pdf).toString('base64'), layout: preview.layout, renderMs: preview.renderMs, problems },
    { headers: { 'cache-control': 'no-store' } },
  );
});
