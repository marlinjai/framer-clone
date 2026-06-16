// src/app/api/cms/collections/[id]/columns/route.ts
//
// POST /api/cms/collections/:id/columns  (WRITE, admin-guarded: add a field)
//
// Adds a custom field (column) to a collection. Guarded by requireAdmin and
// surfacing the typed write-error contract (404 not_found if the collection is
// gone, 400 ddl_failed if the DDL cannot be applied). The field `type` is the
// binding-layer ColumnType union; the repository maps it onto adapter-prisma.

import { z } from 'zod';
import { getCmsWriteRepository, cmsWriteErrorResponse } from '@/server/cms';
import { requireAdmin } from '@/server/auth/guard';
import { jsonError, parseBody } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The eight binding-layer column types (src/lib/bindings/dataSource/types.ts).
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

const addSchema = z.object({
  name: z.string().trim().min(1),
  type: columnType,
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = requireAdmin(req);
  if (!auth.ok) {
    return auth.response;
  }
  const { id } = await params;
  const body = await parseBody(req, addSchema);
  if (!body.ok) {
    return body.response;
  }
  try {
    const column = await getCmsWriteRepository().addColumn(id, {
      name: body.data.name,
      type: body.data.type,
    });
    return Response.json(column, { status: 201 });
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to add column',
        500,
      )
    );
  }
}
