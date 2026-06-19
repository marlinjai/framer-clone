// src/app/api/cms/collections/[id]/route.ts
//
// GET    /api/cms/collections/:id  (READ, unauthenticated)
// PATCH  /api/cms/collections/:id  (WRITE, admin-guarded: rename / set icon)
// DELETE /api/cms/collections/:id  (WRITE, admin-guarded: delete)
//
// The GET stays UNAUTHENTICATED. PATCH/DELETE are mutations, guarded by
// requireAdmin, surfacing the typed write-error contract (404 not_found, 409
// collection_exists on a rename collision). A repository throw SURFACES as an
// envelope, never a swallowed empty 200.

import { z } from 'zod';
import { getCmsRepository, getCmsWriteRepository, cmsWriteErrorResponse } from '@/server/cms';
import { requireAdmin } from '@/server/auth/guard';
import { jsonError, parseBody } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const updateSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    icon: z.string().trim().min(1).optional(),
  })
  .refine((d) => d.name !== undefined || d.icon !== undefined, {
    message: 'name or icon required',
  });

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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }
  const { id } = await params;
  const body = await parseBody(req, updateSchema);
  if (!body.ok) {
    return body.response;
  }
  try {
    await getCmsWriteRepository().updateCollection(id, {
      name: body.data.name,
      icon: body.data.icon,
    });
    const collection = await getCmsRepository().getCollection(id);
    return Response.json(collection);
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to update collection',
        500,
      )
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }
  const { id } = await params;
  try {
    await getCmsWriteRepository().deleteCollection(id);
    return Response.json({ ok: true });
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to delete collection',
        500,
      )
    );
  }
}
