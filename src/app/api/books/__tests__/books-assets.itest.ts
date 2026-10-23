// src/app/api/books/__tests__/books-assets.itest.ts
//
// Books composer phase 5 (logos and fonts) end to end through the REAL route
// handlers, against a real provisioned tenant schema (the repository connected
// as commerce_app). Only the auth-brain client, the tenant handle factory and
// the contacts database are replaced, as in books-routes.itest.ts.
//
//   - the upload: PNG and JPEG stored (201) and the same bytes answered again
//     (200, also when two uploads race); too large, the wrong type, too many
//     pixels, undecodable refused with their codes; the bounded stream;
//     the guard (sign-in, editBooks, viewBooks);
//   - the download: the bytes with their type, cached immutable; another
//     company's, an unknown and a malformed hash all 404;
//   - templates: a logo of the company saves, one it does not have (or another
//     company's) is refused by the gate with the block named;
//   - the four stateful-flow paths of a document with a logo
//     (stateful-flow-testing.md): forward (draft preview, issue freezes
//     `logo: { sha256 }`, the stored PDF carries the image), backtrack (the
//     template's logo and font changed after issue: the re-render is byte
//     identical, a new draft takes the new logo), resume (the stored file is
//     served again from the database, unchanged), re-entry (an issue refused
//     because the logo is missing issues nothing and takes no number; once
//     fixed, the retry issues with the number the refused attempt would have had);
//   - the snapshot's logo is the authority: a stored file rendered again on
//     download reproduces it, a credit note carries it, and a document whose
//     snapshot froze no logo is drawn without one (and can be cancelled) even
//     when its layout names a hash;
//   - the cap of 100 logos per company, `image/jpg`, an empty body, the ETag;
//   - documents set in each family: issued and re-rendered byte-identically,
//     a document issued under DejaVu Sans still re-renders identically after
//     its template moved to Noto.
// All data is synthetic; images are generated at run time.

import { createHash, randomUUID } from 'node:crypto';

import { PDFDocument, PDFName, PDFRawStream, type PDFRef } from 'pdf-lib';
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

import { getDocument } from '@/server/books/repository/read';
import { toJsonb } from '@/server/books/snapshots';
import { renderIssuedDocument } from '@/server/books/render/store';
import { extractPdfText } from '@/server/books/render/extractText';
import { preset } from '@/server/books/template/presets';
import type { FontFamily, TemplateDocumentV2 } from '@/server/books/template/schema';
import {
  FakeContactBook,
  FakeDirectory,
  initCompany,
  newTenantId,
  openBooksEnv,
  scopeFor,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';
import { makeJpeg, makePng } from '@/server/books/__tests__/testImages';

import * as assetsRoute from '../assets/route';
import * as assetRoute from '../assets/[sha256]/route';
import * as customersRoute from '../customers/route';
import * as documentsRoute from '../documents/route';
import * as linesRoute from '../documents/[id]/lines/route';
import * as issueRoute from '../documents/[id]/issue/route';
import * as pdfRoute from '../documents/[id]/pdf/route';
import * as cancelRoute from '../documents/[id]/cancel/route';
import * as templatesRoute from '../templates/route';
import * as templateRoute from '../templates/[id]/route';
import * as previewRoute from '../templates/preview/route';

let env: BooksEnv;
let tenantId: string;
let dir: FakeDirectory;

beforeAll(async () => {
  env = await openBooksEnv('books-assets');
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
  await initCompany(scopeFor(env.appDb, env.tgId, tenantId, dir), { taxStatus: 'small_business', invoiceNext: 62 });
}

beforeEach(async () => {
  state.can = true;
  await company();
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const HEADERS = { host: 'localhost:3000', cookie: 'lumitra_session=s' };

function jsonRequest(method: string, path: string, body?: unknown): Request {
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
  const res = await handler(jsonRequest(method, path, body), { params: Promise.resolve(params) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

async function upload(bytes: Uint8Array | ReadableStream<Uint8Array>, type: string): Promise<{ status: number; json: Json }> {
  const res = await assetsRoute.POST(
    new Request('http://localhost:3000/api/books/assets', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': type },
      body: bytes as BodyInit,
      ...(bytes instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, json: JSON.parse(await res.text()) };
}

async function download(hash: string, extra: Record<string, string> = {}): Promise<Response> {
  return assetRoute.GET(new Request(`http://localhost:3000/api/books/assets/${hash}`, { headers: { ...HEADERS, ...extra } }), {
    params: Promise.resolve({ sha256: hash }),
  });
}

async function pdf(id: string): Promise<Uint8Array> {
  const res = await pdfRoute.GET(jsonRequest('GET', `/api/books/documents/${id}/pdf`), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

/** The images a PDF shows (their pixel sizes), not counting the alpha masks pdf-lib adds to a PNG with transparency. */
async function images(bytes: Uint8Array): Promise<Array<{ width: number; height: number }>> {
  const doc = await PDFDocument.load(bytes);
  const all = doc.context.enumerateIndirectObjects().filter(
    ([, obj]) => obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
  ) as Array<[PDFRef, PDFRawStream]>;
  const masks = new Set(all.map(([, obj]) => obj.dict.get(PDFName.of('SMask'))?.toString()).filter(Boolean));
  return all
    .filter(([ref]) => !masks.has(ref.toString()))
    .map(([, obj]) => ({ width: Number(obj.dict.get(PDFName.of('Width'))!.toString()), height: Number(obj.dict.get(PDFName.of('Height'))!.toString()) }));
}

/** Modern with the company's logo top right and small on following pages, in a family. */
function withLogo(hash: string | null, family: FontFamily = 'dejavu-sans'): TemplateDocumentV2 {
  const doc = preset('modern');
  doc.theme.fontFamily = family;
  doc.regions.firstPageHeader = [{ id: 'logo', type: 'logo', style: { align: 'right' }, widthMm: 40, assetSha256: hash }];
  doc.regions.followingPageHeader = [
    { id: 'logoSmall', type: 'logo', style: { spaceBelowPt: 4 }, widthMm: 20, assetSha256: hash },
    ...doc.regions.followingPageHeader,
  ];
  return doc;
}

const createTemplate = (body: unknown) => call(templatesRoute.POST, 'POST', '/api/books/templates', {}, body);
const patchTemplate = (id: string, body: unknown) => call(templateRoute.PATCH, 'PATCH', `/api/books/templates/${id}`, { id }, body);

/** The company's one customer (created on first use). */
const customers = new Map<string, string>();

async function draftWithLine(): Promise<string> {
  let customerId = customers.get(tenantId);
  if (!customerId) {
    const customer = await call(customersRoute.POST, 'POST', '/api/books/customers', {}, {
      contact: { kind: 'organization', name: 'Sample Customer GmbH', addressLine1: 'Beispielweg 2', postalCode: '20095', city: 'Hamburg', country: 'DE' },
      customerType: 'b2b',
      vatId: null,
      countryCode: 'DE',
    });
    expect(customer.status).toBe(201);
    customerId = customer.json.id as string;
    customers.set(tenantId, customerId);
  }
  const draft = await call(documentsRoute.POST, 'POST', '/api/books/documents', {}, { customerId });
  const id = draft.json.document.id as string;
  const line = await call(linesRoute.POST, 'POST', `/api/books/documents/${id}/lines`, { id }, {
    kind: 'service',
    title: 'Workshop',
    quantity: 1000,
    unitPrice: 5000,
  });
  expect(line.status).toBe(201);
  return id;
}

const issue = (id: string) => call(issueRoute.POST, 'POST', `/api/books/documents/${id}/issue`, { id }, {});

describe('POST /api/books/assets', () => {
  it('stores a PNG (201), answers the same bytes again with the stored one (200), and a JPEG', async () => {
    const png = makePng(300, 100);
    const first = await upload(png, 'image/png');
    expect(first.status).toBe(201);
    expect(first.json).toEqual({ sha256: sha(png), contentType: 'image/png', byteSize: png.byteLength, widthPx: 300, heightPx: 100 });
    const again = await upload(png, 'image/png; charset=binary');
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    const jpeg = makeJpeg(120, 60);
    const j = await upload(jpeg, 'image/jpeg');
    expect(j.status).toBe(201);
    expect(j.json).toMatchObject({ sha256: sha(jpeg), contentType: 'image/jpeg', widthPx: 120, heightPx: 60 });
    const rows = await env.ownerDb.selectFrom('books_asset').select(['sha256', 'kind', 'created_by']).where('tenant_id', '=', tenantId).orderBy('sha256').execute();
    expect(rows).toEqual(
      [sha(png), sha(jpeg)].sort().map((s) => ({ sha256: s, kind: 'logo', created_by: 'user-books' })),
    );
  });

  it('two uploads of the same file at once: one stores, both answer the same asset', async () => {
    const png = makePng(64, 64);
    const [a, b] = await Promise.all([upload(png, 'image/png'), upload(png, 'image/png')]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.json).toEqual(b.json);
  });

  it('refuses too large (413), the wrong type (415), too many pixels and damaged files (422)', async () => {
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(makePng(2, 2));
    const tooBig = await upload(big, 'image/png');
    expect(tooBig.status).toBe(413);
    expect(tooBig.json.error.code).toBe('asset_too_large');

    // A streamed body without Content-Length stops at the limit.
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 12) return c.close();
        sent += 1;
        c.enqueue(chunk);
      },
    });
    expect((await upload(stream, 'image/png')).status).toBe(413);
    expect(sent).toBeLessThan(12);

    for (const [bytes, type] of [
      [makePng(2, 2), 'image/gif'],
      [makePng(2, 2), 'text/plain'],
      [makePng(2, 2), 'image/jpeg'],
      [new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'],
    ] as const) {
      const res = await upload(bytes, type);
      expect(res.status, type).toBe(415);
      expect(res.json.error.code).toBe('unsupported_asset_type');
    }

    const wide = await upload(makePng(2001, 2), 'image/png');
    expect(wide.status).toBe(422);
    expect(wide.json.error).toMatchObject({ code: 'asset_invalid', problem: 'too_many_pixels' });
    expect(wide.json.error.message).toContain('at most 2000 px');
    const cut = makeJpeg(80, 80);
    const truncated = await upload(cut.subarray(0, cut.length - 50), 'image/jpeg');
    expect(truncated.status).toBe(422);
    expect(truncated.json.error).toMatchObject({ code: 'asset_invalid', problem: 'undecodable' });
    expect(await env.ownerDb.selectFrom('books_asset').select('id').where('tenant_id', '=', tenantId).execute()).toEqual([]);
  });

  it('reads image/jpg as image/jpeg, refuses an empty body, and caps a company at 100 logos (409)', async () => {
    const jpeg = makeJpeg(24, 12);
    const jpg = await upload(jpeg, 'image/jpg');
    expect(jpg.status).toBe(201);
    expect(jpg.json.contentType).toBe('image/jpeg');
    const empty = await upload(new Uint8Array(0), 'image/png');
    expect(empty.status).toBe(422);
    expect(empty.json.error).toMatchObject({ code: 'asset_invalid', message: 'the file is empty' });

    // 99 more stored logos (written directly; each a distinct hash), then the 101st upload is refused.
    const png = makePng(2, 2);
    await env.ownerDb
      .insertInto('books_asset')
      .values(
        Array.from({ length: 99 }, (_, i) => ({
          id: randomUUID(),
          tenant_id: tenantId,
          kind: 'logo',
          content_type: 'image/png',
          byte_size: png.byteLength,
          sha256: sha(new TextEncoder().encode(`filler ${i}`)),
          width_px: 2,
          height_px: 2,
          content: Buffer.from(png),
        })),
      )
      .execute();
    const over = await upload(makePng(3, 3), 'image/png');
    expect(over.status).toBe(409);
    expect(over.json.error).toMatchObject({ code: 'asset_limit', maxAssets: 100 });
    // A logo already stored is still answered (no new row).
    expect((await upload(jpeg, 'image/jpeg')).status).toBe(200);
  });

  it('at 99 logos, two different uploads at once: exactly one is stored, the other is refused (the lock)', async () => {
    const png = makePng(2, 2);
    await env.ownerDb
      .insertInto('books_asset')
      .values(
        Array.from({ length: 99 }, (_, i) => ({
          id: randomUUID(),
          tenant_id: tenantId,
          kind: 'logo',
          content_type: 'image/png',
          byte_size: png.byteLength,
          sha256: sha(new TextEncoder().encode(`filler ${i}`)),
          width_px: 2,
          height_px: 2,
          content: Buffer.from(png),
        })),
      )
      .execute();
    const [a, b] = await Promise.all([upload(makePng(5, 5), 'image/png'), upload(makePng(6, 6), 'image/png')]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const [{ n }] = await env.ownerDb
      .selectFrom('books_asset')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('tenant_id', '=', tenantId)
      .execute();
    expect(Number(n)).toBe(100);
  });

  it('needs a signed-in user with editBooks to upload and viewBooks to read', async () => {
    const png = makePng(10, 10);
    expect((await upload(png, 'image/png')).status).toBe(201);
    state.can = false;
    expect((await upload(makePng(11, 11), 'image/png')).status).toBe(403);
    expect((await download(sha(png))).status).toBe(403);
    state.can = true;
    state.session = null;
    expect((await upload(png, 'image/png')).status).toBe(401);
    expect((await download(sha(png))).status).toBe(401);
  });
});

describe('GET /api/books/assets/<sha256>', () => {
  it('answers the bytes with their type, cached privately and immutably', async () => {
    const jpeg = makeJpeg(40, 20);
    await upload(jpeg, 'image/jpeg');
    const res = await download(sha(jpeg));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(res.headers.get('etag')).toBe(`"${sha(jpeg)}"`);
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(jpeg))).toBe(true);
    // A revalidation with the hash answers 304 without the bytes.
    const again = await download(sha(jpeg), { 'if-none-match': `W/"${sha(jpeg)}"` });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    expect((await download(sha(jpeg), { 'if-none-match': '"other"' })).status).toBe(200);
    expect((await download(sha(jpeg), { 'if-none-match': '*' })).status).toBe(304);
    // A revalidation of another company's asset is a 404 like any other request.
    await company();
    expect((await download(sha(jpeg), { 'if-none-match': `"${sha(jpeg)}"` })).status).toBe(404);
  });

  it("answers 404 for another company's asset, an unknown hash and a malformed one", async () => {
    const png = makePng(12, 12);
    await upload(png, 'image/png');
    await company();
    for (const hash of [sha(png), 'f'.repeat(64), 'not-a-hash', 'F'.repeat(64)]) {
      const res = await download(hash);
      expect(res.status, hash).toBe(404);
      expect(((await res.json()) as Json).error.code).toBe('asset_not_found');
    }
  });
});

describe('templates with a logo', () => {
  it("saves a logo of the company; refuses one it does not have and another company's, naming the blocks", async () => {
    const png = makePng(300, 100);
    const foreign = makePng(301, 100);
    await upload(foreign, 'image/png');
    await company();
    await upload(png, 'image/png');

    const saved = await createTemplate({ name: 'Mit Logo', document: withLogo(sha(png)) });
    expect(saved.status).toBe(201);
    expect(saved.json.document.regions.firstPageHeader[0].assetSha256).toBe(sha(png));

    for (const hash of [sha(foreign), 'e'.repeat(64)]) {
      const refused = await createTemplate({ name: `Fremd ${hash.slice(0, 4)}`, document: withLogo(hash) });
      expect(refused.status).toBe(422);
      expect(refused.json.error.code).toBe('template_invalid');
      expect(refused.json.error.problems).toEqual([
        expect.objectContaining({ code: 'LOGO_ASSET_MISSING', blockId: 'logo' }),
        expect.objectContaining({ code: 'LOGO_ASSET_MISSING', blockId: 'logoSmall' }),
      ]);
    }
    // Two different images in one template.
    const jpeg = makeJpeg(50, 50);
    await upload(jpeg, 'image/jpeg');
    const two = withLogo(sha(png));
    two.regions.footer.push({ id: 'footerLogo', type: 'logo', style: {}, widthMm: 15, assetSha256: sha(jpeg) });
    const differ = await createTemplate({ name: 'Zwei Logos', document: two });
    expect(differ.status).toBe(422);
    expect(differ.json.error.problems).toEqual([expect.objectContaining({ code: 'LOGO_ASSETS_DIFFER', blockId: 'footerLogo' })]);
  });

  it('previews a logo of the company; a hash it does not have shows as a layout issue', async () => {
    const png = makePng(300, 100);
    await upload(png, 'image/png');
    const res = await previewRoute.POST(jsonRequest('POST', '/api/books/templates/preview', { document: withLogo(sha(png), 'noto-serif'), subject: { kind: 'sample', variant: 'regular' } }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json;
    expect(body.layout.blocks).toContainEqual(expect.objectContaining({ blockId: 'logo', page: 1, region: 'firstPageHeader' }));
    expect(body.layout.issues).toEqual([]);
    expect(await images(new Uint8Array(Buffer.from(body.pdf, 'base64')))).toEqual([{ width: 300, height: 100 }]);

    const missing = await previewRoute.POST(jsonRequest('POST', '/api/books/templates/preview', { document: withLogo('d'.repeat(64)), subject: { kind: 'sample', variant: 'regular' } }), {
      params: Promise.resolve({}),
    });
    expect(missing.status).toBe(200);
    expect(((await missing.json()) as Json).layout.issues).toContainEqual({ code: 'LOGO_ASSET_MISSING', blockId: 'logo', region: 'firstPageHeader' });
  });
});

describe('a document with a logo: the four stateful-flow paths', () => {
  it('forward and backtrack: issue freezes the logo; a later logo and font change leaves the re-render byte-identical', async () => {
    const first = makePng(300, 100);
    await upload(first, 'image/png');
    const tpl = await createTemplate({ name: 'Mit Logo', document: withLogo(sha(first)) });
    expect(tpl.status).toBe(201);
    const id = await draftWithLine();

    // Forward: the draft preview draws the logo, the issue freezes it and stores it in the PDF.
    expect(await images(await pdf(id))).toEqual([{ width: 300, height: 100 }]);
    const issued = await issue(id);
    expect(issued.status).toBe(200);
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const view = await getDocument(scope, id);
    expect(view.document.templateSnapshot).toMatchObject({ v: 2, templateId: tpl.json.id, logo: { sha256: sha(first) } });
    const stored = await pdf(id);
    expect(await images(stored)).toEqual([{ width: 300, height: 100 }]);

    // Backtrack: the template gets another logo and another font afterwards.
    const second = makeJpeg(300, 120);
    await upload(second, 'image/jpeg');
    const changed = await patchTemplate(tpl.json.id, { document: withLogo(sha(second), 'noto-serif'), baseVersionId: tpl.json.currentVersionId });
    expect(changed.status).toBe(200);
    expect(changed.json.version).toBe(2);
    // The issued document re-renders exactly as stored (its frozen layout, the frozen logo by hash).
    const rerendered = await renderIssuedDocument(scope, await getDocument(scope, id));
    expect(Buffer.from(rerendered).equals(Buffer.from(stored))).toBe(true);
    // A new draft takes the new logo.
    const next = await draftWithLine();
    expect(await images(await pdf(next))).toEqual([{ width: 300, height: 120 }]);

    // Resume: the stored file is served again, unchanged, and the snapshot still names the first logo.
    expect(Buffer.from(await pdf(id)).equals(Buffer.from(stored))).toBe(true);
    expect((await getDocument(scope, id)).document.templateSnapshot).toMatchObject({ logo: { sha256: sha(first) } });
  });

  it('re-entry: an issue whose logo is missing is refused by name, takes no number, and the retry once fixed gets that number', async () => {
    const tpl = await createTemplate({ name: 'Standard' });
    const id = await draftWithLine();
    // A version naming a logo this company does not have, written past the gate (the gate never lets one through).
    const ghost = makePng(90, 30);
    const versionId = randomUUID();
    await env.ownerDb
      .insertInto('document_template_version')
      .values({ id: versionId, tenant_id: tenantId, template_id: tpl.json.id, version: 2, document: toJsonb(withLogo(sha(ghost))) })
      .execute();
    await env.ownerDb.updateTable('document_template').set({ current_version_id: versionId }).where('id', '=', tpl.json.id).execute();

    const refused = await issue(id);
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatchObject({ code: 'logo_asset_missing', blockIds: ['logo', 'logoSmall'] });
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    expect((await getDocument(scope, id)).document).toMatchObject({ status: 'draft', documentNumber: null, templateSnapshot: null });
    expect(await env.ownerDb.selectFrom('sales_document_file').select('id').where('document_id', '=', id).execute()).toEqual([]);
    // The draft preview still renders, without the logo.
    expect(await images(await pdf(id))).toEqual([]);

    // The company uploads the logo; the retry issues with number 62, the one the refused attempt would have had.
    await upload(ghost, 'image/png');
    const retried = await issue(id);
    expect(retried.status).toBe(200);
    expect(retried.json.document.document.documentNumber).toBe('62');
    expect(await images(await pdf(id))).toEqual([{ width: 90, height: 30 }]);
  });
});

describe('a layout naming two different logos', () => {
  it('is refused at issue by name (one template, one logo), nothing issued', async () => {
    // A version written past the gate, as a template saved before the one-logo rule could be.
    const png = makePng(90, 30);
    const jpeg = makeJpeg(60, 30);
    await upload(png, 'image/png');
    await upload(jpeg, 'image/jpeg');
    const tpl = await createTemplate({ name: 'Standard' });
    const two = withLogo(sha(png));
    two.regions.footer.push({ id: 'footerLogo', type: 'logo', style: {}, widthMm: 15, assetSha256: sha(jpeg) });
    const versionId = randomUUID();
    await env.ownerDb
      .insertInto('document_template_version')
      .values({ id: versionId, tenant_id: tenantId, template_id: tpl.json.id, version: 2, document: toJsonb(two) })
      .execute();
    await env.ownerDb.updateTable('document_template').set({ current_version_id: versionId }).where('id', '=', tpl.json.id).execute();
    const id = await draftWithLine();
    const refused = await issue(id);
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatchObject({ code: 'render_incomplete', missing: ['layout.logo_assets_differ.footerLogo'] });
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    expect((await getDocument(scope, id)).document).toMatchObject({ status: 'draft', documentNumber: null });
  });
});

describe('documents set in each family', () => {
  it.each(['dejavu-sans', 'noto-sans', 'noto-serif'] as const)('%s: issued, stored, and re-rendered byte-identically', async (family) => {
    const tpl = await createTemplate({ name: `In ${family}`, document: withLogo(null, family) });
    expect(tpl.status).toBe(201);
    const id = await draftWithLine();
    expect((await issue(id)).status).toBe(200);
    const stored = await pdf(id);
    expect(await extractPdfText(stored)).toContain('Workshop');
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    const view = await getDocument(scope, id);
    expect(view.document.templateSnapshot).toMatchObject({ document: { theme: { fontFamily: family } }, logo: null });
    expect(Buffer.from(await renderIssuedDocument(scope, view)).equals(Buffer.from(stored))).toBe(true);
  });

  it('a document issued under DejaVu Sans re-renders identically after its template moved to Noto Serif', async () => {
    const tpl = await createTemplate({ name: 'Standard' });
    expect(tpl.json.document.theme.fontFamily).toBe('dejavu-sans');
    const id = await draftWithLine();
    await issue(id);
    const stored = await pdf(id);
    const doc = structuredClone(tpl.json.document) as TemplateDocumentV2;
    doc.theme.fontFamily = 'noto-serif';
    expect((await patchTemplate(tpl.json.id, { document: doc })).status).toBe(200);
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    expect(Buffer.from(await renderIssuedDocument(scope, await getDocument(scope, id))).equals(Buffer.from(stored))).toBe(true);
  });

  it('refuses at issue a name the document font cannot draw, in the family of its template', async () => {
    await createTemplate({ name: 'Noto', document: withLogo(null, 'noto-sans') });
    const id = await draftWithLine();
    const lines = await call(linesRoute.POST, 'POST', `/api/books/documents/${id}/lines`, { id }, { kind: 'service', title: 'Umzug → Lager', quantity: 1000, unitPrice: 100 });
    expect(lines.status).toBe(201);
    const refused = await issue(id);
    expect(refused.status).toBe(422);
    expect(refused.json.error).toMatchObject({ code: 'undrawable_text', fields: ['line2.title'] });
  });
});

describe('issued documents and their frozen logo', () => {
  /** Turn an issued document into one stored before its file existed (as before 008): the next download renders and stores it. */
  async function dropStoredFile(id: string, snapshotPatch?: (snapshot: Json) => Json) {
    const owner = env.fx.owner;
    const s = owner(env.schema);
    await owner`ALTER TABLE ${s}.sales_document DISABLE TRIGGER USER`;
    await owner`ALTER TABLE ${s}.sales_document_file DISABLE TRIGGER USER`;
    try {
      if (snapshotPatch) {
        const [row] = await owner<{ template_snapshot: Json }[]>`SELECT template_snapshot FROM ${s}.sales_document WHERE id = ${id}`;
        await owner`UPDATE ${s}.sales_document SET template_snapshot = ${owner.json(snapshotPatch(row.template_snapshot))} WHERE id = ${id}`;
      }
      await owner`UPDATE ${s}.sales_document SET rendered_pdf_file_id = NULL WHERE id = ${id}`;
      await owner`DELETE FROM ${s}.sales_document_file WHERE document_id = ${id}`;
    } finally {
      await owner`ALTER TABLE ${s}.sales_document ENABLE TRIGGER USER`;
      await owner`ALTER TABLE ${s}.sales_document_file ENABLE TRIGGER USER`;
    }
  }

  it('the lazy render of a stored file reproduces the logo, and a credit note carries the same logo', async () => {
    const png = makePng(300, 100);
    await upload(png, 'image/png');
    await createTemplate({ name: 'Mit Logo', document: withLogo(sha(png)) });
    const id = await draftWithLine();
    expect((await issue(id)).status).toBe(200);
    const stored = await pdf(id);
    await dropStoredFile(id);
    // Rendered again on download from the frozen data and the stored asset: the same bytes.
    expect(Buffer.from(await pdf(id)).equals(Buffer.from(stored))).toBe(true);

    const cancelled = await call(cancelRoute.POST, 'POST', `/api/books/documents/${id}/cancel`, { id }, { reason: 'issued in error' });
    expect(cancelled.status).toBe(200);
    const creditId = cancelled.json.creditNote.document.id as string;
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    expect((await getDocument(scope, creditId)).document.templateSnapshot).toMatchObject({ logo: { sha256: sha(png) } });
    expect(await images(await pdf(creditId))).toEqual([{ width: 300, height: 100 }]);
  });

  it('a document whose snapshot froze no logo is drawn without one, though its layout names a hash, and can be cancelled', async () => {
    // As a template saved before logos existed could be: a hash in the layout the engine of the time never drew.
    const png = makePng(300, 100);
    await upload(png, 'image/png');
    await createTemplate({ name: 'Alt', document: withLogo(sha(png)) });
    const id = await draftWithLine();
    expect((await issue(id)).status).toBe(200);
    await dropStoredFile(id, (snapshot) => ({ ...snapshot, logo: null }));
    const stored = await pdf(id);
    expect(await images(stored)).toEqual([]);
    const scope = scopeFor(env.appDb, env.tgId, tenantId, dir);
    expect(Buffer.from(await renderIssuedDocument(scope, await getDocument(scope, id))).equals(Buffer.from(stored))).toBe(true);

    // The same with a hash the company never had: nothing is missing, because nothing is drawn.
    const ghostId = await draftWithLine();
    expect((await issue(ghostId)).status).toBe(200);
    await dropStoredFile(ghostId, (snapshot) => ({ ...snapshot, document: withLogo('c'.repeat(64)), logo: null }));
    expect(await images(await pdf(ghostId))).toEqual([]);
    const cancelled = await call(cancelRoute.POST, 'POST', `/api/books/documents/${ghostId}/cancel`, { id: ghostId }, { reason: 'issued in error' });
    expect(cancelled.status).toBe(200);
    expect(await images(await pdf(cancelled.json.creditNote.document.id))).toEqual([]);
  });
});
