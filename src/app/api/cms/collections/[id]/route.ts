// src/app/api/cms/collections/[id]/route.ts
//
// GET /api/cms/collections/:id
//
// Thin READ route: returns a single CMS collection. A missing collection is a
// 404 error envelope (the client provider maps that back to `null`). A
// repository throw SURFACES as a 5xx envelope, never a swallowed empty 200.

import { getCmsRepository } from '@/server/cms';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const collection = await getCmsRepository().getCollection(id);
    if (!collection) {
      return jsonError('not_found', `collection ${id} not found`, 404);
    }
    return Response.json(collection);
  } catch (err) {
    return jsonError(
      'cms_read_failed',
      err instanceof Error ? err.message : 'failed to get collection',
      500,
    );
  }
}
