// src/server/erasure/__tests__/companyErasure.itest.ts
//
// The company erasure consumer (docs/plans/2026-11-05-company-erasure-consumer.md) against real Postgres,
// through the real app code that writes each kind of row: TWO companies in ONE tenant group, each with a
// published site, CMS rows, a catalogue, Books (an issued invoice with its stored PDF, a logo, an imported
// original being read), a paid shop order with its receipt, a form submission, a mail connection and a
// payment account. Erasing one must delete every row of it in the shared schema and in `public`, and leave
// the other company, its site and the schema untouched.
//
// The tenant schemas here are owned by the test superuser. The erasure runs through a role that is NOT a
// superuser and only a member of that owner, which is exactly the position of `commerce_ddl` in production
// (it owns the schemas, nothing more), so the test proves the delete guards let the owner through and
// nobody else. All data is synthetic.

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import type postgres from 'postgres';
import { tenantSchema } from '@marlinjai/tenant-db';

vi.mock('next/cache', () => ({ unstable_cache: vi.fn(), revalidateTag: vi.fn() }));
import { revalidateTag } from 'next/cache';

import { POST } from '@/app/api/internal/erasure/route';
import { booksScope } from '@/server/books/scope';
import { createDraft } from '@/server/books/repository/documents';
import { addLine } from '@/server/books/repository/lines';
import { issue } from '@/server/books/issue';
import { startCorrection } from '@/server/books/correct';
import { cancelInvoice } from '@/server/books/cancel';
import { storeLogo } from '@/server/books/repository/assets';
import { createTemplate } from '@/server/books/repository/templates';
import { addProductImage } from '@/server/catalog/repository/images';
import { stageUpload } from '@/server/books/upload/service';
import { startExtraction } from '@/server/books/upload/staging';
import { pdfBytes } from '@/server/books/upload/__tests__/fakeAnthropic';
import { makePng } from '@/server/books/__tests__/testImages';
import {
  ACTOR,
  FakeContactBook,
  FakeDirectory,
  initCompany,
  newCustomer,
  openBooksEnv,
  type BooksEnv,
} from '@/server/books/__tests__/booksFixtures';
import { catalogScope } from '@/server/catalog/scope';
import { seedTestShop } from '@/server/catalog/testShop';
import { createPublishedSite } from '@/server/commerce/__tests__/storefrontFixtures';
import { emitCommerceEvent } from '@/server/commerce/jobs/emit';
import { runJobNow } from '@/server/commerce/jobs/run';
import { createOrder } from '@/server/commerce/order/createOrder';
import { catalogRepository } from '@/server/commerce/repository/catalog';
import { pricingRepository } from '@/server/commerce/repository/pricing';
import { handlePaymentEvent, type PaymentDeps } from '@/server/commerce/payment/payments';
import { demoProvider } from '@/server/commerce/payment/provider';
import { ensureReceipt } from '@/server/commerce/payment/receipt';
import { insertFormSubmission, type NewFormSubmission } from '@/server/forms/repository';
import { resolvePublishedSite } from '@/server/sites/publicResolver';
import { cachedDocument, documentEpoch, rememberDocument } from '@/server/sites/liveDocumentCache';
import { endLiveGenerationOfSite, generationSnapshot, openLiveGeneration } from '@/server/sites/liveGeneration';

import { ERASURE_COVERAGE, ERASURE_MIGRATION_ID, eraseCompanyCommerce } from '../commerce';
import { COMMERCE_ERASURE_BATCH_SIZE } from '../commerceSteps';
import { findErasureScope, eraseCompanyPublic } from '../public';
import { ERASURE_GUARDED_TRIGGERS } from '@/server/commerce/migrations/tenant/029_company_erasure';
import { eraseCompany, purgeErasedSiteCaches, type EraseCompanyDeps } from '../eraseCompany';
import { ERASURE_EVENT_ID_HEADER, ERASURE_SIGNATURE_HEADER, signErasureBody } from '../signature';

// Several tests seed a whole company (a site, Books, a paid order) and then visit every tenant schema of the
// shared test database, which takes well over the default minute when the integration suites run in
// parallel.
vi.setConfig({ testTimeout: 180_000 });

const SECRET = `erasure-test-${randomUUID()}`;
const EDITOR = 'app.lumitra.co';

let env: BooksEnv;
/** A login role that is no superuser, only a member of the schemas' owner (as commerce_ddl). */
let ownerRoleUrl = '';
let ownerRole = '';

const seeded = new Map<string, { siteId: string; creditNoteId: string }>();

/** Rows of a company, per covered table (the test's own SQL, independent of the code under test). */
async function countsOf(company: string, workspaces: string[]): Promise<Record<string, number>> {
  const o: postgres.Sql = env.fx.owner;
  const s = tenantSchema(env.tgId);
  const counts: Record<string, number> = {};
  const one = async (label: string, query: postgres.PendingQuery<postgres.Row[]>) => {
    const rows = await query;
    counts[label] = Number(rows[0].n);
  };
  for (const [table, how] of Object.entries(ERASURE_COVERAGE)) {
    if (!how.startsWith('company')) continue;
    await one(table, o`SELECT count(*) AS n FROM ${o(s)}.${o(table)} WHERE "tenant_id" = ${company}`);
  }
  const ws = o.array(workspaces);
  const items = () => o`
    SELECT "id" FROM ${o(s)}."inventory_item"
     WHERE "sku" IN (SELECT "sku" FROM ${o(s)}."product_variant" WHERE "tenant_id" = ${company})`;
  const fixture = seeded.get(company);
  await one('form_submission', o`SELECT count(*) AS n FROM ${o(s)}."form_submission" WHERE "workspace_id" = ANY(${ws}::text[]) OR "site_id" = ${fixture?.siteId ?? ''}`);
  await one('credit_note', o`SELECT count(*) AS n FROM ${o(s)}."credit_note" WHERE "id" = ${fixture?.creditNoteId ?? ''}`);
  await one('credit_note_ref', o`SELECT count(*) AS n FROM ${o(s)}."credit_note_ref" WHERE "credit_note_id" = ${fixture?.creditNoteId ?? ''}`);
  await one(
    'fulfillment_location_default',
    o`SELECT count(*) AS n FROM ${o(s)}."fulfillment_location_default" WHERE "workspace_id" = ANY(${ws}::text[])`,
  );
  await one(
    'reservation',
    o`SELECT count(*) AS n FROM ${o(s)}."reservation"
       WHERE "line_item_id" IN (SELECT "id" FROM ${o(s)}."order_line_item" WHERE "tenant_id" = ${company})`,
  );
  await one('inventory_item', o`SELECT count(*) AS n FROM (${items()}) i`);
  await one('inventory_level', o`SELECT count(*) AS n FROM ${o(s)}."inventory_level" WHERE "inventory_item_id" IN (${items()})`);
  await one('stock_movement', o`SELECT count(*) AS n FROM ${o(s)}."stock_movement" WHERE "inventory_item_id" IN (${items()})`);
  await one('sites', o`SELECT count(*) AS n FROM public.sites WHERE "company_id" = ${company} OR "workspace_id" = ANY(${ws}::text[])`);
  for (const table of ['site_domains', 'site_pages', 'site_revisions', 'site_images', 'site_erasures', 'site_operation_audits', 'agent_runs', 'dt_tables']) {
    await one(table, o`SELECT count(*) AS n FROM public.${o(table)} WHERE "workspace_id" = ANY(${ws}::text[])`);
  }
  await one(
    'dt_rows',
    o`SELECT count(*) AS n FROM public.dt_rows WHERE "table_id" IN (SELECT id FROM public.dt_tables WHERE "workspace_id" = ANY(${ws}::text[]))`,
  );
  return counts;
}

interface Company {
  id: string;
  host: string;
  siteId: string;
  workspaceId: string;
  /** A second workspace of the company, named only by auth-brain's payload, holding a legacy site (company_id NULL). */
  legacyWorkspaceId: string;
  legacySiteId: string;
  logoSha: string;
}

/** A company with one row (at least) in every table this app keeps for a company. */
async function seedCompany(label: string): Promise<Company> {
  const company = randomUUID();
  const { host, siteId, workspaceId } = await createPublishedSite(env.fx, env.tgId, label, company);
  const prisma = env.fx.prisma;

  // public: a custom hostname, a page, a published revision, an image, the erase and operation records, an
  // agent run with a change, a CMS collection with a row and its cells.
  await prisma.siteDomain.create({
    data: { siteId, workspaceId, tenantGroupId: env.tgId, hostname: `www.${label}-${company.slice(0, 8)}.example`, verificationStatus: 'pending' },
  });
  await prisma.sitePage.create({
    data: { siteId, workspaceId, tenantGroupId: env.tgId, pageId: 'about', slug: 'about', snapshot: { id: 'about' } },
  });
  const revision = await prisma.siteRevision.create({
    data: { siteId, workspaceId, tenantGroupId: env.tgId, number: 1, document: { schemaVersion: 1, pages: [{ pageId: 'about', slug: 'about', snapshot: { id: 'about' } }] }, publishedBy: ACTOR },
  });
  await prisma.site.update({ where: { id: siteId }, data: { publishedRevisionId: revision.id } });
  const image = makePng(20, 20);
  await prisma.siteImage.create({
    data: {
      siteId,
      workspaceId,
      tenantGroupId: env.tgId,
      sha256: createHash('sha256').update(image).digest('hex'),
      contentType: 'image/png',
      byteSize: image.byteLength,
      width: 20,
      height: 20,
      uploadedBy: ACTOR,
      content: Buffer.from(image),
    },
  });
  await prisma.siteErasure.create({
    data: { siteId, workspaceId, tenantGroupId: env.tgId, erasedBy: ACTOR, erasedCount: 1, remainingCount: 0, places: [] },
  });
  await prisma.siteOperationAudit.create({
    data: { siteId, workspaceId, tenantGroupId: env.tgId, actorKind: 'user', actorId: ACTOR, operation: 'publish' },
  });
  await prisma.agentRun.create({
    data: {
      collectionId: 'c1',
      workspaceId,
      prompt: 'synthetic',
      model: 'synthetic',
      changes: { create: [{ position: 0, tool: 't', entityType: 'row', inverseTool: 't', inversePayload: {} }] },
    },
  });
  const table = await prisma.dtTable.create({ data: { workspaceId, name: 'Team', columns: { create: [{ name: 'Name', type: 'text', position: 0 }] } }, include: { columns: true } });
  const row = await prisma.dtRow.create({ data: { tableId: table.id, cells: { a: 'Erika Beispiel' }, createdAt: 'now', updatedAt: 'now' } });
  await prisma.dtFile.create({
    data: { rowId: row.id, columnId: table.columns[0].id, fileId: 'f1', fileUrl: 'https://files.example/f1', originalName: 'cv.pdf', mimeType: 'application/pdf' },
  });
  await prisma.selectOption.create({ data: { columnId: table.columns[0].id, name: 'A', position: 0 } });

  // A legacy site of the company: no company_id, found only through a workspace auth-brain names.
  const legacyWorkspaceId = `ws-legacy-${randomUUID().slice(0, 8)}`;
  const legacy = await prisma.site.create({
    data: { workspaceId: legacyWorkspaceId, tenantGroupId: env.tgId, companyId: null, name: 'Legacy', status: 'draft', projectCreatedAt: new Date(), projectUpdatedAt: new Date() },
  });

  // Commerce: the test shop's catalogue (products, options, variants, prices, collections).
  await seedTestShop(catalogScope(env.appDb, env.tgId, company));

  // Books: settings, counters, the default template, a customer, an issued invoice with its stored PDF, a logo,
  // an imported original being read.
  const dir = new FakeDirectory();
  const scope = booksScope(env.appDb, env.tgId, company, { recipients: dir });
  await initCompany(scope, { taxStatus: 'regular', invoiceNext: 1000 });
  const { customer } = await newCustomer(scope, dir);
  const draft = await createDraft(scope, { docType: 'invoice', actorUserId: ACTOR, customerId: customer.id, serviceDate: '2026-10-01' });
  await addLine(scope, draft.document.id, { title: 'Consulting', quantity: 1000, unitPrice: 10000 });
  const issued = await issue(scope, draft.document.id, { actorUserId: ACTOR });
  // The customer's default contact person (030): a column on a table the erasure already reaches by company, so
  // it goes with its row; the value is set here, after the issue (a new draft would copy it and refuse to issue to a person who is not there), so the erasure test proves it is erased, not only absent.
  await env.ownerDb
    .updateTable('customer')
    .set({ default_contact_person_id: randomUUID() })
    .where('tenant_id', '=', company)
    .where('id', '=', customer.id)
    .execute();
  const pdf = Buffer.from(`%PDF-1.7 synthetic ${company}`);
  const fileId = randomUUID();
  await env.ownerDb
    .insertInto('sales_document_file')
    .values({
      id: fileId,
      tenant_id: company,
      document_id: issued.document.document.id,
      content_type: 'application/pdf',
      byte_size: pdf.byteLength,
      sha256: createHash('sha256').update(pdf).digest('hex'),
      renderer: 'test',
      content: pdf,
    })
    .execute();
  await env.ownerDb
    .updateTable('sales_document')
    .set({ rendered_pdf_file_id: fileId, updated_at: new Date() })
    .where('tenant_id', '=', company)
    .where('id', '=', issued.document.document.id)
    .execute();
  // Both kinds of invoice self-reference must be erased from leaves toward their parent.
  await startCorrection(scope, issued.document.document.id, { actorUserId: ACTOR });
  await cancelInvoice(scope, issued.document.document.id, { actorUserId: ACTOR, reason: 'Synthetic correction' });
  // The SAME logo bytes for both companies: content-addressed per company, so erasing one keeps the other's.
  const logo = await storeLogo(scope, makePng(140, 40), 'image/png');
  const staged = await stageUpload(scope, { fileName: `${label}.pdf`, bytes: pdfBytes(`${label}-${company}`) });
  if (staged.status !== 'staged') throw new Error('expected a staged upload');
  await startExtraction(env.appDb, scope, randomUUID(), staged.item.id, 'synthetic-model', new Date());

  // A paid shop order with its receipt: order, line, reservation, stock movement, payment, its provider
  // event, the receipt job and the receipt itself.
  const contacts = new FakeContactBook(dir);
  const deps: PaymentDeps = {
    db: env.appDb,
    tgId: env.tgId,
    provider: () => demoProvider,
    receipt: (orderId) => ensureReceipt(booksScope(env.appDb, env.tgId, company, { recipients: dir }), contacts, orderId, { now: new Date() }),
    emit: (trx, event) => emitCommerceEvent(trx, event),
    now: () => new Date(),
  };
  const product = await catalogRepository.createProduct(env.ownerDb, { tenantId: company, title: 'Ring', handle: `ring-${randomUUID().slice(0, 8)}`, status: 'published' });
  const sku = `RING-${randomUUID()}`;
  const variant = await catalogRepository.addVariant(env.ownerDb, { tenantId: company, productId: product.id, sku, title: 'Silber' });
  const priceSet = await pricingRepository.createPriceSet(env.ownerDb, { tenantId: company, variantId: variant.id });
  await pricingRepository.addPrice(env.ownerDb, { tenantId: company, priceSetId: priceSet.id, currency: 'EUR', amount: 4900 });
  // A product image (its bytes in catalog_image), the product hidden on the site, a Books template with its
  // version, and a row of the retired Books product list.
  await addProductImage(catalogScope(env.appDb, env.tgId, company), product.id, makePng(30, 30));
  await env.ownerDb.insertInto('product_site_hidden').values({ tenant_id: company, product_id: product.id, site_id: siteId }).execute();
  await createTemplate(scope, { name: `Vorlage ${label}` });
  await env.ownerDb
    .insertInto('books_product')
    .values({ id: randomUUID(), tenant_id: company, name: 'Beratung', name_key: 'beratung', description: null, search_text: 'beratung', unit_price: 9000, archived_at: null, updated_at: new Date() })
    .execute();

  const item = randomUUID();
  const location = randomUUID();
  await env.ownerDb.insertInto('inventory_item').values({ id: item, sku, updated_at: new Date() }).execute();
  await env.ownerDb.insertInto('stock_location').values({ id: location, name: `WH-${location}`, updated_at: new Date() }).execute();
  await env.ownerDb
    .insertInto('inventory_level')
    .values({ id: randomUUID(), inventory_item_id: item, location_id: location, stocked_quantity: 5, reserved_quantity: 0, updated_at: new Date() })
    .execute();
  await env.ownerDb.insertInto('stock_movement').values({ id: randomUUID(), inventory_item_id: item, location_id: location, movement_type: 'receive', quantity: 5, request_id: `rq-${randomUUID()}` }).execute();
  await env.ownerDb.insertInto('fulfillment_location_default').values({ workspace_id: workspaceId, location_id: location, updated_at: new Date() }).execute();
  const order = await createOrder(env.appDb, env.tgId, {
    tenantId: company,
    siteId,
    requestId: `rq-${randomUUID()}`,
    currency: 'EUR',
    taxRegion: 'DE',
    netOrGross: 'gross',
    now: new Date(),
    lines: [{ inventoryItemId: item, variantId: variant.id, quantity: 1, locationId: location, variantRef: variant.id, variantRefSource: 'owned' }],
    payment: {
      provider: 'stripe',
      buyer: { kind: 'person', name: 'Alex Example', email: 'alex@example.com', addressLine1: 'Beispielweg 2', postalCode: '20095', city: 'Hamburg', country: 'DE' } as never,
    },
  });
  if (!order.ok) throw new Error('the order was short');
  const creditNoteId = randomUUID();
  await env.ownerDb.insertInto('credit_note').values({
    id: creditNoteId, order_id: order.orderId, corrected_ref: null, reason: 'Synthetic correction', currency_code: 'EUR', amount: 100,
  }).execute();
  await env.ownerDb.insertInto('credit_note_ref').values({
    id: randomUUID(), credit_note_id: creditNoteId, ref_type: 'order', ref_id: order.orderId,
  }).execute();
  seeded.set(company, { siteId, creditNoteId });
  const paid = await handlePaymentEvent(deps, {
    provider: 'stripe',
    eventId: `evt-${randomUUID()}`,
    type: 'payment_succeeded',
    tenantId: company,
    orderId: order.orderId,
    providerPaymentId: `demo_pi_${order.orderId}`,
  });
  for (const jobId of paid.jobIds ?? []) {
    await runJobNow({ id: env.tgId, db: env.appDb }, company, jobId, { paymentDeps: () => deps, now: () => new Date() });
  }

  // A form submission on the site, the shop's mail connection and its payment account.
  const submission: NewFormSubmission = {
    id: randomUUID(),
    tenantId: env.tgId,
    workspaceId,
    siteId,
    pageId: 'home',
    pagePath: '/',
    formId: 'contact',
    formName: 'Kontakt',
    fields: [{ key: 'email', label: 'E-Mail', type: 'email', value: 'visitor@example.com' }] as never,
  };
  await insertFormSubmission(env.appDb, submission);
  await insertFormSubmission(env.appDb, { ...submission, id: randomUUID(), workspaceId: `outside-${company}` });
  await env.ownerDb
    .insertInto('shop_mail_connection')
    .values({
      tenant_id: company,
      workspace_id: `mail-ws-${company.slice(0, 8)}`,
      workspace_name: 'Shop',
      provider_id: 'provider',
      sender: 'shop@example.com',
      api_key_id: 'key-id',
      api_key_sealed: 'v1:sealed-placeholder',
      template_ids: sql`'{}'::jsonb` as never,
      templates_version: 'v1',
      connected_by: ACTOR,
      updated_at: new Date(),
    })
    .execute();
  await env.ownerDb
    .insertInto('shop_mail')
    .values({ tenant_id: company, order_id: order.orderId, kind: 'order_confirmation', next_attempt_at: new Date(), last_error: null, mailing_id: null, letter: null, updated_at: new Date() })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await env.ownerDb
    .insertInto('payment_account')
    .values({ tenant_id: company, provider: 'stripe', account_id: `acct_${company.slice(0, 8)}`, updated_at: new Date() })
    .execute();

  return { id: company, host, siteId, workspaceId, legacyWorkspaceId, legacySiteId: legacy.id, logoSha: logo.asset.sha256 };
}

function prodLikeDeps(): EraseCompanyDeps {
  return {
    prisma: env.fx.prisma,
    eraseCommerce: (scope) => eraseCompanyCommerce(ownerRoleUrl, scope),
    purgeCaches: purgeErasedSiteCaches,
  };
}

let a: Company;
let b: Company;

beforeAll(async () => {
  env = await openBooksEnv('erasure');
  const [{ me }] = await env.fx.owner<{ me: string }[]>`SELECT current_user AS me`;
  ownerRole = `erasure_owner_${randomUUID().slice(0, 8)}`;
  await env.fx.owner`CREATE ROLE ${env.fx.owner(ownerRole)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE`;
  await env.fx.owner`GRANT ${env.fx.owner(me)} TO ${env.fx.owner(ownerRole)}`;
  const url = new URL(process.env.DATABASE_URL!);
  url.username = ownerRole;
  url.password = '';
  ownerRoleUrl = url.toString();
  a = await seedCompany('erase-a');
  b = await seedCompany('erase-b');
}, 240_000);

afterAll(async () => {
  // Leave nothing of this suite in the shared database for the suites that read across all sites.
  if (b) await eraseCompany({ eventId: randomUUID(), companyId: b.id, workspaceIds: [b.legacyWorkspaceId] }, prodLikeDeps());
  await env?.close();
});

beforeEach(() => {
  vi.mocked(revalidateTag).mockClear();
});

describe('the erasure covers the schema', () => {
  it('every table of a provisioned tenant schema is named in ERASURE_COVERAGE, and nothing else is', async () => {
    const rows = await env.fx.owner<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = ${tenantSchema(env.tgId)} AND table_type = 'BASE TABLE'`;
    expect(rows.map((r) => r.table_name).sort()).toEqual(Object.keys(ERASURE_COVERAGE).sort());
  });

  it('every row trigger that fires on DELETE lets the erasure through, or is harmless', async () => {
    // Recomputes a variant's option signature after an option row goes: no refusal, nothing to bypass.
    const harmless = new Set(['product_variant_option_signature_matrix']);
    const rows = await env.fx.owner<{ tgname: string; def: string }[]>`
      SELECT t.tgname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE c.relnamespace = ${tenantSchema(env.tgId)}::regnamespace AND NOT t.tgisinternal
         AND (t.tgtype & 1) = 1 AND (t.tgtype & 8) = 8`;
    const unguarded = rows.filter((r) => !harmless.has(r.tgname) && !r.def.includes('company_erasure_allows(old.tenant_id)'));
    expect(unguarded.map((r) => r.tgname)).toEqual([]);
    expect(rows.length).toBe(ERASURE_GUARDED_TRIGGERS.length + harmless.size);
  });
});

describe('erasing one company of a shared tenant group', () => {
  it('deletes every row and file of the erased company and leaves the other company and the schema alone', async () => {
    const workspacesA = [a.workspaceId, a.legacyWorkspaceId];
    const before = await countsOf(a.id, workspacesA);
    const beforeB = await countsOf(b.id, [b.workspaceId, b.legacyWorkspaceId]);
    // The fixture really reaches every kind of row (else the test proves less than it claims).
    const empty = Object.entries(before).filter(([, n]) => n === 0).map(([t]) => t);
    expect(empty).toEqual([]);
    expect(await resolvePublishedSite(a.host, env.fx.prisma)).not.toBeNull();
    // An open editor's document route kept each company's copy in this process.
    const scopeA = { workspaceId: a.workspaceId, tenantGroupId: env.tgId };
    const scopeB = { workspaceId: b.workspaceId, tenantGroupId: env.tgId };
    rememberDocument(scopeA, a.siteId, 1, '{"of":"a"}', documentEpoch());
    rememberDocument(scopeB, b.siteId, 1, '{"of":"b"}', documentEpoch());
    // And a generation runs on each company's site.
    openLiveGeneration(a.siteId, scopeA, 'run-a', { kind: 'newPage' });
    openLiveGeneration(b.siteId, scopeB, 'run-b', { kind: 'newPage' });

    const outcome = await eraseCompany({ eventId: randomUUID(), companyId: a.id, workspaceIds: [a.legacyWorkspaceId] }, prodLikeDeps());
    // Only the group's schema held anything of the company: the other suites' schemas were read, never locked.
    expect(outcome).toMatchObject({ status: 'erased', servedHere: true, commerce: { erasedIn: 1 } });

    const after = await countsOf(a.id, workspacesA);
    expect(Object.entries(after).filter(([, n]) => n !== 0)).toEqual([]);
    expect(await countsOf(b.id, [b.workspaceId, b.legacyWorkspaceId])).toEqual(beforeB);
    // The erased company's kept copy is gone from memory too; the other company's stays.
    expect(cachedDocument(scopeA, a.siteId, 1)).toBeUndefined();
    expect(cachedDocument(scopeB, b.siteId, 1)).toBe('{"of":"b"}');
    expect(generationSnapshot(a.siteId, scopeA)).toBeUndefined();
    expect(generationSnapshot(b.siteId, scopeB)).toBeDefined();
    endLiveGenerationOfSite(b.siteId, 'stopped');

    // The published site is gone (its host resolves to nothing, so it answers 404) and its caches were
    // invalidated; the other company's site still resolves. The schema stays.
    expect(await resolvePublishedSite(a.host, env.fx.prisma)).toBeNull();
    expect(await resolvePublishedSite(b.host, env.fx.prisma)).not.toBeNull();
    const tags = vi.mocked(revalidateTag).mock.calls.map((c) => c[0]);
    expect(tags).toEqual(expect.arrayContaining([expect.stringContaining(a.host.split('.')[0])]));
    const [{ exists }] = await env.fx.owner<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = ${tenantSchema(env.tgId)}) AS exists`;
    expect(exists).toBe(true);
    // The same logo bytes stay stored for the other company.
    expect(await env.ownerDb.selectFrom('books_asset').select('sha256').where('tenant_id', '=', b.id).where('sha256', '=', b.logoSha).execute()).toHaveLength(1);
    expect(b.logoSha).toBe(a.logoSha);
  });

  it('a repeated delivery of the same event deletes nothing again', async () => {
    const eventId = randomUUID();
    const fresh = await seedCompany('erase-c');
    expect((await eraseCompany({ eventId, companyId: fresh.id, workspaceIds: [fresh.legacyWorkspaceId] }, prodLikeDeps())).status).toBe('erased');
    const beforeB = await countsOf(b.id, [b.workspaceId]);
    const eraseCommerce = vi.fn();
    expect(await eraseCompany({ eventId, companyId: fresh.id, workspaceIds: [fresh.legacyWorkspaceId] }, { ...prodLikeDeps(), eraseCommerce })).toEqual({
      status: 'already_processed',
    });
    expect(eraseCommerce).not.toHaveBeenCalled();
    expect(await countsOf(b.id, [b.workspaceId])).toEqual(beforeB);
  });

  it('a retry after a failure in the tenant schemas finishes the job with the scope the first attempt stored', async () => {
    const eventId = randomUUID();
    const c = await seedCompany('erase-d');
    const failing = vi.fn().mockRejectedValue(new Error('synthetic outage'));
    await expect(eraseCompany({ eventId, companyId: c.id, workspaceIds: [c.legacyWorkspaceId] }, { ...prodLikeDeps(), eraseCommerce: failing })).rejects.toThrow('synthetic outage');
    // The site rows are already gone, the form submission (found through the site) is not yet.
    expect((await countsOf(c.id, [c.workspaceId])).sites).toBe(0);
    expect((await countsOf(c.id, [c.workspaceId])).form_submission).toBe(2);
    const ledger = await env.fx.prisma.erasureEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(ledger.processedAt).toBeNull();

    expect(await eraseCompany({ eventId, companyId: c.id, workspaceIds: [c.legacyWorkspaceId] }, prodLikeDeps())).toMatchObject({ status: 'erased' });
    const after = await countsOf(c.id, [c.workspaceId]);
    expect(Object.entries(after).filter(([, n]) => n !== 0)).toEqual([]);
    expect((await env.fx.prisma.erasureEvent.findUniqueOrThrow({ where: { id: eventId } })).attempts).toBe(2);
  });

  it('rejects reuse of a processed event for a different company', async () => {
    const eventId = randomUUID();
    await eraseCompany({ eventId, companyId: randomUUID(), workspaceIds: [] }, prodLikeDeps());
    await expect(eraseCompany({ eventId, companyId: b.id, workspaceIds: [] }, prodLikeDeps())).rejects.toThrow('another company');
  });

  it('a late overlapping delivery cannot restore hostnames to a completed ledger', async () => {
    const c = await seedCompany('erase-overlap');
    const erasure = { eventId: randomUUID(), companyId: c.id, workspaceIds: [c.legacyWorkspaceId] };
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const delayed = eraseCompany(erasure, { ...prodLikeDeps(), purgeCaches: async () => { reached(); await barrier; throw new Error('late failure'); } });
    const failure = expect(delayed).rejects.toThrow('late failure');
    try {
      await waiting;
      await eraseCompany(erasure, prodLikeDeps());
    } finally { release(); }
    await failure;
    const ledger = await env.fx.prisma.erasureEvent.findUniqueOrThrow({ where: { id: erasure.eventId } });
    expect(ledger.processedAt).not.toBeNull();
    expect(ledger.scope).toEqual({ siteIds: expect.arrayContaining([c.siteId]), workspaceIds: expect.arrayContaining([c.workspaceId]) });
    expect(await eraseCompany(erasure, prodLikeDeps())).toEqual({ status: 'already_processed' });
  });

  it('captures domains committed after initial discovery and keeps them for a failed attempt retry', async () => {
    const c = await createPublishedSite(env.fx, env.tgId, 'late-domain', randomUUID());
    const companyId = (await env.fx.prisma.site.findUniqueOrThrow({ where: { id: c.siteId } })).companyId!;
    const scope = await findErasureScope(env.fx.prisma, companyId, [c.workspaceId]);
    const eventId = randomUUID();
    await env.fx.prisma.erasureEvent.create({ data: { id: eventId, tenantId: companyId, kind: 'tenant.erased', scope: { ...scope } } });
    const hostname = `late-${randomUUID()}.example`;
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const domainWriter = env.fx.prisma.$transaction(async (tx) => {
      await tx.siteDomain.create({ data: { siteId: c.siteId, workspaceId: c.workspaceId, tenantGroupId: env.tgId, hostname } });
      reached();
      await barrier;
    }, { timeout: 120_000 });
    await waiting;
    const erasing = eraseCompanyPublic(env.fx.prisma, scope, eventId);
    try {
      await vi.waitFor(async () => {
        const [lock] = await env.fx.owner<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND query LIKE '%public.sites%' AND query LIKE '%FOR UPDATE%') AS waiting`;
        expect(lock.waiting).toBe(true);
      }, { timeout: 10_000 });
    } finally { release(); }
    await domainWriter;
    const result = await erasing;
    expect(result?.scope.hostnames).toContain(hostname);
    const ledger = await env.fx.prisma.erasureEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(ledger.scope).toMatchObject({ hostnames: expect.arrayContaining([hostname]) });
    const purgeCaches = vi.fn().mockResolvedValue(undefined);
    await eraseCompany({ eventId, companyId, workspaceIds: [c.workspaceId] }, { ...prodLikeDeps(), purgeCaches });
    expect(purgeCaches).toHaveBeenCalledWith(expect.objectContaining({ hostnames: expect.arrayContaining([hostname]) }));
  });

  it('refuses a form request that resolved its site before deletion', async () => {
    const c = await createPublishedSite(env.fx, env.tgId, 'late-form', randomUUID());
    const companyId = (await env.fx.prisma.site.findUniqueOrThrow({ where: { id: c.siteId } })).companyId!;
    await eraseCompany({ eventId: randomUUID(), companyId, workspaceIds: [c.workspaceId] }, prodLikeDeps());
    await expect(insertFormSubmission(env.appDb, {
      id: randomUUID(), tenantId: env.tgId, workspaceId: c.workspaceId, siteId: c.siteId,
      pageId: 'home', pagePath: '/', formId: 'contact', formName: 'Contact', fields: [],
    })).rejects.toThrow('no longer accepts');
  });

  it('waits for a form writer that checked the site before public deletion, even when the schema probe would be empty', async () => {
    const c = await createPublishedSite(env.fx, env.tgId, 'inflight-form', randomUUID());
    const companyId = (await env.fx.prisma.site.findUniqueOrThrow({ where: { id: c.siteId } })).companyId!;
    const id = randomUUID();
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const original = env.fx.prisma.site.findFirst.bind(env.fx.prisma.site);
    const spy = vi.spyOn(env.fx.prisma.site, 'findFirst').mockImplementationOnce((args) => (async () => {
      const site = await original(args);
      reached();
      await barrier;
      return site;
    })() as unknown as ReturnType<typeof original>);
    const writer = insertFormSubmission(env.appDb, { id, tenantId: env.tgId, workspaceId: c.workspaceId, siteId: c.siteId,
      pageId: 'home', pagePath: '/', formId: 'contact', formName: 'Contact', fields: [], }, env.fx.prisma);
    await waiting;
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const erasing = eraseCompany({ eventId: randomUUID(), companyId, workspaceIds: [c.workspaceId] }, {
      ...prodLikeDeps(), eraseCommerce: async (scope) => { cleanupStarted(); return eraseCompanyCommerce(ownerRoleUrl, scope); },
    });
    try {
      await started;
      // Public deletion has committed, while the form writer still holds its transaction lock.
      expect(await env.fx.prisma.site.findUnique({ where: { id: c.siteId } })).toBeNull();
      await vi.waitFor(async () => {
        const [lock] = await env.fx.owner<{ waiting: boolean }[]>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE application_name = 'framer-clone-commerce-owner' AND wait_event_type = 'Lock'
              AND query LIKE '%pg_advisory_xact_lock(hashtextextended%') AS waiting`;
        expect(lock.waiting).toBe(true);
      }, { timeout: 10_000 });
    } finally { release(); spy.mockRestore(); }
    expect(await writer).toBe(true);
    await erasing;
    expect(await env.ownerDb.selectFrom('form_submission').select('id').where('id', '=', id).execute()).toEqual([]);
  });

  it('commits bounded commerce batches and resumes after a later batch fails', async () => {
    const c = await createPublishedSite(env.fx, env.tgId, 'batch-form', randomUUID());
    const companyId = (await env.fx.prisma.site.findUniqueOrThrow({ where: { id: c.siteId } })).companyId!;
    const eventId = randomUUID();
    const schema = tenantSchema(env.tgId);
    const owner = env.fx.owner;
    await owner`INSERT INTO ${owner(schema)}.form_submission
      (id, tenant_id, workspace_id, site_id, page_id, page_path, form_id, form_name, fields)
      SELECT ${eventId} || '-' || i, ${env.tgId}, ${c.workspaceId}, ${c.siteId}, 'home', '/', 'contact', 'Contact', '[]'::jsonb
      FROM generate_series(1, ${COMMERCE_ERASURE_BATCH_SIZE + 1}) i`;
    await owner`CREATE FUNCTION ${owner(schema)}.fail_last_form_batch() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE remaining bigint;
      BEGIN
        EXECUTE format('SELECT count(*) FROM %I.%I WHERE site_id = $1', TG_TABLE_SCHEMA, 'form_submission')
          INTO remaining USING OLD.site_id;
        IF remaining = 1 THEN RAISE EXCEPTION 'synthetic batch failure'; END IF;
        RETURN OLD;
      END $$`;
    await owner`CREATE TRIGGER fail_last_form_batch BEFORE DELETE ON ${owner(schema)}.form_submission
      FOR EACH ROW EXECUTE FUNCTION ${owner(schema)}.fail_last_form_batch()`;
    try {
      await expect(eraseCompany({ eventId, companyId, workspaceIds: [c.workspaceId] }, prodLikeDeps())).rejects.toThrow('synthetic batch failure');
      expect(await env.ownerDb.selectFrom('form_submission').select('id').where('site_id', '=', c.siteId).execute()).toHaveLength(1);
    } finally {
      await owner`DROP TRIGGER fail_last_form_batch ON ${owner(schema)}.form_submission`;
      await owner`DROP FUNCTION ${owner(schema)}.fail_last_form_batch()`;
    }
    await eraseCompany({ eventId, companyId, workspaceIds: [c.workspaceId] }, prodLikeDeps());
    expect(await env.ownerDb.selectFrom('form_submission').select('id').where('site_id', '=', c.siteId).execute()).toEqual([]);
  });

  it('a company never served here is a successful no-op', async () => {
    const outcome = await eraseCompany({ eventId: randomUUID(), companyId: randomUUID(), workspaceIds: [] }, prodLikeDeps());
    expect(outcome).toMatchObject({ status: 'erased', servedHere: false });
  });
});

describe('the bypass is the owner’s alone', () => {
  it('the app role naming the company in the setting still cannot delete an issued invoice', async () => {
    const [doc] = await env.ownerDb.selectFrom('sales_document').select('id').where('tenant_id', '=', b.id).where('status', '<>', 'draft').execute();
    expect(doc).toBeDefined();
    await expect(
      env.appDb.transaction().execute(async (trx) => {
        await sql`SELECT set_config('lumitra.erasing_company', ${b.id}, true)`.execute(trx);
        await trx.deleteFrom('sales_document_line').where('tenant_id', '=', b.id).where('document_id', '=', doc.id).execute();
      }),
    ).rejects.toThrow();
    await expect(
      env.appDb.transaction().execute(async (trx) => {
        await sql`SELECT set_config('lumitra.erasing_company', ${b.id}, true)`.execute(trx);
        await trx.deleteFrom('sales_document').where('tenant_id', '=', b.id).where('id', '=', doc.id).execute();
      }),
    ).rejects.toThrow();
    expect(await env.ownerDb.selectFrom('sales_document').select('id').where('id', '=', doc.id).execute()).toHaveLength(1);
  });

  it('the owner without the setting is refused as before', async () => {
    const [doc] = await env.ownerDb.selectFrom('sales_document').select('id').where('tenant_id', '=', b.id).where('status', '<>', 'draft').execute();
    await expect(env.ownerDb.deleteFrom('sales_document').where('tenant_id', '=', b.id).where('id', '=', doc.id).execute()).rejects.toThrow(
      /cannot be deleted/,
    );
  });

  it('a schema without the migration is refused loudly, never half erased', async () => {
    const s = tenantSchema(env.tgId);
    await env.fx.owner`DELETE FROM ${env.fx.owner(s)}."__tenant_db_migrations" WHERE "id" = ${ERASURE_MIGRATION_ID}`;
    try {
      await expect(eraseCompanyCommerce(ownerRoleUrl, { companyId: b.id, workspaceIds: [], siteIds: [] })).rejects.toThrow(/lacks migration/);
    } finally {
      await env.fx.owner`INSERT INTO ${env.fx.owner(s)}."__tenant_db_migrations" ("id") VALUES (${ERASURE_MIGRATION_ID})`;
    }
    expect((await countsOf(b.id, [b.workspaceId])).sales_document).toBeGreaterThan(0);
  });
});

describe('POST /api/internal/erasure', () => {
  function delivery(body: Record<string, unknown>, opts: { secret?: string; host?: string; signature?: string } = {}) {
    const raw = JSON.stringify(body);
    return new Request(`https://${opts.host ?? EDITOR}/api/internal/erasure`, {
      method: 'POST',
      headers: {
        host: opts.host ?? EDITOR,
        'content-type': 'application/json',
        [ERASURE_SIGNATURE_HEADER]: opts.signature ?? signErasureBody(raw, opts.secret ?? SECRET),
        [ERASURE_EVENT_ID_HEADER]: String(body.event_id),
      },
      body: raw,
    });
  }
  const tenantErased = (tenantId: string, extra: Record<string, unknown> = {}) => ({
    event_id: randomUUID(),
    kind: 'tenant.erased',
    user_id: randomUUID(),
    tenant_id: tenantId,
    workspace_ids: [],
    requested_at: new Date().toISOString(),
    ...extra,
  });

  beforeEach(() => {
    vi.stubEnv('EDITOR_HOST', EDITOR);
    vi.stubEnv('SITES_ERASURE_WEBHOOK_SECRET', SECRET);
    vi.stubEnv('COMMERCE_OWNER_DATABASE_URL', ownerRoleUrl);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('answers 503 and deletes nothing while the secret is not set', async () => {
    vi.stubEnv('SITES_ERASURE_WEBHOOK_SECRET', '');
    const res = await POST(delivery(tenantErased(b.id)));
    expect(res.status).toBe(503);
    expect((await countsOf(b.id, [b.workspaceId])).sites).toBe(1);
  });

  it('answers 401 and deletes nothing for a missing or wrong signature', async () => {
    expect((await POST(delivery(tenantErased(b.id), { secret: 'another-secret' }))).status).toBe(401);
    expect((await POST(delivery(tenantErased(b.id), { signature: 'sha256=' }))).status).toBe(401);
    expect((await POST(delivery(tenantErased(b.id), { signature: '' }))).status).toBe(401);
    expect((await countsOf(b.id, [b.workspaceId])).sites).toBe(1);
  });

  it('answers 404 on a published host', async () => {
    expect((await POST(delivery(tenantErased(b.id), { host: b.host }))).status).toBe(404);
  });

  it('answers 400 for a signed body that is not an erasure', async () => {
    expect((await POST(delivery({ event_id: randomUUID(), kind: 'tenant.erased', user_id: 'u', requested_at: 'x' }))).status).toBe(400);
  });

  it('acknowledges user.erased without deleting anything', async () => {
    const res = await POST(delivery({ event_id: randomUUID(), kind: 'user.erased', user_id: randomUUID(), requested_at: new Date().toISOString() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ignored: expect.stringContaining('user.erased') });
  });

  it('answers retryable 503 without acknowledging a delivery that omits the workspace list', async () => {
    const body = tenantErased(b.id, { workspace_ids: undefined });
    const response = await POST(delivery(body));
    expect(response.status).toBe(503);
    expect(await env.fx.prisma.erasureEvent.findUnique({ where: { id: body.event_id } })).toBeNull();
    expect(await env.fx.prisma.site.findUnique({ where: { id: b.legacySiteId } })).not.toBeNull();
  });

  it('acknowledges a company never served here, and a replay of the same event', async () => {
    const body = tenantErased(randomUUID(), { workspace_ids: [] });
    const first = await POST(delivery(body));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, servedHere: false });
    const again = await POST(delivery(body));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, alreadyProcessed: true });
  });

  it('erases a served company end to end and its published host stops resolving', async () => {
    const c = await seedCompany('erase-route');
    const res = await POST(delivery(tenantErased(c.id, { workspace_ids: [c.workspaceId, c.legacyWorkspaceId] })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, servedHere: true });
    expect(await resolvePublishedSite(c.host, env.fx.prisma)).toBeNull();
    const after = await countsOf(c.id, [c.workspaceId]);
    expect(Object.entries(after).filter(([, n]) => n !== 0)).toEqual([]);
  });

  it('answers 500 when the tenant schemas cannot be reached, so auth-brain retries', async () => {
    vi.stubEnv('COMMERCE_OWNER_DATABASE_URL', '');
    const res = await POST(delivery(tenantErased(randomUUID())));
    expect(res.status).toBe(500);
  });
});
