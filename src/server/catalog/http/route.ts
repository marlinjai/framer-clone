import 'server-only';

// src/server/catalog/http/route.ts
//
// The guard every /api/catalog/* route runs (catalogue design, slice 2), the
// catalogue's sibling of the Books guard (src/server/books/http/route.ts). In
// order, first failure wins:
//
//   0. editor host only                 -> else 404 not_found (a published
//      storefront host never authorizes anything with the apex session)
//   1. a verified auth-brain session    -> else 401 unauthorized
//      (auth-brain not answering: 503 auth_unavailable)
//   2. the editor's ACTIVE company      -> else 403 sites_not_enabled /
//      no_active_company. resolveActiveScope only resolves companies that hold
//      the auth-brain app grant `sites`, which is the catalogue's grant too
//      (design: "behind the existing `sites` grant, no new grant"), so there is
//      no separate grant check.
//   3. the user holds `viewSite` (reads) or `editSite` (writes) on the
//      company's editor workspace        -> else 403 forbidden
//      (OpenFGA not answering: 503 authz_unavailable, never a 403)
//   4. the company's tenant group has a provisioned tg_<id> schema
//                                        -> else 404 catalog_not_provisioned
//   5. the CatalogScope: that schema's handle plus the company id. Every
//      repository query filters on the company, so another company's product
//      answers 404, never 403.
//
// Nothing here trusts the client for the company, the workspace or the tenant
// group. Handles open lazily inside the request, so importing a route needs no
// database (the build runs with every database URL unset).

import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import { assertTenantGroupId } from '@marlinjai/tenant-db';

import { jsonError } from '@/lib/api/respond';
import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { isEditorHost } from '@/lib/editorHost';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import { boundedText } from '@/server/books/http/boundedBody';
import { describeError } from '@/server/books/http/describeError';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites/scope';
import type { TenantScope } from '@/server/sites/repository';

import { catalogScope, type CatalogScope } from '../scope';
import { catalogErrorResponse } from './errorResponse';

export type CatalogAccess = 'read' | 'write';

/** What a catalogue route handler receives once the guard passed. */
export interface CatalogRequestContext {
  scope: CatalogScope;
  userId: string;
  companyId: string;
  /** The company's editor workspace (its sites live there). */
  workspace: TenantScope;
  session: SessionVerifyResponse;
}

export type CatalogGuardResult = { ok: true; ctx: CatalogRequestContext } | { ok: false; response: Response };

/** Run the guard chain of the file header for one request. Both auth outages propagate (the wrapper answers 503). */
export async function resolveCatalogRequest(req: Request, access: CatalogAccess): Promise<CatalogGuardResult> {
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }
  const session = await getVerifiedSession(req);
  if (!session) return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };

  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return { ok: false, response: jsonError(denial.code, denial.message, 403) };
  }
  const { scope: workspace, companyId } = scopeResult;

  const allowed = await checkWorkspaceAccess(session.user.id, workspace.workspaceId, access === 'write' ? 'editSite' : 'viewSite');
  if (!allowed) return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };

  const notProvisioned = {
    ok: false as const,
    response: jsonError('catalog_not_provisioned', 'the catalogue is not set up for this company yet', 404),
  };
  let tgId: string;
  try {
    tgId = assertTenantGroupId(workspace.tenantGroupId);
  } catch {
    return notProvisioned;
  }
  let db;
  try {
    db = await commerceTenantDbChecked(tgId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) {
      console.error(`[catalog] company ${companyId}: ${(err as Error).message}`);
      return notProvisioned;
    }
    throw err;
  }
  let scope: CatalogScope;
  try {
    scope = catalogScope(db, tgId, companyId);
  } catch {
    // A company id that is not a lowercase uuid cannot own catalogue rows.
    return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };
  }
  return { ok: true, ctx: { scope, userId: session.user.id, companyId, workspace, session } };
}

function internalError(err: unknown): Response {
  console.error(`[catalog] request failed: ${describeError(err)}`);
  return jsonError('catalog_failed', 'the request failed; nothing was changed by a failed write', 500);
}

/** Wrap a catalogue route handler: the guard, then the handler, CatalogError mapped, auth outages as 503, anything else a logged 500. */
export function catalogRoute<P = unknown>(
  access: CatalogAccess,
  handler: (ctx: CatalogRequestContext, req: Request, route: { params: Promise<P> }) => Promise<Response>,
): (req: Request, route: { params: Promise<P> }) => Promise<Response> {
  return withAuthAvailability(async (req: Request, route: { params: Promise<P> }) => {
    const guard = await resolveCatalogRequest(req, access);
    if (!guard.ok) return guard.response;
    try {
      return await handler(guard.ctx, req, route);
    } catch (err) {
      return catalogErrorResponse(err) ?? internalError(err);
    }
  });
}

/** The largest JSON body a catalogue route reads (a formatted description is the biggest). */
export const MAX_JSON_BYTES = 256 * 1024;

/** A plain JSON object body, or a 400 (bad_json, bad_body) or 413. */
export async function readObject(req: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const text = await boundedText(req, MAX_JSON_BYTES);
  if (text === null) return { ok: false, response: jsonError('body_too_large', 'the request body is too large', 413) };
  let parsed: unknown;
  try {
    parsed = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return { ok: false, response: jsonError('bad_json', 'invalid JSON body', 400) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: jsonError('bad_body', 'expected a JSON object', 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}
