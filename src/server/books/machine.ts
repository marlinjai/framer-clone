import 'server-only';

// src/server/books/machine.ts
//
// GET /api/machine/books/documents -> { companyId, documents, nextCursor: null }
//
// The read-only machine endpoint receipt-ocr-app pulls the company's issued
// invoices and credit notes from (Books plan "Connections", roadmap line "4.
// Existing invoices and the suite"). A plain JSON route behind the machine
// door (src/middleware.ts lets a bearer, and only a bearer, reach
// /api/machine/*), not an MCP tool: the caller is a scheduled job of another
// app, which wants one list call, not an agent session.
//
// THE KEY IS CHECKED HERE, on every request, in this order (first failure wins):
//
//   1. a company API key (verifyCompanyKey, src/lib/auth-machine.ts: a service
//      account scoped to ONE company, its sites workspace resolved by the
//      server)                          -> else machineAuthDenial's 401/403/429/503
//   2. `viewBooks` for that key (authorizeKeyAction): the company holds the
//      auth-brain app grant `books` and the key is a workspace admin of the
//      company's workspace              -> else 403 books_not_enabled / forbidden
//   3. the company's tenant group has a provisioned tg_<id> schema
//                                        -> else 404 books_not_provisioned
//   4. the BooksScope of THAT schema and THAT company: nothing the request
//      names chooses the company, so a key reads its own company's documents
//      and never another's.
//
// The answer carries the verified company id (so the caller knows whose
// documents it received) and ALL the company's issued documents in the
// mirror's shape (repository/mirror.ts), read in one snapshot: figures only,
// never a recipient. There are no pages (`nextCursor` is always null): a
// `limit` is accepted and ignored, because honouring it would cut the list
// without the caller knowing, and a `cursor` is refused, since none is ever
// handed out. Above MIRROR_MAX_DOCUMENTS the answer is 422 too_many_documents,
// never a cut list. Every read is one
// `[machine-audit]` line with the number of documents handed over.

import { assertTenantGroupId } from '@marlinjai/tenant-db';
import type { Kysely } from 'kysely';

import { jsonError } from '@/lib/api/respond';
import {
  auditMachineAction,
  authorizeKeyAction,
  BOOKS_APP_GRANT,
  machineAuthDenial,
  verifyCompanyKey,
  type CompanyKey,
  type VerifiedKey,
} from '@/lib/auth-machine';
import { commerceTenantDbChecked, isCommerceTenantNotProvisioned } from '@/server/commerce/db';
import type { CommerceDB } from '@/server/commerce/db-types';

import { isBooksError } from './errors';
import { booksErrorResponse } from './http/errorResponse';
import { describeError } from './http/describeError';
import { listMirrorDocuments, TooManyMirrorDocumentsError, type MirrorPage } from './repository/mirror';
import { booksScope, type BooksScope } from './scope';

export interface MirrorEndpointDeps {
  verify: (req: Request) => Promise<CompanyKey>;
  tenantDb: (tgId: string) => Promise<Kysely<CommerceDB>>;
  list: (scope: BooksScope) => Promise<MirrorPage>;
}

const defaultDeps: MirrorEndpointDeps = {
  verify: (req) => verifyCompanyKey(req),
  tenantDb: (tgId) => commerceTenantDbChecked(tgId),
  list: (scope) => listMirrorDocuments(scope),
};

/**
 * The query the endpoint accepts: no cursor (it hands none out), and `limit`
 * ignored (the merged receipts client sends `limit=200`; obeying it would cut
 * the list silently). Anything else in the query is ignored too.
 */
function refuseCursor(url: URL): Response | null {
  if (url.searchParams.has('cursor')) {
    return jsonError('invalid_input', 'this endpoint has no pages: every document is in one answer', 400);
  }
  return null;
}

/**
 * Answer one machine read of the Books: verify the key, check the `books`
 * grant and the role, open the company's schema and hand over its issued
 * documents. See the file header for the order of the checks.
 */
export async function handleMirrorRequest(req: Request, deps: MirrorEndpointDeps = defaultDeps): Promise<Response> {
  const verified = await deps.verify(req);
  if (verified.kind !== 'key') return machineAuthDenial(verified);
  const key: VerifiedKey = verified;

  if (!key.appGrants.includes(BOOKS_APP_GRANT)) {
    // authorizeKeyAction denies it too; answered here first so the caller learns WHICH grant is missing.
    auditMachineAction(key, { action: 'viewBooks', outcome: 'denied', reason: 'books_not_enabled' });
    return jsonError('books_not_enabled', 'the Books are not enabled for this company', 403);
  }
  if (!authorizeKeyAction(key, 'viewBooks')) return jsonError('forbidden', 'this key may not read the Books', 403);

  const refused = refuseCursor(new URL(req.url));
  if (refused) return refused;

  const notProvisioned = jsonError('books_not_provisioned', 'the Books are not provisioned for this company', 404);
  let tgId: string;
  try {
    tgId = assertTenantGroupId(key.scope.tenantGroupId);
  } catch {
    return notProvisioned;
  }

  try {
    let db: Kysely<CommerceDB>;
    try {
      db = await deps.tenantDb(tgId);
    } catch (err) {
      if (isCommerceTenantNotProvisioned(err)) {
        console.error(`[books-machine] company ${key.tenantId}: ${(err as Error).message}`);
        return notProvisioned;
      }
      throw err;
    }
    const page = await deps.list(booksScope(db, tgId, key.tenantId));
    auditMachineAction(key, {
      action: 'viewBooks',
      outcome: 'succeeded',
      target: { documents: String(page.documents.length), more: page.nextCursor ? 'yes' : 'no' },
    });
    return Response.json(
      { companyId: key.tenantId, documents: page.documents, nextCursor: page.nextCursor },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (err) {
    if (isBooksError(err)) return booksErrorResponse(err) as Response;
    if (err instanceof TooManyMirrorDocumentsError) {
      auditMachineAction(key, { action: 'viewBooks', outcome: 'failed', reason: 'too_many_documents' });
      console.error(`[books-machine] company ${key.tenantId} holds more than ${err.max} issued documents; refusing a cut list`);
      return jsonError('too_many_documents', `more than ${err.max} issued documents; the mirror read must be split before it can serve this company`, 422);
    }
    auditMachineAction(key, { action: 'viewBooks', outcome: 'failed', reason: 'read_failed' });
    console.error(`[books-machine] the mirror read failed: ${describeError(err)}`);
    return jsonError('books_failed', 'the read failed; retry later', 500);
  }
}
