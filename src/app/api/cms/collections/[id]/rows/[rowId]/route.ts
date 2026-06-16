// src/app/api/cms/collections/[id]/rows/[rowId]/route.ts
//
// GET /api/cms/collections/:id/rows/:rowId
//
// Thin READ route: returns a single row. A missing row is a 404 envelope (the
// client provider maps that back to `null`). A repository throw SURFACES as a
// 5xx envelope, never a swallowed empty 200.

import { z } from 'zod';
import { getCmsRepository, getCmsWriteRepository, cmsWriteErrorResponse } from '@/server/cms';
import { requireAdmin } from '@/server/auth/guard';
import { jsonError, parseBody } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const rowValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);
const updateRowSchema = z.object({ values: z.record(z.string(), rowValue) });

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> },
): Promise<Response> {
  const { id, rowId } = await params;
  try {
    const row = await getCmsRepository().getRow(id, rowId);
    if (!row) {
      return jsonError('not_found', `row ${rowId} not found`, 404);
    }
    return Response.json(row);
  } catch (err) {
    return jsonError(
      'cms_read_failed',
      err instanceof Error ? err.message : 'failed to get row',
      500,
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> },
): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }
  const { id, rowId } = await params;
  const body = await parseBody(req, updateRowSchema);
  if (!body.ok) {
    return body.response;
  }
  try {
    const row = await getCmsWriteRepository().updateRow(id, rowId, body.data.values);
    return Response.json(row);
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to update row',
        500,
      )
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> },
): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }
  const { id, rowId } = await params;
  try {
    await getCmsWriteRepository().deleteRow(id, rowId);
    return Response.json({ ok: true });
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to delete row',
        500,
      )
    );
  }
}
