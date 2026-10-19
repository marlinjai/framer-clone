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
// a published-site host only the PUBLISHED, non-archived rows of the Host's site
// workspace, at most 100 per page (the session is never read there), 404 on any
// other host. A malformed limit or cursor is a 400 bad_query. The collection is resolved in that
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
import { resolveCmsReadContext, isValidCursor, isValidLimit } from '@/server/cms';
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonError('bad_query', 'invalid query search param', 400);
    }
    // The limit and cursor reach the adapter's SQL as LIMIT / OFFSET, so they
    // are checked here and answered as a 400, never a database error.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return jsonError('bad_query', 'query must be a JSON object', 400);
    }
    const candidate = parsed as Query;
    if (candidate.limit !== undefined && !isValidLimit(candidate.limit)) {
      return jsonError('bad_query', 'query.limit must be a positive integer', 400);
    }
    if (candidate.cursor !== undefined && !isValidCursor(candidate.cursor)) {
      return jsonError('bad_query', 'query.cursor is not a valid cursor', 400);
    }
    query = candidate;
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
