// src/app/api/books/__tests__/books-imports-routes.itest.ts
//
// The upload import through the REAL /api/books/imports route handlers, against
// a real provisioned tenant schema (as commerce_app). Only the auth-brain client
// (session and permission), the tenant handle factory (pointed at the test
// schema), the contacts database (a fake) and the Anthropic client (scripted at
// the client boundary) are replaced. Covers the guard chain on the new routes,
// the raw-body upload (type, size, a body cut off on the way, duplicates), the
// reading, a correction keyed to the reading, the confirmation, the PDF beside
// the form and the imported document's own download. Synthetic data only.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  directory: null as unknown,
  contactBook: null as unknown,
  anthropic: null as unknown,
  missingKey: false,
  allowed: true,
}));

vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: async () => state.session,
    can: async () => state.allowed,
  },
}));
vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: async () => state.db,
  isCommerceTenantNotProvisioned: () => false,
}));
vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));
vi.mock('@/lib/ai/anthropicClient', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/ai/anthropicClient')>();
  return {
    ...actual,
    getAnthropicClient: () => {
      if (state.missingKey) throw new actual.MissingAnthropicKeyError();
      return state.anthropic;
    },
  };
});

import { FakeContactBook, FakeDirectory, initCompany, newTenantId, openBooksEnv, scopeFor, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { fakeAnthropic, pdfBytes, toolInput, toolTurn, type FakeAnthropic } from '@/server/books/upload/__tests__/fakeAnthropic';

import * as importsRoute from '../imports/route';
import * as itemRoute from '../imports/[id]/route';
import * as extractRoute from '../imports/[id]/extract/route';
import * as confirmRoute from '../imports/[id]/confirm/route';
import * as discardRoute from '../imports/[id]/discard/route';
import * as recheckRoute from '../imports/[id]/recheck/route';
import * as itemPdfRoute from '../imports/[id]/pdf/route';
import * as confirmNumberRoute from '../imports/[id]/confirm-number/route';
import * as byHandRoute from '../imports/[id]/by-hand/route';
import * as documentPdfRoute from '../documents/[id]/pdf/route';

let env: BooksEnv;
let tenantId: string;
let dir: FakeDirectory;
let fake: FakeAnthropic;

beforeAll(async () => {
  env = await openBooksEnv('books-imports-routes');
  state.db = env.appDb;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

function sessionFor(id: string, grants: string[] = ['sites', 'books']) {
  return {
    user: { id: 'user-books' },
    session: {},
    tenants: [{ id, app_grants: grants, group_id: env.tgId, name: 'Example', slug: 'example' }],
    workspaces: [{ id: 'ws-books', tenant_id: id, name: 'Main', slug: 'main' }],
    active_tenant: { id },
    active_workspace: null,
  };
}

beforeEach(async () => {
  tenantId = newTenantId();
  dir = new FakeDirectory();
  state.directory = dir;
  state.contactBook = new FakeContactBook(dir);
  state.session = sessionFor(tenantId);
  state.missingKey = false;
  state.allowed = true;
  fake = fakeAnthropic([]);
  state.anthropic = fake.client;
  await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { invoiceNext: 62 });
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const HEADERS = { host: 'localhost:3000', cookie: 'lumitra_session=s' };

async function call(
  handler: (req: Request, route: { params: Promise<any> }) => Promise<Response>, // eslint-disable-line @typescript-eslint/no-explicit-any
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Json; headers: Headers }> {
  const req = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, headers: res.headers };
}

async function upload(bytes: Uint8Array, opts: { type?: string; name?: string; length?: number } = {}) {
  const req = new Request('http://localhost:3000/api/books/imports', {
    method: 'POST',
    headers: {
      ...HEADERS,
      'content-type': opts.type ?? 'application/pdf',
      'x-file-name': encodeURIComponent(opts.name ?? 'Rechnung 17.pdf'),
      'content-length': String(opts.length ?? bytes.byteLength),
    },
    body: Buffer.from(bytes),
  });
  const res = await importsRoute.POST(req, { params: Promise.resolve({}) });
  return { status: res.status, json: (await res.json()) as Json };
}

describe('the guard chain on the import routes', () => {
  it('no session 401, a company without the Books 403, and nothing staged', async () => {
    state.session = null;
    expect((await upload(pdfBytes('g1'))).status).toBe(401);
    state.session = sessionFor(tenantId, ['sites']);
    expect((await upload(pdfBytes('g2'))).json.error.code).toBe('books_not_enabled');
    expect((await call(importsRoute.GET, 'GET', '/api/books/imports')).status).toBe(403);
    const rows = await env.ownerDb.selectFrom('historical_import_item').select('id').where('tenant_id', '=', tenantId).execute();
    expect(rows).toEqual([]);
  });

  it('another host answers 404, and a user without the Books permission 403, on every import route', async () => {
    const id = (await upload(pdfBytes(`perm-${tenantId}`))).json.item.id as string;
    const routes: Array<[(req: Request, route: { params: Promise<any> }) => Promise<Response>, string, string, unknown]> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      [importsRoute.GET, 'GET', '/api/books/imports', undefined],
      [itemRoute.GET, 'GET', `/api/books/imports/${id}`, undefined],
      [itemRoute.PATCH, 'PATCH', `/api/books/imports/${id}`, { printed: {}, extractionId: 'x', expectedVersion: 0 }],
      [extractRoute.POST, 'POST', `/api/books/imports/${id}/extract`, undefined],
      [confirmRoute.POST, 'POST', `/api/books/imports/${id}/confirm`, { expectedVersion: 0 }],
      [confirmNumberRoute.POST, 'POST', `/api/books/imports/${id}/confirm-number`, { documentNumber: '1', expectedVersion: 0 }],
      [byHandRoute.POST, 'POST', `/api/books/imports/${id}/by-hand`, { expectedVersion: 0 }],
      [recheckRoute.POST, 'POST', `/api/books/imports/${id}/recheck`, undefined],
      [discardRoute.POST, 'POST', `/api/books/imports/${id}/discard`, undefined],
      [itemPdfRoute.GET, 'GET', `/api/books/imports/${id}/pdf`, undefined],
    ];
    // The editor runs on EDITOR_HOST; a published site's host never reaches the Books.
    vi.stubEnv('EDITOR_HOST', 'editor.example');
    for (const [handler, method, path, body] of routes) {
      const req = new Request(`http://elsewhere.example${path}`, {
        method,
        headers: { host: 'elsewhere.example', cookie: 'lumitra_session=s', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      expect((await handler(req, { params: Promise.resolve({ id }) })).status).toBe(404);
    }
    vi.unstubAllEnvs();
    state.allowed = false;
    for (const [handler, method, path, body] of routes) {
      const res = await call(handler, method, path, { id }, body);
      expect([res.status, res.json.error?.code]).toEqual([403, 'forbidden']);
    }
    expect(fake.calls).toHaveLength(0);
    expect((await env.ownerDb.selectFrom('historical_import_item').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('uploaded');
  });

  it('bytes that are not a PDF are never served, even if they reached the table some other way', async () => {
    // An upload that is really HTML is refused before staging.
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect((await upload(html, { name: 'invoice.pdf' })).json.error.code).toBe('invalid_input');
    // A row holding HTML bytes (written past the upload, as the owner role) is not served as a document.
    const id = crypto.randomUUID();
    await env.ownerDb
      .insertInto('historical_import_item')
      .values({ id, tenant_id: tenantId, file_name: 'x.pdf', content: html, byte_size: html.byteLength, sha256: 'f'.repeat(64), updated_at: new Date() })
      .execute();
    const res = await itemPdfRoute.GET(new Request(`http://localhost:3000/api/books/imports/${id}/pdf`, { headers: HEADERS }), { params: Promise.resolve({ id }) });
    expect(res.status).not.toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<script>');
  });

  it("another company's row answers 404", async () => {
    const staged = (await upload(pdfBytes(`own-${tenantId}`))).json.item.id as string;
    state.session = sessionFor(newTenantId());
    expect((await call(itemRoute.GET, 'GET', `/api/books/imports/${staged}`, { id: staged })).status).toBe(404);
  });
});

describe('the upload', () => {
  it('takes one PDF as the body; refuses another type, an oversized file and a body cut off on the way', async () => {
    expect((await upload(pdfBytes('t'), { type: 'multipart/form-data' })).status).toBe(415);
    expect((await upload(Buffer.from('not a pdf'))).json.error.code).toBe('invalid_input');
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(pdfBytes('big'));
    expect((await upload(big)).status).toBe(413);
    const bytes = pdfBytes(`cut-${tenantId}`);
    expect((await upload(bytes, { length: bytes.byteLength + 500 })).json.error.code).toBe('upload_truncated');

    const staged = await upload(pdfBytes(`ok-${tenantId}`), { name: 'C:\\scans\\Rechnung 17.pdf' });
    expect(staged.status).toBe(201);
    expect(staged.json).toMatchObject({ status: 'staged', item: { status: 'uploaded', fileName: 'Rechnung 17.pdf', printed: null } });
    const again = await upload(pdfBytes(`ok-${tenantId}`));
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: 'duplicate', item: { id: staged.json.item.id } });
    const list = await call(importsRoute.GET, 'GET', '/api/books/imports');
    expect(list.json.items.map((i: Json) => i.id)).toEqual([staged.json.item.id]);
    expect(list.json.counter).toEqual({ format: '{n}', nextValue: 62 });
    expect(list.json.limits).toMatchObject({ maxFileBytes: 10 * 1024 * 1024, parallel: 4, perDay: 500 });
  });
});

describe('read, correct, import', () => {
  it('forward through the routes, the PDF beside the form, the imported document served byte for byte', async () => {
    const bytes = pdfBytes(`flow-${tenantId}`);
    const id = (await upload(bytes)).json.item.id as string;
    fake.turns.push(toolTurn(toolInput({ number: '18' })));
    const read = await call(extractRoute.POST, 'POST', `/api/books/imports/${id}/extract`, { id });
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ status: 'ready', printed: { number: '18' }, confidence: { 'recipient.name': 'medium' } });

    const pdf = await itemPdfRoute.GET(new Request(`http://localhost:3000/api/books/imports/${id}/pdf`, { headers: HEADERS }), { params: Promise.resolve({ id }) });
    expect(Object.fromEntries(['content-type', 'x-content-type-options', 'content-disposition', 'cache-control', 'cross-origin-resource-policy', 'x-frame-options', 'content-security-policy'].map((h) => [h, pdf.headers.get(h)]))).toEqual({
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      // A fixed name: the uploaded file name never reaches a header.
      'content-disposition': 'inline; filename="document.pdf"',
      'cache-control': 'private, no-store',
      'cross-origin-resource-policy': 'same-origin',
      'x-frame-options': 'SAMEORIGIN',
      'content-security-policy': "frame-ancestors 'self'",
    });
    expect(Buffer.from(await pdf.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);

    // A correction keyed to this reading.
    const corrected = await call(itemRoute.PATCH, 'PATCH', `/api/books/imports/${id}`, { id }, {
      printed: { ...read.json.printed, number: '19' },
      extractionId: read.json.extractionId,
      expectedVersion: read.json.version,
    });
    expect(corrected.json).toMatchObject({ status: 'ready', corrected: true, printed: { number: '19' } });
    const stale = await call(itemRoute.PATCH, 'PATCH', `/api/books/imports/${id}`, { id }, {
      printed: read.json.printed,
      extractionId: 'old',
      expectedVersion: corrected.json.version,
    });
    expect(stale).toMatchObject({ status: 409, json: { error: { code: 'stale_extraction' } } });
    const rechecked = await call(recheckRoute.POST, 'POST', `/api/books/imports/${id}/recheck`, { id });
    expect(rechecked.json.status).toBe('ready');
    // A confirmation of the version before the recheck is refused: the row moved on.
    expect((await call(confirmRoute.POST, 'POST', `/api/books/imports/${id}/confirm`, { id }, { expectedVersion: corrected.json.version })).status).toBe(409);

    const done = await call(confirmRoute.POST, 'POST', `/api/books/imports/${id}/confirm`, { id }, { expectedVersion: rechecked.json.version });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ item: { status: 'imported' }, counterRaisedTo: null });
    const docId = done.json.documentId as string;
    const served = await documentPdfRoute.GET(new Request(`http://localhost:3000/api/books/documents/${docId}/pdf`, { headers: HEADERS }), {
      params: Promise.resolve({ id: docId }),
    });
    expect(served.headers.get('x-books-of-record')).toBe('true');
    expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    // Imported: its PDF beside the form is the stored original now.
    const after = await itemPdfRoute.GET(new Request(`http://localhost:3000/api/books/imports/${id}/pdf`, { headers: HEADERS }), { params: Promise.resolve({ id }) });
    expect(Buffer.from(await after.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    expect((await call(discardRoute.POST, 'POST', `/api/books/imports/${id}/discard`, { id })).status).toBe(409);
  });

  it('a row with a blocking problem answers 422 at confirm, naming the problem', async () => {
    const id = (await upload(pdfBytes(`np-${tenantId}`))).json.item.id as string;
    fake.turns.push(toolTurn(toolInput({ number: null })));
    const read = await call(extractRoute.POST, 'POST', `/api/books/imports/${id}/extract`, { id });
    expect(read.json.status).toBe('needs_attention');
    const refused = await call(confirmRoute.POST, 'POST', `/api/books/imports/${id}/confirm`, { id }, { expectedVersion: read.json.version });
    expect(refused).toMatchObject({ status: 422, json: { error: { code: 'import_not_ready' } } });
  });

  it('a raise of the counter needs the confirmed value; a number jumping far ahead needs its own confirmation', async () => {
    const id = (await upload(pdfBytes(`raise-${tenantId}`))).json.item.id as string;
    fake.turns.push(toolTurn(toolInput({ number: '200' })));
    const read = await call(extractRoute.POST, 'POST', `/api/books/imports/${id}/extract`, { id });
    expect(read.json.problems).toContainEqual({ code: 'number_jump', path: 'number', blocking: true, count: 62 });
    const confirmed = await call(confirmNumberRoute.POST, 'POST', `/api/books/imports/${id}/confirm-number`, { id }, { documentNumber: '200', expectedVersion: read.json.version });
    expect(confirmed.json.status).toBe('ready');
    expect(confirmed.json.problems).toContainEqual({ code: 'counter_raised', path: null, blocking: false, count: 201 });
    const unconfirmed = await call(confirmRoute.POST, 'POST', `/api/books/imports/${id}/confirm`, { id }, { expectedVersion: confirmed.json.version });
    expect(unconfirmed).toMatchObject({ status: 409, json: { error: { code: 'counter_raise_unconfirmed', raiseTo: 201 } } });
    // The refusal re-checked the row (its version moved): the page reloads it before confirming again.
    const current = await call(itemRoute.GET, 'GET', `/api/books/imports/${id}`, { id });
    const done = await call(confirmRoute.POST, 'POST', `/api/books/imports/${id}/confirm`, { id }, { expectedVersion: current.json.version, confirmCounterRaiseTo: 201 });
    expect(done.json).toMatchObject({ item: { status: 'imported' }, counterRaisedTo: 201 });
  });

  it('a row the AI could not read is filled in by hand through its route', async () => {
    const id = (await upload(pdfBytes(`byhand-${tenantId}`))).json.item.id as string;
    fake.turns.push({ content: [], stop_reason: 'refusal' });
    const refused = await call(extractRoute.POST, 'POST', `/api/books/imports/${id}/extract`, { id });
    expect(refused.json.problems).toEqual([{ code: 'extraction_failed:refused', path: null, blocking: true, count: null }]);
    expect((await call(byHandRoute.POST, 'POST', `/api/books/imports/${id}/by-hand`, { id }, {})).status).toBe(400);
    const blank = await call(byHandRoute.POST, 'POST', `/api/books/imports/${id}/by-hand`, { id }, { expectedVersion: refused.json.version });
    expect(blank.status).toBe(200);
    expect(blank.json.extractionId).toMatch(/^manual:/);
    expect(blank.json.printed).toMatchObject({ number: null, lines: [], currency: 'EUR' });
    const again = await call(byHandRoute.POST, 'POST', `/api/books/imports/${id}/by-hand`, { id }, { expectedVersion: blank.json.version });
    expect([again.status, again.json.error.code]).toEqual([409, 'concurrent_edit']);
  });

  it('without an AI key the reading answers 401 like the other AI routes, and the row stays unread', async () => {
    const id = (await upload(pdfBytes(`nokey-${tenantId}`))).json.item.id as string;
    state.missingKey = true;
    const res = await call(extractRoute.POST, 'POST', `/api/books/imports/${id}/extract`, { id });
    expect(res).toMatchObject({ status: 401, json: { error: { code: 'missing_anthropic_key' } } });
    expect((await call(itemRoute.GET, 'GET', `/api/books/imports/${id}`, { id })).json.status).toBe('uploaded');
  });
});
