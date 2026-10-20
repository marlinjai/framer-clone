// src/app/api/books/documents/[id]/pdf/route.ts
//
// GET /api/books/documents/<id>/pdf  -> application/pdf (attachment)
//
// The download of the document editor (Books plan phase 3). An issued invoice
// or credit note answers its stored document of record: the PDF rendered once
// from the frozen snapshots right after issue, checked for the legally required
// fields, and never changed afterwards (rendered and stored on this first
// request if that render failed). The `x-books-sha256` header carries the
// stored digest. A draft answers a preview rendered from live data, marked
// "ENTWURF" on every page and never stored (`x-books-of-record: false`).
// 422 `render_incomplete` names the missing fields when a document of record
// would lack a required field (nothing is stored then).

import { booksRoute } from '@/server/books/http/route';
import { documentPdf } from '@/server/books/render/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute<{ id: string }>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  const pdf = await documentPdf(ctx.scope, id);
  return new Response(Buffer.from(pdf.bytes), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${pdf.fileName}"`,
      'content-length': String(pdf.bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-books-of-record': pdf.ofRecord ? 'true' : 'false',
      'x-books-sha256': pdf.sha256,
    },
  });
});
