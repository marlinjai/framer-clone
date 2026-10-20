// src/app/api/books/imports/route.ts
//
// GET  /api/books/imports -> { items: ImportItemView[], importedTotal, counter: { format, nextValue } | null, limits }
// POST /api/books/imports -> 201 { status: 'staged', item } | 200 { status: 'duplicate', item, documentId }
//
// The upload import of past invoices (docs/plans/2026-10-20-books-upload-import.md).
// GET lists every open staging row and the newest imported ones (with the
// number imported in all; discarded rows are left out). POST stages ONE PDF: the body is
// the file itself (`content-type: application/pdf`, at most 10 MB, checked by
// its magic bytes), its name in `x-file-name` (URI-encoded). One request per
// file: 50 files of 10 MB are not one request, and the edge middleware keeps a
// body only up to `middlewareClientMaxBodySize` (raised to 12 MB in
// next.config.ts for this). A body shorter than its declared length was cut
// off on the way and is refused, never staged truncated. A file already staged
// or imported answers `duplicate` and is never read again.

import { jsonError } from '@/lib/api/respond';
import { booksRoute } from '@/server/books/http/route';
import { dailyExtractLimitShown, EXTRACT_PARALLEL } from '@/server/books/upload/limits';
import { listImportItems, MAX_UPLOAD_BYTES, stageUpload } from '@/server/books/upload/service';
import { importItemView } from '@/server/books/upload/views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute('read', async (ctx) => {
  const { items, importedTotal } = await listImportItems(ctx.scope);
  const counter = await ctx.scope.db
    .selectFrom('document_number_counter')
    .select(['format', 'next_value'])
    .where('tenant_id', '=', ctx.scope.tenantId)
    .where('doc_type', '=', 'invoice')
    .executeTakeFirst();
  return Response.json({
    items: items.map(importItemView),
    importedTotal,
    counter: counter ? { format: counter.format, nextValue: Number(counter.next_value) } : null,
    limits: { maxFileBytes: MAX_UPLOAD_BYTES, maxFilesAtOnce: 50, parallel: EXTRACT_PARALLEL, perDay: dailyExtractLimitShown() },
  });
});

export const POST = booksRoute('write', async (ctx, req) => {
  const type = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/pdf') return jsonError('bad_body', 'send the PDF itself with content-type application/pdf', 415);
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return jsonError('file_too_large', `a file has at most ${MAX_UPLOAD_BYTES} bytes`, 413);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (Number.isFinite(declared) && bytes.byteLength !== declared) {
    return jsonError('upload_truncated', 'the file did not arrive whole; upload it again', 400);
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return jsonError('file_too_large', `a file has at most ${MAX_UPLOAD_BYTES} bytes`, 413);
  let fileName = 'invoice.pdf';
  try {
    fileName = decodeURIComponent(req.headers.get('x-file-name') ?? 'invoice.pdf');
  } catch {
    // A malformed name is not a reason to refuse the file.
  }
  const result = await stageUpload(ctx.scope, { fileName, bytes });
  if (result.status === 'duplicate') {
    return Response.json({ status: 'duplicate', item: result.item ? importItemView(result.item) : null, documentId: result.documentId });
  }
  console.info(`[books-import] staged item ${result.item.id} (${result.item.byteSize} bytes)`);
  return Response.json({ status: 'staged', item: importItemView(result.item) }, { status: 201 });
});
