// src/app/api/cms/collections/[id]/rows/[rowId]/route.ts
//
// GET /api/cms/collections/:id/rows/:rowId
//
// Thin READ route: returns a single row. A missing row is a 404 envelope (the
// client provider maps that back to `null`). A repository throw SURFACES as a
// 5xx envelope, never a swallowed empty 200.

import { getCmsRepository } from '@/server/cms';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
