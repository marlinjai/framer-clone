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
// Host-scoped (src/server/cms/readScope.ts): on the editor host the rows of the
// session's active workspace (401 without a session, 403 without `viewSite`), on
// a published-site host the rows of the Host's site workspace (the session is
// never read there), 404 on any other host. The collection is resolved in that
// workspace FIRST: a collection of another workspace answers the same 404 as a
// missing one (the repository alone would answer an empty 200 page, which would
// still confirm nothing but reads as success).
//
// This is part of the binding/preview READ path (the editor's data-source
// provider and collection renderers fetch it; the published storefront hydrates
// on the server through the repository instead). Row WRITES are not done over
// HTTP: the editor grid persists them through the data-table server-actions
// adapter (src/server/cms/actions.ts), so this route is GET-only.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { resolveCmsReadContext } from '@/server/cms';
import type { Query } from '@/lib/bindings/dataSource/types';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const read = await resolveCmsReadContext(req);
  if (!read.ok) {
    return read.response;
  }
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
    const collection = await read.repo.getCollection(id);
    if (!collection) {
      return jsonError('not_found', `collection ${id} not found`, 404);
    }
    const page = await read.repo.listRows(id, query);
    return Response.json(page);
  } catch (err) {
    return jsonError(
      'cms_read_failed',
      err instanceof Error ? err.message : 'failed to list rows',
      500,
    );
  }
}

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing the permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const GET = withAuthAvailability(handleGET);
