import 'server-only';

// src/server/books/http/route.ts
//
// The guard every /api/books/* route runs (Books plan phase 2), the Books
// sibling of the editor API's guard chain. In order, first failure wins:
//
//   0. editor host only                 -> else 404 not_found. /api/books is an
//      editor-plane surface: on a published storefront host the apex session
//      the browser still sends must never authorize anything (D2). The edge
//      middleware refuses it there too; this is the defense in depth.
//   1. a verified auth-brain session    -> else 401 unauthorized
//      (auth-brain not answering: 503 auth_unavailable, via withAuthAvailability)
//   2. the editor's ACTIVE company      -> else 403 sites_not_enabled /
//      no_active_company (resolveActiveScope, exactly as every editor route:
//      the `framer_company` cookie selects, never grants)
//   3. that company holds the auth-brain app grant `books`
//                                        -> else 403 books_not_enabled
//   4. the user holds `viewBooks` (reads) or `editBooks` (writes) on the
//      company's editor workspace        -> else 403 forbidden
//      (OpenFGA not answering: 503 authz_unavailable, never a 403)
//   5. the company's tenant group is a valid id with a provisioned tg_<id>
//      schema                            -> else 404 books_not_provisioned
//   6. the BooksScope: the scoped handle of THAT schema plus the company id.
//      Every repository query then filters on the company, so a document of
//      another company in the same schema answers 404, never 403.
//
// Nothing here trusts the client for the company, the workspace or the tenant
// group: all of it comes from the server-verified session. Handles are opened
// lazily inside the request, so importing a route needs no database (the build
// runs with every database URL unset).

import type { SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import { assertTenantGroupId } from '@marlinjai/tenant-db';

import { jsonError } from '@/lib/api/respond';
import { getVerifiedSession } from '@/lib/auth-api';
import { checkWorkspaceAccess } from '@/lib/auth-check';
import { readCompanySelectors } from '@/lib/activeCompanyCookie';
import { withAuthAvailability } from '@/lib/authBrainAvailability';
import { isEditorHost } from '@/lib/editorHost';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import { activeScopeDenial, resolveActiveScope } from '@/server/sites/scope';

import { companyHasBooksGrant } from '../access';
import type { ContactBook } from '../contactBook';
import { describeError } from './describeError';
import { booksDependencies } from './dependencies';
import { booksErrorResponse } from './errorResponse';
import { booksScope, type BooksScope } from '../scope';

/** Reads need `viewBooks`, writes `editBooks`. */
export type BooksAccess = 'read' | 'write';

/** What a Books route handler receives once the guard passed. */
export interface BooksRequestContext {
  scope: BooksScope;
  /** The auth-brain user id (the actor on every event). */
  userId: string;
  /** The active company (auth-brain tenant id). */
  companyId: string;
  /** The verified session (for labels only, never for authorization). */
  session: SessionVerifyResponse;
  /** The editor's view of the shared contacts database. */
  contactBook: ContactBook;
}

export type BooksGuardResult =
  | { ok: true; ctx: BooksRequestContext }
  | { ok: false; response: Response };

/**
 * Run the guard chain of the file header for one request. AuthUnavailableError
 * and AuthzUnavailableError propagate (the route wrapper turns them into the
 * JSON 503s); every other refusal is a ready response.
 */
export async function resolveBooksRequest(req: Request, access: BooksAccess): Promise<BooksGuardResult> {
  if (!isEditorHost(req.headers.get('host'))) {
    return { ok: false, response: jsonError('not_found', 'not found', 404) };
  }

  const session = await getVerifiedSession(req);
  if (!session) {
    return { ok: false, response: jsonError('unauthorized', 'authentication required', 401) };
  }

  const scopeResult = resolveActiveScope(session, readCompanySelectors(req));
  if (!scopeResult.ok) {
    const denial = activeScopeDenial(scopeResult.error);
    return { ok: false, response: jsonError(denial.code, denial.message, 403) };
  }
  const { scope: workspaceScope, companyId } = scopeResult;

  if (!companyHasBooksGrant(session, companyId)) {
    return {
      ok: false,
      response: jsonError('books_not_enabled', 'the Books are not enabled for this company', 403),
    };
  }

  const allowed = await checkWorkspaceAccess(
    session.user.id,
    workspaceScope.workspaceId,
    access === 'write' ? 'editBooks' : 'viewBooks',
  );
  if (!allowed) return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };

  const notProvisioned = {
    ok: false as const,
    response: jsonError('books_not_provisioned', 'the Books are not provisioned for this company', 404),
  };
  let tgId: string;
  try {
    tgId = assertTenantGroupId(workspaceScope.tenantGroupId);
  } catch {
    return notProvisioned;
  }

  let db;
  try {
    db = await commerceTenantDbChecked(tgId);
  } catch (err) {
    if (isCommerceTenantNotProvisioned(err)) {
      console.error(`[books] company ${companyId}: ${(err as Error).message}`);
      return notProvisioned;
    }
    throw err;
  }

  const deps = booksDependencies();
  let scope: BooksScope;
  try {
    scope = booksScope(db, tgId, companyId, { recipients: deps.recipients });
  } catch {
    // A company id that is not a lowercase uuid cannot own Books rows.
    return { ok: false, response: jsonError('forbidden', 'Forbidden', 403) };
  }
  return {
    ok: true,
    ctx: { scope, userId: session.user.id, companyId, session, contactBook: deps.contactBook },
  };
}

export { describeError };

/** The 500 every Books route answers for an unexpected error (logged without its message, never swallowed). */
function internalError(err: unknown): Response {
  console.error(`[books] request failed: ${describeError(err)}`);
  return jsonError('books_failed', 'the request failed; nothing was changed by a failed write', 500);
}

/**
 * Wrap a Books route handler: the guard chain, then the handler, with
 * BooksError mapped to its HTTP answer, both auth outages as JSON 503s, and
 * any other error as a logged 500.
 */
export function booksRoute<P = unknown>(
  access: BooksAccess,
  handler: (ctx: BooksRequestContext, req: Request, route: { params: Promise<P> }) => Promise<Response>,
): (req: Request, route: { params: Promise<P> }) => Promise<Response> {
  return withAuthAvailability(async (req: Request, route: { params: Promise<P> }) => {
    const guard = await resolveBooksRequest(req, access);
    if (!guard.ok) return guard.response;
    try {
      return await handler(guard.ctx, req, route);
    } catch (err) {
      return booksErrorResponse(err) ?? internalError(err);
    }
  });
}

/** Read a JSON body; null when absent or unparseable (the caller answers 400). */
export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
  try {
    const text = await req.text();
    return { ok: true, body: text.trim() === '' ? {} : JSON.parse(text) };
  } catch {
    return { ok: false, response: jsonError('bad_json', 'invalid JSON body', 400) };
  }
}

/** A plain object body, or a 400. */
export async function readObject(
  req: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const parsed = await readJson(req);
  if (!parsed.ok) return parsed;
  const b = parsed.body;
  if (typeof b !== 'object' || b === null || Array.isArray(b)) {
    return { ok: false, response: jsonError('bad_body', 'expected a JSON object', 400) };
  }
  return { ok: true, body: b as Record<string, unknown> };
}
