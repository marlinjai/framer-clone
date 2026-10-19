// src/app/api/cms/collections/[id]/route.ts
//
// GET    /api/cms/collections/:id  (READ, host-scoped: see src/server/cms/readScope.ts)
// PATCH  /api/cms/collections/:id  (WRITE, auth-brain-guarded: rename / set icon)
// DELETE /api/cms/collections/:id  (WRITE, auth-brain-guarded: delete)
//
// The GET reads ONE workspace, decided by resolveCmsReadContext (editor host:
// the session's active workspace; published-site host: the Host's site; any
// other host: 404). A collection of another workspace answers the same 404 as a
// missing one, so existence never leaks across the boundary. PATCH/DELETE are mutations, guarded by the real
// auth-brain path (getVerifiedSession -> resolveActiveScope ->
// authenticateRequest) and scoped to the request's active workspace, surfacing
// the typed write-error contract (404 not_found, 409 collection_exists on a
// rename collision). A repository throw SURFACES as an envelope, never a
// swallowed empty 200.

import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { z } from 'zod';
import {
  getCmsRepository,
  getCmsWriteRepository,
  cmsWriteErrorResponse,
  resolveCmsReadContext,
} from '@/server/cms';
import { getVerifiedSession, authenticateRequest } from '@/lib/auth-api';
import { activeScopeDenial, resolveActiveScope, type TenantScope } from '@/server/sites';
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

// The shared auth-brain write guard for PATCH/DELETE: the same flow as
// /api/projects/publish (verified session -> active scope -> action permission),
// returning the resolved scope or the Track-0 error envelope to short-circuit.
async function guardWrite(
  req: Request,
): Promise<{ ok: true; scope: TenantScope } | { ok: false; response: Response }> {
  const session = await getVerifiedSession(req);
  if (!session) {
    return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };
  }
  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return { ok: false, response: jsonError(denial.code, denial.message, 403) };
  }
  const { scope } = scopeResult;
  const auth = await authenticateRequest(req, scope.workspaceId, 'editSite');
  if (!auth.authenticated) {
    return {
      ok: false,
      response: jsonError(
        auth.status === 401 ? 'unauthorized' : 'forbidden',
        auth.error,
        auth.status,
      ),
    };
  }
  return { ok: true, scope };
}

async function handleGET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const read = await resolveCmsReadContext(req);
  if (!read.ok) {
    return read.response;
  }
  const { id } = await params;
  try {
    const collection = await read.repo.getCollection(id);
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

async function handlePATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardWrite(req);
  if (!guard.ok) {
    return guard.response;
  }
  const { scope } = guard;
  const { id } = await params;
  const body = await parseBody(req, updateSchema);
  if (!body.ok) {
    return body.response;
  }
  try {
    await getCmsWriteRepository(scope.workspaceId).updateCollection(id, {
      name: body.data.name,
      icon: body.data.icon,
    });
    const collection = await getCmsRepository(scope.workspaceId).getCollection(id);
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

async function handleDELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = await guardWrite(req);
  if (!guard.ok) {
    return guard.response;
  }
  const { scope } = guard;
  const { id } = await params;
  try {
    await getCmsWriteRepository(scope.workspaceId).deleteCollection(id);
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

// An auth-brain outage during session verify answers JSON 503 `auth_unavailable`,
// and OpenFGA failing a permission check answers JSON 503 `authz_unavailable`
// (src/lib/authBrainAvailability.ts), never a 500 and never "signed out".
export const GET = withAuthAvailability(handleGET);
export const PATCH = withAuthAvailability(handlePATCH);
export const DELETE = withAuthAvailability(handleDELETE);
