// src/app/api/cms/collections/[id]/rows/route.ts
//
// GET /api/cms/collections/:id/rows?query=<json>
//
// Thin READ route: returns a page of rows for a collection. The binding
// `Query` (filter, sort, limit, cursor) is carried as a single JSON-encoded
// `query` search param so the full shape round-trips without a bespoke
// per-field encoding. A malformed `query` param is a 400 (bad_query); a
// repository throw SURFACES as a 5xx envelope, never a swallowed empty 200.

import { z } from 'zod';
import { getCmsRepository, getCmsWriteRepository, cmsWriteErrorResponse } from '@/server/cms';
import type { Query } from '@/lib/bindings/dataSource/types';
import { requireAdmin } from '@/server/auth/guard';
import { jsonError, parseBody } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Binding RowValue: string | number | boolean | null | string[].
const rowValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);
const createRowSchema = z.object({ values: z.record(z.string(), rowValue) });

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;

  let query: Query | undefined;
  const raw = new URL(req.url).searchParams.get('query');
  if (raw !== null) {
    try {
      query = JSON.parse(raw) as Query;
    } catch {
      return jsonError('bad_query', 'invalid query search param', 400);
    }
  }

  try {
    const page = await getCmsRepository().listRows(id, query);
    return Response.json(page);
  } catch (err) {
    return jsonError(
      'cms_read_failed',
      err instanceof Error ? err.message : 'failed to list rows',
      500,
    );
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }
  const { id } = await params;
  const body = await parseBody(req, createRowSchema);
  if (!body.ok) {
    return body.response;
  }
  try {
    const row = await getCmsWriteRepository().createRow(id, body.data.values);
    return Response.json(row, { status: 201 });
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to create row',
        500,
      )
    );
  }
}
