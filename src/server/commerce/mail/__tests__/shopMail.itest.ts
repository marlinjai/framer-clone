// src/server/commerce/mail/__tests__/shopMail.itest.ts
//
// The shop's receipt email (docs/plans/2026-10-27-shop-receipt-email.md) as a job consumer (shop backbone slice B5), against
// real Postgres, with a fake Lumitra Mail and the same payment handler a webhook uses. The four paths of the stateful-flow
// standard:
//
//   1. forward: connect a workspace of the shop's company, pay an order, the receipt's event writes the letter and its job
//      together, the job sends the buyer's confirmation once, with the order, the total in German and a signed link that
//      serves exactly that receipt;
//   2. backtrack: a workspace of another company, a role too low or an unknown sender is refused and nothing is stored; an
//      install that fails takes its new key back; reconnecting revokes the old key; disconnecting revokes the key first
//      and keeps the connection when Lumitra Mail cannot be reached; a shop that is not connected writes neither letter
//      nor job;
//   3. resume: Lumitra Mail down, the job waits and sends the letter when due, unchanged even when the site changed
//      meanwhile; a letter the old build wrote (a row with no job) is given its job by the backfill; a repeated webhook or
//      two overlapping attempts send one letter;
//   4. re-entry: a refusal ends a letter as failed (shown to the owner) and its job dead, a blocked address as blocked and
//      the job done, three days of failures end it as failed; a reconnect to another workspace builds the letter again
//      there; a late payment refunded sends the refund notice.
// All data is synthetic.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { catalogRepository } from '../../repository/catalog';
import { pricingRepository } from '../../repository/pricing';
import { createOrder } from '../../order/createOrder';
import { emitCommerceEvent } from '../../jobs/emit';
import { runJobNow, type JobRunOptions } from '../../jobs/run';
import { runJobBackfills } from '../../jobs/backfills';
import { handlePaymentEvent, sweepExpiredPayments, type PaymentDeps } from '../../payment/payments';
import { demoProvider, type PaymentEvent } from '../../payment/provider';
import { ensureReceipt } from '../../payment/receipt';
import type { BuyerInput } from '../../payment/buyer';
import { booksScope } from '@/server/books/scope';
import { FakeContactBook, FakeDirectory, initCompany, openBooksEnv, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { ConnectRefused, connectShopMail, disconnectShopMail, readConnection } from '../connection';
import { MailRefused, MailRetryLater } from '../lumitraMail';
import { deliverShopMail, enqueueShopMail, type OutboxDeps } from '../outbox';
import { JobRetryLater } from '../../jobs/types';
import { readReceiptToken } from '../receiptLink';
import { serveReceipt } from '../receiptRoute';
import { mailConnect, mailStatus } from '../ownerHandlers';
import { unseal } from '../seal';
import { fakeMail, type FakeMail } from './support';

const BUYER: BuyerInput = {
  kind: 'person',
  name: 'Alex Example',
  email: 'alex@example.com',
  addressLine1: 'Beispielweg 2',
  postalCode: '20095',
  city: 'Hamburg',
  country: 'DE',
};
const OWNER = 'owner-subject';
const SEAL_KEY = randomBytes(32);
const LINK_KEY = randomBytes(32);

let env: BooksEnv;

beforeAll(async () => {
  env = await openBooksEnv('shopmail');
}, 120_000);

afterAll(async () => {
  await env?.close();
});

interface Shop {
  company: string;
  workspaceId: string;
  providerId: string;
  mail: FakeMail;
  clock: { now: Date };
  site: { name: string; language: string };
  outbox: OutboxDeps;
  deps: PaymentDeps;
}

let shop: Shop;

function newShop(): Shop {
  const company = randomUUID();
  const workspaceId = randomUUID();
  const providerId = randomUUID();
  const dir = new FakeDirectory();
  const contacts = new FakeContactBook(dir);
  const scope = booksScope(env.appDb, env.tgId, company, { recipients: dir });
  const clock = { now: new Date('2026-10-27T09:30:00Z') };
  const site = { name: 'Schmuck Testshop', language: 'de' };
  const mail = fakeMail({
    workspaces: [
      { id: workspaceId, name: 'Schmuck', role: 'owner', companyId: company, locales: ['de'] },
      { id: randomUUID(), name: 'Someone else', role: 'owner', companyId: randomUUID(), locales: ['en'] },
    ],
    senders: { [workspaceId]: [{ id: providerId, label: 'Schmuck Testshop <shop@testshop.example>' }] },
  });
  const outbox: OutboxDeps = {
    db: env.appDb,
    tenantGroupId: env.tgId,
    mail,
    sealKey: SEAL_KEY,
    linkKey: LINK_KEY,
    linkBase: 'https://app.example',
    siteInfo: async () => ({ ...site }),
    now: () => clock.now,
  };
  const deps: PaymentDeps = {
    db: env.appDb,
    tgId: env.tgId,
    provider: () => demoProvider,
    receipt: (orderId) => ensureReceipt(scope, contacts, orderId, { now: clock.now }),
    emit: (trx, event) => emitCommerceEvent(trx, event),
    now: () => clock.now,
  };
  return { company, workspaceId, providerId, mail, clock, site, outbox, deps };
}

beforeEach(async () => {
  shop = newShop();
  await initCompany(booksScope(env.appDb, env.tgId, shop.company, { recipients: new FakeDirectory() }), { taxStatus: 'regular', invoiceNext: 1 });
});

async function connect(attempt = `attempt-${randomUUID()}`) {
  return connectShopMail(env.appDb, shop.mail, SEAL_KEY, {
    subject: OWNER,
    companyId: shop.company,
    workspaceId: shop.workspaceId,
    providerId: shop.providerId,
    attempt,
    now: shop.clock.now,
  });
}

async function stockedRing(stock: number, priceCents = 4900) {
  const db = env.ownerDb;
  const p = await catalogRepository.createProduct(db, { tenantId: shop.company, title: 'Ring', handle: `ring-${randomUUID().slice(0, 8)}`, status: 'published' });
  const sku = `RING-${randomUUID()}`;
  const v = await catalogRepository.addVariant(db, { tenantId: shop.company, productId: p.id, sku, title: 'Silber' });
  const set = await pricingRepository.createPriceSet(db, { tenantId: shop.company, variantId: v.id });
  await pricingRepository.addPrice(db, { tenantId: shop.company, priceSetId: set.id, currency: 'EUR', amount: priceCents });
  const item = randomUUID();
  const location = randomUUID();
  await db.insertInto('inventory_item').values({ id: item, sku, updated_at: new Date() }).execute();
  await db.insertInto('stock_location').values({ id: location, name: `WH-${location}`, updated_at: new Date() }).execute();
  await db
    .insertInto('inventory_level')
    .values({ id: randomUUID(), inventory_item_id: item, location_id: location, stocked_quantity: stock, reserved_quantity: 0, updated_at: new Date() })
    .execute();
  return { variantId: v.id, item, location };
}

async function placeOrder(ring: Awaited<ReturnType<typeof stockedRing>>) {
  const result = await createOrder(env.appDb, env.tgId, {
    tenantId: shop.company,
    siteId: 'site-shop',
    requestId: `rq-${randomUUID()}`,
    currency: 'EUR',
    taxRegion: 'DE',
    netOrGross: 'gross',
    now: shop.clock.now,
    lines: [{ inventoryItemId: ring.item, variantId: ring.variantId, quantity: 1, locationId: ring.location, variantRef: ring.variantId, variantRefSource: 'owned' }],
    // A Stripe payment: these companies are not the demo company, whose demo payments alone owe an invoice (demoCheckout.ts).
    payment: { provider: 'stripe', buyer: BUYER as never },
  });
  if (!result.ok) throw new Error('the order was short');
  return result.orderId;
}

/** The worker's wiring of this shop: its payments and its Lumitra Mail, on the test clock. */
function worker(deps: PaymentDeps = shop.deps, outbox: OutboxDeps = shop.outbox): JobRunOptions {
  return { paymentDeps: () => deps, mailDeps: () => outbox, now: () => shop.clock.now };
}

/** Run every `shop_mail` job that is due on the test clock, as the poller would. Answers how many ran. */
async function drainMail(outbox: OutboxDeps = shop.outbox): Promise<number> {
  const due = await env.ownerDb
    .selectFrom('commerce_job')
    .select('id')
    .where('tenant_id', '=', shop.company)
    .where('kind', '=', 'shop_mail')
    .where('status', '=', 'pending')
    .where('run_at', '<=', shop.clock.now)
    .execute();
  for (const job of due) await runJobNow({ id: env.tgId, db: env.appDb }, shop.company, job.id, worker(shop.deps, outbox));
  return due.length;
}

/**
 * Handle a payment event and run the receipt job it wrote, as a route starts it (slice B4). The letter's job waits for
 * the poller, as in production: `drain` runs it as well. Answers the outcome with the receipt as the payment holds it.
 */
async function pay(event: PaymentEvent, opts: { deps?: PaymentDeps; drain?: boolean } = {}) {
  const deps = opts.deps ?? shop.deps;
  const outcome = await handlePaymentEvent(deps, event);
  for (const jobId of outcome.jobIds) {
    await runJobNow({ id: env.tgId, db: env.appDb }, shop.company, jobId, worker(deps));
  }
  if (opts.drain !== false) await drainMail();
  const row = await env.ownerDb
    .selectFrom('order_payment')
    .select('receipt_document_id')
    .where('tenant_id', '=', shop.company)
    .where('order_id', '=', event.orderId)
    .executeTakeFirstOrThrow();
  return { ...outcome, receiptDocumentId: row.receipt_document_id };
}

function paid(orderId: string, extra: Partial<PaymentEvent> = {}): PaymentEvent {
  return { provider: 'stripe', eventId: `evt-${randomUUID()}`, type: 'payment_succeeded', tenantId: shop.company, orderId, providerPaymentId: `demo_pi_${orderId}`, ...extra };
}

async function mailRow(orderId: string, kind: 'order_confirmation' | 'late_refund' = 'order_confirmation') {
  return env.ownerDb.selectFrom('shop_mail').selectAll().where('tenant_id', '=', shop.company).where('order_id', '=', orderId).where('kind', '=', kind).executeTakeFirst();
}

async function mailJob(orderId: string, kind: 'order_confirmation' | 'late_refund' = 'order_confirmation') {
  return env.ownerDb
    .selectFrom('commerce_job')
    .selectAll()
    .where('tenant_id', '=', shop.company)
    .where('kind', '=', 'shop_mail')
    .where('dedupe_key', '=', `mail:${orderId}:${kind}`)
    .executeTakeFirst();
}

describe('connecting the shop to Lumitra Mail', () => {
  it('forward: stores the workspace, the sender and the key sealed, after adding the languages and installing the templates', async () => {
    const view = await connect();
    expect(view).toMatchObject({ workspaceId: shop.workspaceId, workspaceName: 'Schmuck', sender: 'Schmuck Testshop <shop@testshop.example>', failed: { count: 0 } });
    expect(shop.mail.calls.map((c) => c.op)).toEqual(['workspaces', 'senders', 'ensureLanguages', 'createKey', 'installTemplates']);
    const row = await env.ownerDb.selectFrom('shop_mail_connection').selectAll().where('tenant_id', '=', shop.company).executeTakeFirstOrThrow();
    expect(row.api_key_sealed).not.toContain('fake-send-key');
    expect(unseal(SEAL_KEY, row.api_key_sealed)).toBe('fake-send-key-1');
    expect(row.template_ids).toEqual({ order_confirmation: 'tpl-confirmation', late_refund: 'tpl-refund' });
    expect(row.connected_by).toBe(OWNER);
  });

  it("backtrack: another company's workspace, a role too low or an unknown sender is refused, and nothing is stored", async () => {
    const foreign = (await shop.mail.workspaces(OWNER))[1];
    await expect(
      connectShopMail(env.appDb, shop.mail, SEAL_KEY, { subject: OWNER, companyId: shop.company, workspaceId: foreign.id, providerId: shop.providerId, attempt: 'a-foreign-1', now: shop.clock.now }),
    ).rejects.toMatchObject({ code: 'workspace_of_another_company' });

    const viewer = fakeMail({ workspaces: [{ id: shop.workspaceId, name: 'Schmuck', role: 'viewer', companyId: shop.company, locales: ['de'] }] });
    await expect(
      connectShopMail(env.appDb, viewer, SEAL_KEY, { subject: OWNER, companyId: shop.company, workspaceId: shop.workspaceId, providerId: shop.providerId, attempt: 'a-viewer-1', now: shop.clock.now }),
    ).rejects.toMatchObject({ code: 'role_too_low' });

    await expect(
      connectShopMail(env.appDb, shop.mail, SEAL_KEY, { subject: OWNER, companyId: shop.company, workspaceId: shop.workspaceId, providerId: randomUUID(), attempt: 'a-sender-1', now: shop.clock.now }),
    ).rejects.toBeInstanceOf(ConnectRefused);

    expect(shop.mail.calls.some((c) => c.op === 'createKey')).toBe(false);
    expect(await readConnection(env.appDb, shop.company, shop.clock.now)).toBeNull();
  });

  it('backtrack: a failed install takes its new key back and stores nothing', async () => {
    shop.mail.failNext('installTemplates', new MailRefused('other', 'two templates of that name'));
    await expect(connect()).rejects.toBeInstanceOf(MailRefused);
    expect(shop.mail.revoked).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(await readConnection(env.appDb, shop.company, shop.clock.now)).toBeNull();
  });

  it('re-entry: connecting again revokes the old key once the new one works; the same attempt makes no second key', async () => {
    await connect('attempt-same-1');
    await connect('attempt-same-1');
    expect(shop.mail.revoked).toEqual([]);
    await connect('attempt-new-2');
    expect(shop.mail.revoked).toEqual(['00000000-0000-4000-8000-000000000001']);
  });

  it('disconnecting revokes the key first, and keeps the connection while Lumitra Mail cannot be reached', async () => {
    await connect();
    shop.mail.failNext('revokeKey', new MailRetryLater('down'));
    await expect(disconnectShopMail(env.appDb, shop.mail, OWNER, shop.company)).rejects.toBeInstanceOf(MailRetryLater);
    expect(await readConnection(env.appDb, shop.company, shop.clock.now)).not.toBeNull();

    await disconnectShopMail(env.appDb, shop.mail, OWNER, shop.company);
    expect(shop.mail.revoked).toHaveLength(1);
    expect(await readConnection(env.appDb, shop.company, shop.clock.now)).toBeNull();

    // A key already gone at Lumitra Mail counts as revoked.
    await connect();
    shop.mail.failNext('revokeKey', new MailRefused('not_found', 'gone'));
    expect(await disconnectShopMail(env.appDb, shop.mail, OWNER, shop.company)).toEqual({ keyRevoked: true });
    expect(await readConnection(env.appDb, shop.company, shop.clock.now)).toBeNull();
  });

  it('an owner without a role in the mail workspace can still disconnect, and is told the key is left', async () => {
    await connect();
    shop.mail.failNext('revokeKey', new MailRefused('not_a_member', 'not a member'));
    expect(await disconnectShopMail(env.appDb, shop.mail, 'another-owner', shop.company)).toEqual({ keyRevoked: false });
    expect(await readConnection(env.appDb, shop.company, shop.clock.now)).toBeNull();
    // Nothing is sent any more: a paid order writes no letter.
    const orderId = await placeOrder(await stockedRing(2));
    await pay(paid(orderId));
    expect(shop.mail.sent).toEqual([]);
  });
});

describe('the buyer hears of a paid order', () => {
  it('forward: one confirmation in German with the order, the total and a link that serves exactly that receipt', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    const outcome = await pay(paid(orderId));
    expect(outcome.status).toBe('paid');

    expect(shop.mail.sent).toHaveLength(1);
    const [letter] = shop.mail.sent;
    const order = await env.ownerDb.selectFrom('order').select('order_number').where('id', '=', orderId).executeTakeFirstOrThrow();
    expect(letter).toMatchObject({
      kind: 'order_confirmation',
      locale: 'de',
      templateId: 'tpl-confirmation',
      providerId: shop.providerId,
      to: 'alex@example.com',
      merge: { shop_name: 'Schmuck Testshop', order_number: order.order_number, total_text: '49,00\u00a0€', first_name: 'Alex', receipt_number: '1' },
    });
    expect(letter.key).toBe(`shop:${shop.company}:${orderId}:order_confirmation:${shop.workspaceId}`);
    expect(await mailRow(orderId)).toMatchObject({ status: 'sent', mailing_id: 'mailing-1', last_error: null });
    expect(await mailJob(orderId)).toMatchObject({ status: 'done', event_type: 'receipt.issued' });

    const token = letter.merge.receipt_url.replace('https://app.example/api/receipts/', '');
    expect(readReceiptToken(LINK_KEY, token)).toEqual({ tenantGroupId: env.tgId, tenantId: shop.company, documentId: outcome.receiptDocumentId });
    const served = await serveReceipt(token, LINK_KEY, async () => env.appDb);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('application/pdf');
    expect(served.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await served.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');

    // A repeated webhook sends no second letter.
    await pay(paid(orderId, { eventId: `evt-${randomUUID()}` }));
    expect(shop.mail.sent).toHaveLength(1);
    expect(await env.ownerDb.selectFrom('commerce_job').select('id').where('tenant_id', '=', shop.company).where('kind', '=', 'shop_mail').execute()).toHaveLength(1);
  });

  it('a receipt link is refused for another key, another company, or a document that is not a shop receipt', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    const outcome = await pay(paid(orderId));
    const token = shop.mail.sent[0].merge.receipt_url.split('/').pop()!;
    expect((await serveReceipt(token, randomBytes(32), async () => env.appDb)).status).toBe(404);
    expect((await serveReceipt(token, null, async () => env.appDb)).status).toBe(404);
    const { receiptToken } = await import('../receiptLink');
    const foreign = receiptToken(LINK_KEY, { tenantGroupId: env.tgId, tenantId: randomUUID(), documentId: outcome.receiptDocumentId! });
    expect((await serveReceipt(foreign, LINK_KEY, async () => env.appDb)).status).toBe(404);
    const missing = receiptToken(LINK_KEY, { tenantGroupId: env.tgId, tenantId: shop.company, documentId: randomUUID() });
    expect((await serveReceipt(missing, LINK_KEY, async () => env.appDb)).status).toBe(404);
  });

  it('backtrack: a letter written in a transaction that rolls back leaves neither the row nor the job', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    await expect(
      env.appDb.transaction().execute(async (trx) => {
        expect(await enqueueShopMail(trx, shop.company, orderId, 'order_confirmation', shop.clock.now)).toEqual(expect.any(String));
        throw new Error('the change that needed the letter failed');
      }),
    ).rejects.toThrow('the change that needed the letter failed');
    expect(await mailRow(orderId)).toBeUndefined();
    expect(await mailJob(orderId)).toBeUndefined();
  });

  it('re-entry: a shop that is not connected sends nothing and keeps no letter', async () => {
    const orderId = await placeOrder(await stockedRing(2));
    expect((await pay(paid(orderId))).status).toBe('paid');
    expect(shop.mail.sent).toEqual([]);
    expect(await mailRow(orderId)).toBeUndefined();
    expect(await mailJob(orderId)).toBeUndefined();
  });

  it('resume: with Lumitra Mail down the job waits with its backoff, and sends the letter once it is due', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    shop.mail.failNext('send', new MailRetryLater('Lumitra Mail could not be reached'));
    expect((await pay(paid(orderId))).status).toBe('paid');
    expect(await mailRow(orderId)).toMatchObject({ status: 'pending', last_error: 'Lumitra Mail could not be reached' });
    const waiting = await mailJob(orderId);
    expect(waiting).toMatchObject({ status: 'pending', last_error: 'Lumitra Mail could not be reached' });
    expect(new Date(waiting!.run_at).getTime() - shop.clock.now.getTime()).toBe(60_000);

    expect(await drainMail()).toBe(0);
    shop.clock.now = new Date(shop.clock.now.getTime() + 61_000);
    expect(await drainMail()).toBe(1);
    expect(await mailRow(orderId)).toMatchObject({ status: 'sent', last_error: null });
    expect(await mailJob(orderId)).toMatchObject({ status: 'done' });
    expect(shop.mail.sent).toHaveLength(1);
  });

  it('re-entry: a refusal ends the letter as failed and the owner sees it; a blocked address ends as blocked', async () => {
    await connect();
    const refused = await placeOrder(await stockedRing(2));
    shop.mail.failNext('send', new MailRefused('template_missing', 'no template'));
    await pay(paid(refused));
    expect(await mailRow(refused)).toMatchObject({ status: 'failed', last_error: 'no template' });
    expect(await mailJob(refused)).toMatchObject({ status: 'dead', last_error: 'template_missing' });
    expect((await readConnection(env.appDb, shop.company, shop.clock.now))!.failed).toEqual({ count: 1, latestReason: 'no template' });

    shop.mail.blocked.add('alex@example.com');
    const blocked = await placeOrder(await stockedRing(2));
    await pay(paid(blocked));
    expect(await mailRow(blocked)).toMatchObject({ status: 'blocked' });
    expect(await mailJob(blocked)).toMatchObject({ status: 'done' });
  });

  it('resume: a letter the old build wrote (a row with no job) is given its job by the backfill, once, and sent', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    await pay(paid(orderId), { drain: false });
    // As the old build left it: the row, no job.
    await env.ownerDb.deleteFrom('commerce_job').where('tenant_id', '=', shop.company).where('kind', '=', 'shop_mail').execute();
    expect(await mailJob(orderId)).toBeUndefined();

    await runJobBackfills(env.appDb, shop.clock.now);
    await runJobBackfills(env.appDb, shop.clock.now);
    expect(await env.ownerDb.selectFrom('commerce_job').select('id').where('tenant_id', '=', shop.company).where('kind', '=', 'shop_mail').execute()).toHaveLength(1);
    expect(await drainMail()).toBe(1);
    expect(await mailRow(orderId)).toMatchObject({ status: 'sent' });
    expect(shop.mail.sent).toHaveLength(1);

    // A letter that is settled needs no job: the backfill leaves a sent row alone, and a dead job stays dead.
    await env.ownerDb.deleteFrom('commerce_job').where('tenant_id', '=', shop.company).where('kind', '=', 'shop_mail').execute();
    await runJobBackfills(env.appDb, shop.clock.now);
    expect(await mailJob(orderId)).toBeUndefined();
  });

  it('resume: a letter whose job the engine ended stays pending no longer: the backfill writes it failed with the reason', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    await pay(paid(orderId), { drain: false });
    // The engine gave the job up while the row still said pending (a database error on the last attempt).
    await env.ownerDb
      .updateTable('commerce_job')
      .set({ status: 'dead', finished_at: shop.clock.now, last_error: 'lease lost' })
      .where('tenant_id', '=', shop.company)
      .where('kind', '=', 'shop_mail')
      .execute();
    expect(await mailRow(orderId)).toMatchObject({ status: 'pending' });

    await runJobBackfills(env.appDb, shop.clock.now);
    expect(await mailRow(orderId)).toMatchObject({ status: 'failed', last_error: 'lease lost' });
    expect(await mailJob(orderId)).toMatchObject({ status: 'dead' });
    expect(shop.mail.sent).toHaveLength(0);
  });

  it('resume: a retry sends the letter as first built, even after the site was renamed and switched to English', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    shop.mail.failNext('send', new MailRetryLater('down'));
    await pay(paid(orderId));
    const first = (await mailRow(orderId))!.letter as Record<string, unknown>;
    expect(first).toMatchObject({ workspaceId: shop.workspaceId, locale: 'de', merge: { shop_name: 'Schmuck Testshop' } });

    shop.site.name = 'Renamed Shop';
    shop.site.language = 'en';
    shop.clock.now = new Date(shop.clock.now.getTime() + 61_000);
    await drainMail();
    expect(shop.mail.sent).toHaveLength(1);
    expect(shop.mail.sent[0]).toMatchObject({ locale: 'de', merge: { shop_name: 'Schmuck Testshop' } });
  });

  it('resume: two overlapping attempts at one letter send it once, and the refused one never overwrites sent', async () => {
    // Lumitra Mail takes a moment to send: the second attempt arrives while the first is still running.
    shop.mail = fakeMail({
      workspaces: [{ id: shop.workspaceId, name: 'Schmuck', role: 'owner', companyId: shop.company, locales: ['de'] }],
      senders: { [shop.workspaceId]: [{ id: shop.providerId, label: 'Schmuck Testshop <shop@testshop.example>' }] },
      sendDelayMs: 50,
    });
    shop.outbox = { ...shop.outbox, mail: shop.mail };
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    await pay(paid(orderId), { drain: false });
    const settled = await Promise.allSettled([
      deliverShopMail(shop.outbox, shop.company, orderId, 'order_confirmation'),
      deliverShopMail(shop.outbox, shop.company, orderId, 'order_confirmation'),
    ]);
    // One went through; the other met the conflict and would retry, but its write cannot touch a sent row.
    expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(settled.find((r) => r.status === 'rejected')).toMatchObject({ reason: expect.any(JobRetryLater) });
    expect(shop.mail.calls.filter((c) => c.op === 'send')).toHaveLength(2);
    expect(shop.mail.sent).toHaveLength(1);
    expect(await mailRow(orderId)).toMatchObject({ status: 'sent', mailing_id: 'mailing-1' });
  });

  it('re-entry: three days of failures end the letter as failed', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    shop.mail.failNext('send', new MailRetryLater('down'));
    await pay(paid(orderId));
    // The order row is stamped by the database's real clock, so three days are counted from whichever is later.
    shop.clock.now = new Date(Math.max(Date.now(), shop.clock.now.getTime()) + 3 * 24 * 60 * 60 * 1000 + 1000);
    shop.mail.failNext('send', new MailRetryLater('still down'));
    await drainMail();
    expect(await mailRow(orderId)).toMatchObject({ status: 'failed', last_error: 'still down' });
    expect(await mailJob(orderId)).toMatchObject({ status: 'dead', last_error: 'gave_up' });
    expect((await readConnection(env.appDb, shop.company, shop.clock.now))!.failed).toMatchObject({ count: 1 });
  });

  it('re-entry: a reconnect to another workspace builds the letter again there, under that workspace\'s keys', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    shop.mail.failNext('send', new MailRetryLater('down'));
    await pay(paid(orderId));
    // The owner moves the shop to a second workspace of the company.
    const second = randomUUID();
    const provider2 = randomUUID();
    const moved = fakeMail({
      workspaces: [{ id: second, name: 'Schmuck 2', role: 'owner', companyId: shop.company, locales: ['de', 'en'] }],
      senders: { [second]: [{ id: provider2, label: 'Shop <shop@two.example>' }] },
    });
    await connectShopMail(env.appDb, moved, SEAL_KEY, { subject: OWNER, companyId: shop.company, workspaceId: second, providerId: provider2, attempt: 'attempt-move-1', now: shop.clock.now });
    shop.clock.now = new Date(shop.clock.now.getTime() + 61_000);
    await drainMail({ ...shop.outbox, mail: moved });
    expect(moved.sent).toHaveLength(1);
    expect(moved.sent[0]).toMatchObject({ providerId: provider2, key: `shop:${shop.company}:${orderId}:order_confirmation:${second}` });
  });

  it('re-entry: a late payment refunded because the stock was gone sends the refund notice', async () => {
    await connect();
    const ring = await stockedRing(1);
    const orderId = await placeOrder(ring);
    shop.clock.now = new Date(shop.clock.now.getTime() + 31 * 60 * 1000);
    await sweepExpiredPayments(shop.deps, shop.company);
    // Someone else buys the last ring meanwhile.
    await placeOrder(ring);

    expect((await pay(paid(orderId))).status).toBe('refunded');
    const notice = shop.mail.sent.find((l) => l.kind === 'late_refund');
    expect(notice).toMatchObject({ templateId: 'tpl-refund', to: 'alex@example.com', merge: { total_text: '49,00\u00a0€' } });
    expect(notice!.merge).not.toHaveProperty('receipt_url');
    expect(await mailRow(orderId, 'late_refund')).toMatchObject({ status: 'sent' });
  });
});

describe('what the payments page is answered', () => {
  const ctx = () => ({ db: env.appDb, companyId: shop.company, tenantGroupId: env.tgId, subject: OWNER, email: null });
  const post = (body: unknown) => new Request('https://app.example/api/payments/mail', { method: 'POST', body: JSON.stringify(body) });

  it("lists only the company's own workspaces, and says how many belong elsewhere", async () => {
    const res = await mailStatus(ctx(), { mail: shop.mail, sealKey: SEAL_KEY });
    expect(await res.json()).toEqual({ configured: true, connection: null, workspaces: [{ id: shop.workspaceId, name: 'Schmuck', role: 'owner' }], otherCompanies: 1 });
  });

  it('says when the platform has no Lumitra Mail, and when Lumitra Mail cannot list workspaces', async () => {
    expect(await (await mailStatus(ctx(), { mail: null, sealKey: null })).json()).toMatchObject({ configured: false, workspaces: [] });
    expect((await mailConnect(ctx(), { mail: null, sealKey: null }, post({}))).status).toBe(503);
    shop.mail.failNext('workspaces', new MailRetryLater('down'));
    expect(await (await mailStatus(ctx(), { mail: shop.mail, sealKey: SEAL_KEY })).json()).toMatchObject({ workspacesError: 'mail_unavailable' });
  });

  it('connects, refuses another company with 403, a malformed request with 400, and maps Lumitra Mail down to 503', async () => {
    const deps = { mail: shop.mail, sealKey: SEAL_KEY, now: () => shop.clock.now };
    expect((await mailConnect(ctx(), deps, post({ workspaceId: 'x' }))).status).toBe(400);
    const foreign = (await shop.mail.workspaces(OWNER))[1].id;
    const refused = await mailConnect(ctx(), deps, post({ workspaceId: foreign, providerId: shop.providerId, attempt: 'attempt-foreign-1' }));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe('workspace_of_another_company');
    shop.mail.failNext('createKey', new MailRetryLater('down'));
    expect((await mailConnect(ctx(), deps, post({ workspaceId: shop.workspaceId, providerId: shop.providerId, attempt: 'attempt-down-1' }))).status).toBe(503);
    const ok = await mailConnect(ctx(), deps, post({ workspaceId: shop.workspaceId, providerId: shop.providerId, attempt: 'attempt-ok-1' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).connection).toMatchObject({ workspaceName: 'Schmuck' });
  });
});
