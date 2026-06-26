// src/app/api/cms/collections/route.ts
//
// GET  /api/cms/collections  (READ, unauthenticated)
// POST /api/cms/collections  (WRITE, auth-brain-guarded: create a collection)
//
// The GET stays UNAUTHENTICATED for v1 (reads are public). The POST is a
// mutation, guarded by the real auth-brain path (the same shape as
// /api/projects/publish): getVerifiedSession -> resolveActiveScope ->
// authenticateRequest, then the collection is created in the SESSION's active
// workspace (never a constant). It surfaces the typed write-error contract: a
// duplicate name is a 409 `collection_exists` envelope, never a swallowed
// success. Runs on the Node runtime because the repository reaches Postgres
// through adapter-prisma.

import { z } from 'zod';
import { getCmsRepository, getCmsWriteRepository, cmsWriteErrorResponse } from '@/server/cms';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { resolveActiveScope } from '@/server/sites';
import { jsonError, parseBody } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({ name: z.string().trim().min(1) });

export async function GET(): Promise<Response> {
  try {
    const collections = await getCmsRepository().listCollections();
    return Response.json(collections);
  } catch (err) {
    return jsonError(
      'cms_read_failed',
      err instanceof Error ? err.message : 'failed to list collections',
      500,
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  const session = await getVerifiedSession(req);
  if (!session) {
    return jsonError('unauthorized', 'authentication required', 401);
  }
  const scopeResult = resolveActiveScope(session);
  if (!scopeResult.ok) {
    return jsonError('no_active_workspace', 'no active workspace', 403);
  }
  const { scope } = scopeResult;
  const auth = await authenticateRequest(req, scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return jsonError(
      auth.status === 401 ? 'unauthorized' : 'forbidden',
      auth.error,
      auth.status,
    );
  }

  const body = await parseBody(req, createSchema);
  if (!body.ok) {
    return body.response;
  }

  try {
    const collection = await getCmsWriteRepository(scope.workspaceId).createCollection(
      body.data.name,
    );
    return Response.json(collection, { status: 201 });
  } catch (err) {
    return (
      cmsWriteErrorResponse(err) ??
      jsonError(
        'cms_write_failed',
        err instanceof Error ? err.message : 'failed to create collection',
        500,
      )
    );
  }
}
