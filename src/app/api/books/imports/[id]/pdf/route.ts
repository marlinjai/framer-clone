// src/app/api/books/imports/[id]/pdf/route.ts
//
// GET /api/books/imports/<id>/pdf -> application/pdf (inline)
//
// The uploaded PDF of a staged row, shown beside the review form; once the row
// is imported, the stored original of its document (the same bytes).

import { booksRoute } from '@/server/books/http/route';
import { itemPdf } from '@/server/books/upload/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = booksRoute<{ id: string }>('read', async (ctx, _req, { params }) => {
  const { id } = await params;
  const pdf = await itemPdf(ctx.scope, id);
  return new Response(Buffer.from(pdf.bytes), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(pdf.fileName)}`,
      'content-length': String(pdf.bytes.byteLength),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
