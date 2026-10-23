// src/app/api/books/__tests__/books-render-input.itest.ts
//
// The browser's draft render against the REAL routes (WYSIWYG invoice editor
// plan, phase 1), on a real provisioned tenant schema. Only the auth-brain
// client, the tenant handle factory and the contacts database are replaced,
// as in books-routes.itest.ts.
//
//   - GET .../render-input answers a draft's render input, and the browser
//     entry (src/lib/books/engine: payload read back from the JSON, fonts
//     through GET /api/books/fonts/<sha256>, the logo through
//     GET /api/books/assets/<sha256>, both the real handlers) draws the same
//     bytes the draft PDF route answers, in every font family, with a logo,
//     with characters the family cannot draw;
//   - backtrack and resume: after a change to the draft the next render input
//     draws the new bytes, again equal to the PDF route; read again unchanged,
//     it draws the same bytes;
//   - the guard: another company's id, an unknown and a malformed id 404;
//     without viewBooks 403; an issued document 409 `not_renderable`;
//   - the font route: every pinned file with its bytes, `immutable`; an
//     unknown, malformed or logo digest 404; the guard.
// All data is synthetic; images are generated at run time.

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  db: null as unknown,
  session: null as unknown,
  directory: null as unknown,
  contactBook: null as unknown,
  can: true,
}));

vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: async () => state.session,
    can: async () => state.can,
  },
}));
vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: async () => state.db,
  isCommerceTenantNotProvisioned: () => false,
}));
vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));

import { parseRenderInputPayload } from '@/lib/books/engine/payload';
import { renderDraftPayload } from '@/lib/books/engine/render';
import { clearLoadedResources, type Fetcher } from '@/lib/books/engine/resources';
import { FONT_FILES } from '@/server/books/render/fontPins';
import { preset } from '@/server/books/template/presets';
import { FONT_FAMILIES, type FontFamily, type TemplateDocumentV2 } from '@/server/books/template/schema';
import { FakeContactBook, FakeDirectory, initCompany, newTenantId, openBooksEnv, scopeFor, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { makePng } from '@/server/books/__tests__/testImages';

import * as assetsRoute from '../assets/route';
import * as assetRoute from '../assets/[sha256]/route';
import * as customersRoute from '../customers/route';
import * as documentsRoute from '../documents/route';
import * as documentRoute from '../documents/[id]/route';
import * as linesRoute from '../documents/[id]/lines/route';
import * as issueRoute from '../documents/[id]/issue/route';
import * as pdfRoute from '../documents/[id]/pdf/route';
import * as renderInputRoute from '../documents/[id]/render-input/route';
import * as fontRoute from '../fonts/[sha256]/route';
import * as templatesRoute from '../templates/route';

let env: BooksEnv;
let tenantId: string;
let dir: FakeDirectory;

beforeAll(async () => {
  env = await openBooksEnv('books-render-input');
  state.db = env.appDb;
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function company() {
  tenantId = newTenantId();
  dir = new FakeDirectory();
  state.directory = dir;
  state.contactBook = new FakeContactBook(dir);
  state.session = {
    user: { id: 'user-books' },
    session: {},
    tenants: [{ id: tenantId, app_grants: ['sites', 'books'], group_id: env.tgId, name: 'Example', slug: 'example' }],
    workspaces: [{ id: 'ws-books', tenant_id: tenantId, name: 'Main', slug: 'main' }],
    active_tenant: { id: tenantId },
    active_workspace: null,
  };
  await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { taxStatus: 'regular', invoiceNext: 62 });
}

beforeEach(async () => {
  state.can = true;
  clearLoadedResources();
  await company();
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const HEADERS = { host: 'localhost:3000', cookie: 'lumitra_session=s' };

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://localhost:3000${path}`, {
    method,
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(
  handler: (req: Request, route: { params: Promise<any> }) => Promise<Response>, // eslint-disable-line @typescript-eslint/no-explicit-any
  method: string,
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const res = await handler(request(method, path, body), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

const renderInput = (id: string) => renderInputRoute.GET(request('GET', `/api/books/documents/${id}/render-input`), { params: Promise.resolve({ id }) });
const font = (digest: string) => fontRoute.GET(request('GET', `/api/books/fonts/${digest}`), { params: Promise.resolve({ sha256: digest }) });

/** The browser's fetch, answered by the real font and asset route handlers (with the page's cookie). */
const routesFetcher: Fetcher = async (path) => {
  const fontMatch = /^\/api\/books\/fonts\/(.+)$/.exec(path);
  if (fontMatch) return font(fontMatch[1]);
  const asset = /^\/api\/books\/assets\/(.+)$/.exec(path);
  if (asset) return assetRoute.GET(request('GET', path), { params: Promise.resolve({ sha256: asset[1] }) });
  throw new Error(`unexpected fetch ${path}`);
};

async function pdf(id: string): Promise<{ bytes: Uint8Array; digest: string | null }> {
  const res = await pdfRoute.GET(request('GET', `/api/books/documents/${id}/pdf`), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(200);
  return { bytes: new Uint8Array(await res.arrayBuffer()), digest: res.headers.get('x-books-sha256') };
}

/** Render the draft in the browser entry from the render-input route's answer. */
async function browserRender(id: string) {
  const res = await renderInput(id);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  const payload = parseRenderInputPayload(JSON.parse(await res.text()));
  return { payload, result: await renderDraftPayload(routesFetcher, payload) };
}

async function upload(bytes: Uint8Array): Promise<string> {
  const res = await assetsRoute.POST(
    new Request('http://localhost:3000/api/books/assets', { method: 'POST', headers: { ...HEADERS, 'content-type': 'image/png' }, body: bytes as BodyInit }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as Json).sha256 as string;
}

function withLogo(hash: string | null, family: FontFamily): TemplateDocumentV2 {
  const doc = preset('modern');
  doc.theme.fontFamily = family;
  doc.regions.firstPageHeader = [{ id: 'logo', type: 'logo', style: { align: 'right' }, widthMm: 40, assetSha256: hash }];
  return doc;
}

async function draft(title = 'Workshop'): Promise<string> {
  const customer = await call(customersRoute.POST, 'POST', '/api/books/customers', {}, {
    contact: { kind: 'organization', name: 'Sample Customer GmbH', addressLine1: 'Beispielweg 2', postalCode: '20095', city: 'Hamburg', country: 'DE' },
    customerType: 'b2b',
    vatId: null,
    countryCode: 'DE',
  });
  expect(customer.status).toBe(201);
  const created = await call(documentsRoute.POST, 'POST', '/api/books/documents', {}, { customerId: customer.json.id });
  const id = created.json.document.id as string;
  for (const [t, q] of [[title, 1000], ['Reisekosten', 2500]] as const) {
    const line = await call(linesRoute.POST, 'POST', `/api/books/documents/${id}/lines`, { id }, { kind: 'service', title: t, quantity: q, unitPrice: 5000 });
    expect(line.status).toBe(201);
  }
  return id;
}

async function useTemplate(id: string, doc: TemplateDocumentV2): Promise<void> {
  const tpl = await call(templatesRoute.POST, 'POST', '/api/books/templates', {}, { name: `Vorlage ${doc.theme.fontFamily}`, document: doc });
  expect(tpl.status).toBe(201);
  const patched = await call(documentRoute.PATCH, 'PATCH', `/api/books/documents/${id}`, { id }, { templateId: tpl.json.id });
  expect(patched.status).toBe(200);
}

describe('the browser draws a draft exactly as the draft PDF route', () => {
  it.each(FONT_FAMILIES)('in %s, with a logo and characters the family cannot draw', async (family) => {
    const logo = makePng(300, 100);
    const hash = await upload(logo);
    const id = await draft('Beratung 漢字 ✓');
    await useTemplate(id, withLogo(hash, family));
    const { payload, result } = await browserRender(id);
    expect(payload.fontFamily).toBe(family);
    expect(payload.logos).toEqual([{ sha256: hash, contentType: 'image/png' }]);
    expect(payload.input.draft).toBe(true);
    const server = await pdf(id);
    expect(sha(result.bytes)).toBe(server.digest);
    expect(Buffer.from(result.bytes).equals(Buffer.from(server.bytes))).toBe(true);
    expect(result.layout.issues).toEqual([]);
  });

  it('the built-in layout without a template', async () => {
    const id = await draft();
    const { payload, result } = await browserRender(id);
    expect(payload.input.document.templateId).toBeNull();
    expect(payload.logos).toEqual([]);
    expect(sha(result.bytes)).toBe((await pdf(id)).digest);
  });

  it('backtrack and resume: a change draws the new bytes, a second read the same', async () => {
    const id = await draft();
    const before = await browserRender(id);
    const changed = await call(documentRoute.PATCH, 'PATCH', `/api/books/documents/${id}`, { id }, { introText: 'Vielen Dank für Ihren Auftrag.' });
    expect(changed.status).toBe(200);
    const after = await browserRender(id);
    expect(after.payload.documentVersion).toBeGreaterThan(before.payload.documentVersion);
    expect(sha(after.result.bytes)).not.toBe(sha(before.result.bytes));
    expect(sha(after.result.bytes)).toBe((await pdf(id)).digest);
    const again = await browserRender(id);
    expect(sha(again.result.bytes)).toBe(sha(after.result.bytes));
  });
});

describe('GET /api/books/documents/<id>/render-input: the guard', () => {
  it("another company's draft, an unknown and a malformed id: 404 not_found", async () => {
    const id = await draft();
    await company();
    for (const other of [id, '00000000-0000-4000-8000-000000000000', 'not-an-id']) {
      const res = await renderInput(other);
      expect(res.status, other).toBe(404);
      expect(((await res.json()) as Json).error.code).toBe('not_found');
    }
  });

  it('without viewBooks: 403', async () => {
    const id = await draft();
    state.can = false;
    expect((await renderInput(id)).status).toBe(403);
  });

  it('an issued document: 409 not_renderable (its stored PDF is the document)', async () => {
    const id = await draft();
    expect((await call(documentRoute.PATCH, 'PATCH', `/api/books/documents/${id}`, { id }, { serviceDate: '2026-10-20' })).status).toBe(200);
    const issued = await call(issueRoute.POST, 'POST', `/api/books/documents/${id}/issue`, { id }, {});
    expect(issued.status, JSON.stringify(issued.json)).toBe(200);
    const res = await renderInput(id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).error.code).toBe('not_renderable');
  });
});

describe('GET /api/books/fonts/<sha256>', () => {
  it('serves every pinned file, immutable', async () => {
    for (const family of FONT_FAMILIES) {
      for (const face of ['regular', 'bold'] as const) {
        const pin = FONT_FILES[family][face];
        const res = await font(pin.sha256);
        expect(res.status, pin.file).toBe(200);
        expect(res.headers.get('content-type')).toBe('font/ttf');
        expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(pin.sha256);
      }
    }
  });

  it('an unknown, a malformed or a logo digest: 404', async () => {
    const hash = await upload(makePng(10, 10));
    for (const digest of ['f'.repeat(64), 'not-a-digest', FONT_FILES['dejavu-sans'].regular.sha256.toUpperCase(), hash]) {
      const res = await font(digest);
      expect(res.status, digest).toBe(404);
      expect(((await res.json()) as Json).error.code).toBe('not_found');
    }
  });

  it('without viewBooks: 403', async () => {
    state.can = false;
    expect((await font(FONT_FILES['noto-sans'].bold.sha256)).status).toBe(403);
  });
});
