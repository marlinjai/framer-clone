// src/server/books/__tests__/mirror.test.ts
//
// The mirror projection (repository/mirror.ts) and the endpoint's guard chain
// (machine.ts) without a database. The read itself is proven against Postgres
// in books-mirror.itest.ts. All data is synthetic.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompanyKey, VerifiedKey } from '@/lib/auth-machine';
import { BooksError } from '../errors';
import { handleMirrorRequest, type MirrorEndpointDeps } from '../machine';
import { toMirrorDocument, type MirrorRow } from '../repository/mirror';

const TG = '0190a000-0000-7000-8000-0000000000aa';
const TENANT = '0190a000-0000-7000-8000-000000000001';

function row(overrides: Partial<MirrorRow> = {}): MirrorRow {
  return {
    id: 'doc-1',
    doc_type: 'invoice',
    status: 'issued',
    document_number: '64',
    issue_date: '2026-11-02',
    due_date: '2026-11-16',
    currency_code: 'EUR',
    kleinunternehmer: false,
    reverse_charge: false,
    total: 11900,
    tax_amount: 1900,
    tax_summary: [{ taxRate: 1900, taxTreatment: 'standard', net: 10000, tax: 1900 }],
    corrects_document_id: null,
    replaces_document_id: null,
    ...overrides,
  };
}

describe('toMirrorDocument', () => {
  it('maps a row to exactly the fields the receipts parser reads', () => {
    expect(toMirrorDocument(row())).toEqual({
      id: 'doc-1',
      docType: 'invoice',
      status: 'issued',
      number: '64',
      issueDate: '2026-11-02',
      dueDate: '2026-11-16',
      currencyCode: 'EUR',
      kleinunternehmer: false,
      reverseCharge: false,
      totalCents: 11900,
      taxCents: 1900,
      taxSummary: [{ rateBp: 1900, netCents: 10000, taxCents: 1900 }],
      correctsDocumentId: null,
      replacesDocumentId: null,
    });
  });

  it('keeps the links of a credit note and a replacement', () => {
    expect(toMirrorDocument(row({ doc_type: 'credit_note', corrects_document_id: 'doc-0' })).correctsDocumentId).toBe('doc-0');
    expect(toMirrorDocument(row({ replaces_document_id: 'doc-0' })).replacesDocumentId).toBe('doc-0');
  });

  it('refuses a row no issued document can be, loudly', () => {
    expect(() => toMirrorDocument(row({ document_number: null }))).toThrow(/no number or issue day/);
    expect(() => toMirrorDocument(row({ issue_date: null }))).toThrow(/no number or issue day/);
    expect(() => toMirrorDocument(row({ total: -1 }))).toThrow(/negative amount/);
  });
});

function key(overrides: Partial<VerifiedKey> = {}): VerifiedKey {
  return Object.freeze({
    kind: 'key' as const,
    tenantId: TENANT,
    companySlug: 'synthetic',
    keyId: 'key_1',
    serviceAccountId: 'sa_1',
    scope: Object.freeze({ workspaceId: 'ws_1', tenantGroupId: TG }),
    workspaceRole: 'admin' as const,
    appGrants: Object.freeze(['sites', 'books']),
    ...overrides,
  });
}

describe('handleMirrorRequest', () => {
  let list: ReturnType<typeof vi.fn>;
  let tenantDb: ReturnType<typeof vi.fn>;
  const deps = (verified: CompanyKey): MirrorEndpointDeps => ({
    verify: async () => verified,
    tenantDb: tenantDb as unknown as MirrorEndpointDeps['tenantDb'],
    list: list as unknown as MirrorEndpointDeps['list'],
  });
  const call = (query = '') => new Request(`https://app.lumitra.co/api/machine/books/documents${query}`);

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    list = vi.fn(async () => ({ documents: [toMirrorDocument(row())], nextCursor: null }));
    tenantDb = vi.fn(async () => ({}));
  });

  it('answers the documents of the key company with its id, never cached', async () => {
    const res = await handleMirrorRequest(call(), deps(key()));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toEqual({ companyId: TENANT, documents: [toMirrorDocument(row())], nextCursor: null });
    expect(tenantDb).toHaveBeenCalledWith(TG);
    const scope = list.mock.calls[0][0];
    expect(scope.tenantId).toBe(TENANT);
  });

  it('passes the paging on and refuses a malformed limit', async () => {
    await handleMirrorRequest(call('?cursor=abc&limit=50'), deps(key()));
    expect(list.mock.calls[0][1]).toEqual({ cursor: 'abc', limit: 50 });
    const bad = await handleMirrorRequest(call('?limit=ten'), deps(key()));
    expect(bad.status).toBe(400);
  });

  it('turns a key that did not verify into the machine door answers', async () => {
    expect((await handleMirrorRequest(call(), deps({ kind: 'refused' }))).status).toBe(401);
    expect((await handleMirrorRequest(call(), deps({ kind: 'unavailable' }))).status).toBe(503);
    expect((await handleMirrorRequest(call(), deps({ kind: 'throttled', retryAfterSeconds: 7 }))).status).toBe(429);
    expect(list).not.toHaveBeenCalled();
  });

  it('refuses a company without the books grant, and a key below workspace admin', async () => {
    const noGrant = await handleMirrorRequest(call(), deps(key({ appGrants: Object.freeze(['sites']) })));
    expect(noGrant.status).toBe(403);
    expect((await noGrant.json()).error.code).toBe('books_not_enabled');
    for (const role of ['member', 'viewer', null] as const) {
      const res = await handleMirrorRequest(call(), deps(key({ workspaceRole: role })));
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe('forbidden');
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('answers 404 when the company has no provisioned Books schema', async () => {
    const bad = await handleMirrorRequest(call(), deps(key({ scope: Object.freeze({ workspaceId: 'ws_1', tenantGroupId: 'not-a-group' }) })));
    expect(bad.status).toBe(404);
    tenantDb.mockRejectedValueOnce(Object.assign(new Error('tenant schema missing'), { code: 'COMMERCE_TENANT_NOT_PROVISIONED' }));
    const missing = await handleMirrorRequest(call(), deps(key()));
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('books_not_provisioned');
  });

  it('maps a Books refusal to its answer and an unexpected failure to a logged 500', async () => {
    list.mockRejectedValueOnce(new BooksError('INVALID_INPUT', 'INVALID_INPUT: cursor'));
    expect((await handleMirrorRequest(call('?cursor=x'), deps(key()))).status).toBe(400);
    list.mockRejectedValueOnce(new Error('connection reset'));
    const failed = await handleMirrorRequest(call(), deps(key()));
    expect(failed.status).toBe(500);
    expect((await failed.json()).error.code).toBe('books_failed');
    expect(console.error).toHaveBeenCalled();
  });
});
