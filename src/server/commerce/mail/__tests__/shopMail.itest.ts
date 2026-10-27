// src/server/commerce/mail/__tests__/shopMail.itest.ts
//
// The shop's receipt email (docs/plans/2026-10-27-shop-receipt-email.md) against real Postgres, with a fake Lumitra
// Mail and the same payment handler a webhook uses. The four paths of the stateful-flow standard:
//
//   1. forward: connect a workspace of the shop's company, pay an order, the buyer's confirmation goes out once,
//      with the order, the total in German and a signed link that serves exactly that receipt;
//   2. backtrack: a workspace of another company, a role too low or an unknown sender is refused and nothing is
//      stored; an install that fails takes its new key back; reconnecting revokes the old key; disconnecting
//      revokes the key first and keeps the connection when Lumitra Mail cannot be reached;
//   3. resume: Lumitra Mail down, the letter waits and the sweep sends it when due, unchanged even when the site
//      changed meanwhile; a letter whose first attempt never started (a crash after the receipt) is sent by the
//      sweep; a repeated webhook or two overlapping attempts send one letter;
//   4. re-entry: a refusal ends a letter as failed (shown to the owner), a blocked address as blocked, three days
//      of failures end it as failed; a late payment refunded sends the refund notice; a shop not connected sends
//      nothing; an owner without a role in Lumitra Mail can still disconnect.
// All data is synthetic.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { catalogRepository } from '../../repository/catalog';
import { pricingRepository } from '../../repository/pricing';
import { createOrder } from '../../order/createOrder';
import { handlePaymentEvent, sweepExpiredPayments, type PaymentDeps } from '../../payment/payments';
import { demoProvider, type PaymentEvent } from '../../payment/provider';
import { ensureReceipt } from '../../payment/receipt';
import type { BuyerInput } from '../../payment/buyer';
import { booksScope } from '@/server/books/scope';
import { FakeContactBook, FakeDirectory, initCompany, openBooksEnv, type BooksEnv } from '@/server/books/__tests__/booksFixtures';
import { ConnectRefused, connectShopMail, disconnectShopMail, readConnection } from '../connection';
import { MailRefused, MailRetryLater } from '../lumitraMail';
import { deliverShopMail, sweepShopMail, type OutboxDeps } from '../outbox';
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
  /** First attempts the payment handler started (not awaited there, as in production). */
  attempts: Promise<unknown>[];
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
  const attempts: Promise<unknown>[] = [];
  const deps: PaymentDeps = {
    db: env.appDb,
    tgId: env.tgId,
    provider: () => demoProvider,
    receipt: (orderId) => ensureReceipt(scope, contacts, orderId, { now: clock.now }),
    now: () => clock.now,
    deliverMail: (tenantId, orderId, kind) => {
      attempts.push(deliverShopMail(outbox, tenantId, orderId, kind));
    },
  };
  return { company, workspaceId, providerId, mail, clock, site, outbox, deps, attempts };
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
    payment: { provider: 'demo', buyer: BUYER as never },
  });
  if (!result.ok) throw new Error('the order was short');
  return result.orderId;
}

/** Handle a payment event, then wait for the first mail attempts it started. */
async function pay(event: PaymentEvent) {
  const outcome = await handlePaymentEvent(shop.deps, event);
  await Promise.all(shop.attempts.splice(0));
  return outcome;
}

function paid(orderId: string, extra: Partial<PaymentEvent> = {}): PaymentEvent {
  return { provider: 'demo', eventId: `evt-${randomUUID()}`, type: 'payment_succeeded', tenantId: shop.company, orderId, providerPaymentId: `demo_pi_${orderId}`, ...extra };
}

async function mailRow(orderId: string, kind: 'order_confirmation' | 'late_refund' = 'order_confirmation') {
  return env.ownerDb.selectFrom('shop_mail').selectAll().where('tenant_id', '=', shop.company).where('order_id', '=', orderId).where('kind', '=', kind).executeTakeFirst();
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
    expect(await mailRow(orderId)).toMatchObject({ status: 'sent', attempts: 1, mailing_id: 'mailing-1', last_error: null });

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

  it('re-entry: a shop that is not connected sends nothing and keeps no letter', async () => {
    const orderId = await placeOrder(await stockedRing(2));
    expect((await pay(paid(orderId))).status).toBe('paid');
    expect(shop.mail.sent).toEqual([]);
    expect(await mailRow(orderId)).toBeUndefined();
  });

  it('resume: with Lumitra Mail down the letter waits, and the sweep sends it once it is due', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    shop.mail.failNext('send', new MailRetryLater('Lumitra Mail could not be reached'));
    expect((await pay(paid(orderId))).status).toBe('paid');
    const waiting = await mailRow(orderId);
    expect(waiting).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Lumitra Mail could not be reached' });
    expect(new Date(waiting!.next_attempt_at).getTime() - shop.clock.now.getTime()).toBe(60_000);

    expect(await sweepShopMail(shop.outbox)).toBe(0);
    shop.clock.now = new Date(shop.clock.now.getTime() + 61_000);
    expect(await sweepShopMail(shop.outbox)).toBe(1);
    expect(await mailRow(orderId)).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
    expect(shop.mail.sent).toHaveLength(1);
  });

  it('re-entry: a refusal ends the letter as failed and the owner sees it; a blocked address ends as blocked', async () => {
    await connect();
    const refused = await placeOrder(await stockedRing(2));
    shop.mail.failNext('send', new MailRefused('template_missing', 'no template'));
    await pay(paid(refused));
    expect(await mailRow(refused)).toMatchObject({ status: 'failed', last_error: 'no template' });
    expect((await readConnection(env.appDb, shop.company, shop.clock.now))!.failed).toEqual({ count: 1, latestReason: 'no template' });

    shop.mail.blocked.add('alex@example.com');
    const blocked = await placeOrder(await stockedRing(2));
    await pay(paid(blocked));
    expect(await mailRow(blocked)).toMatchObject({ status: 'blocked' });
  });

  it('resume: a letter whose first attempt never started (a crash after the receipt) is written all the same, and the sweep sends it', async () => {
    await connect();
    const orderId = await placeOrder(await stockedRing(2));
    // The process dies before the first attempt: the hand-off is never made.
    await handlePaymentEvent({ ...shop.deps, deliverMail: undefined }, paid(orderId));
    expect(await mailRow(orderId)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await sweepShopMail(shop.outbox)).toBe(1);
    expect(await mailRow(orderId)).toMatchObject({ status: 'sent' });
    expect(shop.mail.sent).toHaveLength(1);
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
    await sweepShopMail(shop.outbox);
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
    await handlePaymentEvent({ ...shop.deps, deliverMail: undefined }, paid(orderId));
    const [first, second] = await Promise.all([
      deliverShopMail(shop.outbox, shop.company, orderId, 'order_confirmation'),
      deliverShopMail(shop.outbox, shop.company, orderId, 'order_confirmation'),
    ]);
    // One went through; the other met the conflict and would retry, but its write cannot touch a sent row.
    expect([first, second].sort()).toEqual(['pending', 'sent']);
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
    await sweepShopMail(shop.outbox);
    expect(await mailRow(orderId)).toMatchObject({ status: 'failed', last_error: 'still down' });
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
    await sweepShopMail({ ...shop.outbox, mail: moved });
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
