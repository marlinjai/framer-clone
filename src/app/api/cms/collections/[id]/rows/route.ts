// src/app/api/cms/collections/[id]/rows/route.ts
//
// GET /api/cms/collections/:id/rows?query=<json>
//
// Thin READ route: returns a page of rows for a collection. The binding `Query`
// (filter, sort, limit, cursor) is carried as a single JSON-encoded `query`
// search param so the full shape round-trips without a bespoke per-field
// encoding. A malformed `query` param is a 400 (bad_query); a repository throw
// SURFACES as a 5xx envelope, never a swallowed empty 200.
//
// This is part of the binding/storefront/preview READ path (the data-source
// provider, collection renderers, and publish hydrator fetch it). Row WRITES are
// no longer done over HTTP: the editor grid persists them through the data-table
// server-actions adapter (src/server/cms/actions.ts), so this route is GET-only.

import { getCmsRepository } from '@/server/cms';
import type { Query } from '@/lib/bindings/dataSource/types';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
