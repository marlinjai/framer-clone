// src/app/api/cms/collections/[id]/columns/[colId]/route.ts
//
// PATCH  /api/cms/collections/:id/columns/:colId  (WRITE: rename and/or retype)
// DELETE /api/cms/collections/:id/columns/:colId  (WRITE: delete the field)
//
// Both are admin-guarded mutations surfacing the typed write-error contract
// (404 not_found, 400 ddl_failed). PATCH accepts an optional `name` (rename) and
// an optional `type` (retype); at least one must be present. A retype mints a
// new column id (adapter-prisma cannot change a column type in place), so PATCH
// returns the refreshed collection rather than a single column.

import { z } from 'zod';
import { getCmsRepository, getCmsWriteRepository, cmsWriteErrorResponse } from '@/server/cms';
import { requireAdmin } from '@/server/auth/guard';
import { jsonError, parseBody } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const columnType = z.enum([
  'text',
  'number',
  'boolean',
  'date',
  'select',
  'multi-select',
  'relation',
  'file',
]);

const patchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    type: columnType.optional(),
  })
  .refine((v) => v.name !== undefined || v.type !== undefined, {
    message: 'name or type is required',
  });

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; colId: string }> },
): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }
  const { id, colId } = await params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) {
    return body.response;
  }
  try {
    const repo = getCmsWriteRepository();
    if (body.data.name !== undefined) {
      await repo.renameColumn(id, colId, body.data.name);
    }
    if (body.data.type !== undefined) {
      await repo.retypeColumn(id, colId, body.data.type);
    }
    const collection = await getCmsRepository().getCollection(id);
    return Response.json(collection);
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to update column',
        500,
      )
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; colId: string }> },
): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }
  const { id, colId } = await params;
  try {
    await getCmsWriteRepository().deleteColumn(id, colId);
    return Response.json({ ok: true });
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to delete column',
        500,
      )
    );
  }
}
