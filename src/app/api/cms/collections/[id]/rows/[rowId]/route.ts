// src/app/api/cms/collections/[id]/rows/[rowId]/route.ts
//
// GET /api/cms/collections/:id/rows/:rowId
//
// Thin READ route: returns a single row. A missing row is a 404 envelope (the
// client provider maps that back to `null`). A repository throw SURFACES as a
// 5xx envelope, never a swallowed empty 200.
//
// Host-scoped (src/server/cms/readScope.ts): on the editor host the session's
// active workspace (401 without a session, 403 without `viewSite`), on a
// published-site host the Host's site workspace (the session is never read
// there; only a published, non-archived row is returned, looked up inside the
// collection's own table), 404 on any other host. A row whose collection lives in another
// workspace answers the same 404 as a missing row (the repository refuses it).
//
// This is part of the binding/preview READ path. Row WRITES are not done over
// HTTP: the editor grid persists them through the data-table server-actions
// adapter (src/server/cms/actions.ts), so this route is GET-only.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { resolveCmsReadContext } from '@/server/cms';
import { jsonError } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGET(
  req: Request,
  { params }: { params: Promise<{ id: string; rowId: string }> },
): Promise<Response> {
  const read = await resolveCmsReadContext(req);
  if (!read.ok) {
    return read.response;
  }
  const { id, rowId } = await params;
  try {
    const row = await read.repo.getRow(id, rowId);
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

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing the permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const GET = withAuthAvailability(handleGET);
