// src/server/books/__tests__/books-init-company.itest.ts
//
// `pnpm books:init-company` end to end (Books plan P1.8): the real argument
// parsing, a real HTTP request to a local stub of auth-brain's admin machine
// API, a temporary sender file, and initBooksCompany against a provisioned
// tenant schema as commerce_app. Then the company issues its first invoice to
// prove the counter starts where it was configured. Synthetic data only; the
// stub checks the bearer key it was given, which is an invented test value.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { runBooksInitCompany, type Env } from '../initCompanyCli';
import { createDraft } from '../repository/documents';
import { addLine } from '../repository/lines';
import { issue } from '../issue';
import { readSettings } from '../settings';
import {
  ACTOR,
  FakeDirectory,
  newCustomer,
  newTenantId,
  openBooksEnv,
  scopeFor,
  type BooksEnv,
} from './booksFixtures';

const STUB_KEY = 'test-admin-key';

let env: BooksEnv;
let server: Server;
let stubUrl: string;
let workDir: string;
const requests: Array<{ path: string; authorized: boolean }> = [];
/** What the stub answers: tenants per group (keyed by group id). */
const stubTenants = new Map<string, Array<Record<string, unknown>>>();

beforeAll(async () => {
  env = await openBooksEnv('books-init');
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const authorized = req.headers.authorization === `Bearer ${STUB_KEY}`;
    requests.push({ path: url.pathname, authorized });
    if (!authorized) {
      res.writeHead(401).end();
      return;
    }
    if (url.pathname !== '/api/admin/machine/tenants') {
      res.writeHead(404).end();
      return;
    }
    const items = stubTenants.get(url.searchParams.get('group_id') ?? '') ?? [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items, next_cursor: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  workDir = mkdtempSync(join(tmpdir(), 'books-init-'));
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  await env?.close();
});

function cliEnv(overrides: Env = {}): Env {
  return {
    COMMERCE_APP_DATABASE_URL: process.env.COMMERCE_APP_DATABASE_URL,
    AUTH_BRAIN_URL: stubUrl,
    AUTH_BRAIN_ADMIN_API_KEY: STUB_KEY,
    ...overrides,
  };
}

const STUB_ADDRESS = { street: 'Musterstrasse 1', city: 'Berlin', postal_code: '10115', country: 'DE' };

/** A company registered in the stub, and a local sender file with the fields auth-brain does not hold. */
function company(
  opts: { billingAddress?: Record<string, string> | null; file?: Record<string, unknown> } = {},
) {
  const tenantId = newTenantId();
  stubTenants.set(env.tgId, [
    ...(stubTenants.get(env.tgId) ?? []),
    {
      id: tenantId,
      legal_name: 'Example Studio',
      vat_id: null,
      billing_address: opts.billingAddress === undefined ? STUB_ADDRESS : opts.billingAddress,
    },
  ]);
  const senderFile = join(workDir, `${tenantId}.json`);
  writeFileSync(
    senderFile,
    JSON.stringify(opts.file ?? { taxNumber: '12/345/67890', bankName: 'Example Bank', legalName: 'Old Name From File' }),
  );
  return { tenantId, senderFile };
}

function argv(tenantId: string, senderFile: string, counters: string[], extra: string[] = ['--tax-status', 'small_business']) {
  return [
    '--tenant-group', env.tgId,
    '--tenant', tenantId,
    '--sender', senderFile,
    ...extra,
    ...counters.flatMap((c) => ['--counter', c]),
  ];
}

const COUNTERS = ['invoice={n}:62', 'credit_note=GS-{n}:1', 'offer=ANG-{n}:1'];

describe('books:init-company end to end', () => {
  it('the first run creates settings and counters from auth-brain plus the sender file, and the first invoice is 62', async () => {
    const { tenantId, senderFile } = company();
    const lines: string[] = [];
    const result = await runBooksInitCompany(argv(tenantId, senderFile, COUNTERS), cliEnv(), (l) => lines.push(l));

    expect(requests.at(-1)).toEqual({ path: '/api/admin/machine/tenants', authorized: true });
    expect(result.counters).toEqual([
      { docType: 'invoice', format: '{n}', nextValue: 62, created: true },
      { docType: 'credit_note', format: 'GS-{n}', nextValue: 1, created: true },
      { docType: 'offer', format: 'ANG-{n}', nextValue: 1, created: true },
    ]);
    // auth-brain wins for the fields it holds; the file fills the rest.
    expect(result.settings.senderBlock).toMatchObject({
      legalName: 'Example Studio',
      addressLine1: 'Musterstrasse 1',
      postalCode: '10115',
      city: 'Berlin',
      countryCode: 'DE',
      taxNumber: '12/345/67890',
      bankName: 'Example Bank',
    });
    expect(result.settings.taxStatus).toBe('small_business');
    expect(lines).toContain('note: legalName comes from auth-brain; the file\'s value is ignored');
    // The log names fields and counters, never values.
    expect(lines.join('\n')).not.toContain('Musterstrasse');

    const dir = new FakeDirectory();
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const { customer } = await newCustomer(scope, dir);
    const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id });
    await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
    const issued = await issue(scope, draft.document.id, { actorUserId: ACTOR });
    expect(issued.document.document.documentNumber).toBe('62');
    expect(issued.document.document.senderSnapshot).toMatchObject({ legalName: 'Example Studio', taxNumber: '12/345/67890' });
  });

  it('a re-run is a no-op, also after the counter moved on', async () => {
    const { tenantId, senderFile } = company();
    await runBooksInitCompany(argv(tenantId, senderFile, COUNTERS), cliEnv(), () => {});
    const scope = scopeFor(env.appDb, env.tgId, tenantId, new FakeDirectory());
    const before = await readSettings(env.appDb, scope);

    const again = await runBooksInitCompany(argv(tenantId, senderFile, COUNTERS), cliEnv(), () => {});
    expect(again.counters.map((c) => [c.docType, c.nextValue, c.created])).toEqual([
      ['invoice', 62, false],
      ['credit_note', 1, false],
      ['offer', 1, false],
    ]);
    expect(await readSettings(env.appDb, scope)).toEqual(before);

    // After an issue the counter is at 63; the same command still changes nothing.
    await env.appDb
      .updateTable('document_number_counter')
      .set({ next_value: 63, updated_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('doc_type', '=', 'invoice')
      .execute();
    const later = await runBooksInitCompany(argv(tenantId, senderFile, COUNTERS), cliEnv(), () => {});
    expect(later.counters[0]).toEqual({ docType: 'invoice', format: '{n}', nextValue: 63, created: false });
  });

  it('a different format or a start above the current counter is refused with COUNTER_EXISTS', async () => {
    const { tenantId, senderFile } = company();
    await runBooksInitCompany(argv(tenantId, senderFile, COUNTERS), cliEnv(), () => {});

    await expect(
      runBooksInitCompany(argv(tenantId, senderFile, ['invoice=RE-{n:4}:62']), cliEnv(), () => {}),
    ).rejects.toMatchObject({ code: 'COUNTER_EXISTS' });
    await expect(
      runBooksInitCompany(argv(tenantId, senderFile, ['invoice={n}:70']), cliEnv(), () => {}),
    ).rejects.toMatchObject({ code: 'COUNTER_EXISTS' });

    // Nothing moved: still {n} at 62.
    const row = await env.ownerDb
      .selectFrom('document_number_counter')
      .select(['format', 'next_value'])
      .where('tenant_id', '=', tenantId)
      .where('doc_type', '=', 'invoice')
      .executeTakeFirstOrThrow();
    expect({ format: row.format, next: Number(row.next_value) }).toEqual({ format: '{n}', next: 62 });
  });

  it('refuses a company auth-brain does not know, a wrong key, and a missing counter flag', async () => {
    const { senderFile } = company();
    await expect(
      runBooksInitCompany(argv(newTenantId(), senderFile, COUNTERS), cliEnv(), () => {}),
    ).rejects.toThrow(/not a tenant of that tenant group/);
    const { tenantId, senderFile: file2 } = company();
    await expect(
      runBooksInitCompany(argv(tenantId, file2, COUNTERS), cliEnv({ AUTH_BRAIN_ADMIN_API_KEY: 'wrong-key' }), () => {}),
    ).rejects.toThrow(/auth-brain answered 401/);
    await expect(runBooksInitCompany(argv(tenantId, file2, []), cliEnv(), () => {})).rejects.toThrow(/--counter is required/);
    // Nothing was written for that company.
    const scope = scopeFor(env.appDb, env.tgId, tenantId, new FakeDirectory());
    expect(await readSettings(env.appDb, scope)).toBeNull();
  });

  it('a re-run without --tax-status or --exemption-note keeps the stored ones', async () => {
    const { tenantId, senderFile } = company();
    await runBooksInitCompany(
      argv(tenantId, senderFile, COUNTERS, ['--tax-status', 'regular', '--exemption-note', 'Custom note', '--payment-terms', '30']),
      cliEnv(),
      () => {},
    );
    const rerun = await runBooksInitCompany(argv(tenantId, senderFile, COUNTERS, []), cliEnv(), () => {});
    expect(rerun.settings).toMatchObject({ taxStatus: 'regular', exemptionNote: 'Custom note', defaultPaymentTermsDays: 30 });
    // Given again, they change.
    const changed = await runBooksInitCompany(
      argv(tenantId, senderFile, COUNTERS, ['--tax-status', 'small_business']),
      cliEnv(),
      () => {},
    );
    expect(changed.settings).toMatchObject({ taxStatus: 'small_business', exemptionNote: 'Custom note' });
    // The first run of a company without --tax-status is refused.
    const fresh = company();
    await expect(runBooksInitCompany(argv(fresh.tenantId, fresh.senderFile, COUNTERS, []), cliEnv(), () => {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('the address block comes whole from one source, never mixed', async () => {
    // auth-brain has a billing address: every address field comes from it.
    const a = company({
      file: { taxNumber: '12/345/67890', addressLine1: 'File Street 9', addressLine2: 'Rear building', postalCode: '99999' },
    });
    const logs: string[] = [];
    const fromAuthBrain = await runBooksInitCompany(argv(a.tenantId, a.senderFile, COUNTERS), cliEnv(), (l) => logs.push(l));
    expect(fromAuthBrain.settings.senderBlock).toMatchObject({
      addressLine1: 'Musterstrasse 1',
      addressLine2: null,
      postalCode: '10115',
      city: 'Berlin',
      countryCode: 'DE',
    });
    expect(logs.some((l) => l.includes("address comes from auth-brain's billing address"))).toBe(true);

    // auth-brain has none: every address field comes from the file.
    const b = company({
      billingAddress: null,
      file: { taxNumber: '12/345/67890', addressLine1: 'File Street 9', postalCode: '99999', city: 'Leipzig', countryCode: 'de' },
    });
    const fromFile = await runBooksInitCompany(argv(b.tenantId, b.senderFile, COUNTERS), cliEnv(), () => {});
    expect(fromFile.settings.senderBlock).toMatchObject({
      addressLine1: 'File Street 9',
      postalCode: '99999',
      city: 'Leipzig',
      countryCode: 'DE',
    });
  });

  it('a country that is not an ISO 3166-1 alpha-2 code is refused', async () => {
    const fromStub = company({ billingAddress: { ...STUB_ADDRESS, country: 'Germany' } });
    await expect(runBooksInitCompany(argv(fromStub.tenantId, fromStub.senderFile, COUNTERS), cliEnv(), () => {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const fromFile = company({
      billingAddress: null,
      file: { taxNumber: '1', addressLine1: 'x', postalCode: '1', city: 'y', countryCode: 'DEU' },
    });
    await expect(runBooksInitCompany(argv(fromFile.tenantId, fromFile.senderFile, COUNTERS), cliEnv(), () => {})).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
