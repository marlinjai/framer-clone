// src/app/api/cms/collections/route.ts
//
// GET  /api/cms/collections  (READ, host-scoped: see src/server/cms/readScope.ts)
// POST /api/cms/collections  (WRITE, auth-brain-guarded: create a collection)
//
// The GET lists the collections of ONE workspace, decided by
// resolveCmsReadContext: on the editor host the session's active workspace
// (401 without a session, 403 without `viewSite`), on a published-site host the
// workspace of the site the Host resolves to (the session is never read there),
// and 404 on any other host. The POST is a
// mutation, guarded by the real auth-brain path (the same shape as
// /api/projects/publish): getVerifiedSession -> resolveActiveScope ->
// authenticateRequest, then the collection is created in the SESSION's active
// workspace (never a constant). It surfaces the typed write-error contract: a
// duplicate name is a 409 `collection_exists` envelope, never a swallowed
// success. Runs on the Node runtime because the repository reaches Postgres
// through adapter-prisma.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { z } from 'zod';
import { getCmsWriteRepository, cmsWriteErrorResponse, resolveCmsReadContext } from '@/server/cms';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites';
import { jsonError, parseBody } from '@/lib/api/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({ name: z.string().trim().min(1) });

async function handleGET(req: Request): Promise<Response> {
  const read = await resolveCmsReadContext(req);
  if (!read.ok) {
    return read.response;
  }
  try {
    const collections = await read.repo.listCollections();
    return Response.json(collections);
  } catch (err) {
    return jsonError(
      'cms_read_failed',
      err instanceof Error ? err.message : 'failed to list collections',
      500,
    );
  }
}

async function handlePOST(req: Request): Promise<Response> {
  const session = await getVerifiedSession(req);
  if (!session) {
    return jsonError('unauthorized', 'authentication required', 401);
  }
  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return jsonError(denial.code, denial.message, 403);
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

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const GET = withAuthAvailability(handleGET);
export const POST = withAuthAvailability(handlePOST);
