import 'server-only';

// src/server/books/machine.ts
//
// GET /api/machine/books/documents[?cursor=&limit=] -> { companyId, documents, nextCursor }
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
// documents it received) and the documents in the mirror's shape
// (repository/mirror.ts): figures only, never a recipient. Every read is one
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
import { listMirrorDocuments, type MirrorPage } from './repository/mirror';
import { booksScope, type BooksScope } from './scope';

export interface MirrorEndpointDeps {
  verify: (req: Request) => Promise<CompanyKey>;
  tenantDb: (tgId: string) => Promise<Kysely<CommerceDB>>;
  list: (scope: BooksScope, input: { cursor?: string; limit?: number }) => Promise<MirrorPage>;
}

const defaultDeps: MirrorEndpointDeps = {
  verify: (req) => verifyCompanyKey(req),
  tenantDb: (tgId) => commerceTenantDbChecked(tgId),
  list: listMirrorDocuments,
};

function readPaging(url: URL): { ok: true; input: { cursor?: string; limit?: number } } | { ok: false; response: Response } {
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit === null) return { ok: true, input: { cursor } };
  if (!/^\d{1,4}$/.test(rawLimit)) {
    return { ok: false, response: jsonError('invalid_input', 'limit must be a whole number', 400) };
  }
  return { ok: true, input: { cursor, limit: Number(rawLimit) } };
}

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

  const paging = readPaging(new URL(req.url));
  if (!paging.ok) return paging.response;

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
    const page = await deps.list(booksScope(db, tgId, key.tenantId), paging.input);
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
    auditMachineAction(key, { action: 'viewBooks', outcome: 'failed', reason: 'read_failed' });
    console.error(`[books-machine] the mirror read failed: ${describeError(err)}`);
    return jsonError('books_failed', 'the read failed; retry later', 500);
  }
}
