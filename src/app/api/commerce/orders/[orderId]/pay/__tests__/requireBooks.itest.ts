// src/app/api/commerce/orders/[orderId]/pay/__tests__/requireBooks.itest.ts
//
// Stripe payments wait for the Books (decided by Marlin on 2026-11-02): a company whose Books cannot issue a paid
// order's receipt takes no real money, so no paid order ever lacks its invoice. Through the real order and pay routes
// and the owner's account status, against a provisioned tenant schema, with real Books settings and a fake Stripe API
// that counts what it is asked; nothing reaches Stripe.
//
//   - forward: Books ready, the order opens a Stripe payment and the pay route a checkout page;
//   - backtrack and revise: each missing piece (no settings, no invoice numbers, an incomplete sender) refuses the
//     order with 503 payments_unavailable, nothing ordered or reserved, and setting it up lets the next order through;
//   - resume: an order placed while the Books were ready, whose sender was made incomplete afterwards, is refused at
//     pay with nothing stored or asked of Stripe, keeps waiting, and pays once the sender is complete again;
//   - re-entry: a refusal repeated is the same refusal, and still asks Stripe nothing;
//   - the owner's payments page hears the same reason the buyer is refused for.
// The demo provider (a company without Stripe) is not touched by this rule: refuseForeign.itest.ts pays one without
// Books. All data is synthetic.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  directory: null as unknown,
  contactBook: null as unknown,
  stripe: null as unknown,
}));

vi.mock('@/server/books/http/dependencies', () => ({
  booksDependencies: () => ({ recipients: state.directory, contactBook: state.contactBook }),
}));

vi.mock('@/server/commerce/payment/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/commerce/payment/stripe/client')>()),
  httpStripeApi: () => state.stripe,
}));

import { DEMO_COMPANY_ID } from '@/lib/renderer/server/demoTenant';
import { FakeContactBook, FakeDirectory, initCompany, syntheticSender } from '@/server/books/__tests__/booksFixtures';
import { booksScope } from '@/server/books/scope';
import { initBooksCompany } from '@/server/books/settings';
import {
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import { stripeConfig, type StripeApi } from '@/server/commerce/payment/stripe/client';
import { refreshAccount, startOnboarding } from '@/server/commerce/payment/stripe/connect';
import { accountStatus } from '@/server/commerce/payment/stripe/ownerHandlers';
import { POST as placeOrder } from '../../../route';
import { POST as pay } from '../route';

interface Shop {
  tenant: ProvisionedTenant;
  host: string;
}

let fx: StorefrontFixtures;
/** Every checkout page the fake Stripe was asked to open. */
let sessions: unknown[];

// Provisioning takes a lock every suite of the integration run shares, so waiting for it outlasts the default budget.
const PROVISIONING_TIMEOUT = 300_000;

const fakeStripe = {
  createAccount: async () => ({ id: `acct_${randomBytes(6).toString('hex')}`, charges_enabled: false, details_submitted: false }),
  retrieveAccount: async (id: string) => ({ id, charges_enabled: true, details_submitted: true }),
  createAccountLink: async () => ({ url: 'https://connect.stripe.test/setup' }),
  createCheckoutSession: async (args: unknown) => {
    sessions.push(args);
    return { id: `cs_${randomBytes(6).toString('hex')}`, url: 'https://checkout.stripe.test/pay' };
  },
} as unknown as StripeApi;

function scopeOf(shop: Shop) {
  return booksScope(shop.tenant.db, shop.tenant.tgId, DEMO_COMPANY_ID, { recipients: state.directory as FakeDirectory });
}

/** A published shop whose Stripe account is ready, with no Books yet. */
async function stripeShop(slug: string): Promise<Shop> {
  const tenant = await provisionCommerceTenant(fx, slug);
  const { host } = await createPublishedSite(fx, tenant.tgId, slug);
  await startOnboarding(tenant.db, fakeStripe, { tenantId: DEMO_COMPANY_ID, country: 'DE', refreshUrl: 'r', returnUrl: 'r' });
  await refreshAccount(tenant.db, fakeStripe, DEMO_COMPANY_ID);
  return { tenant, host };
}

/** The settings with a sender that lacks what every invoice needs: an address and a tax id. */
function incompleteSender(shop: Shop) {
  return initBooksCompany(scopeOf(shop), {
    taxStatus: 'regular',
    senderBlock: syntheticSender({ postalCode: null, taxNumber: null, vatId: null }),
    counters: [{ docType: 'invoice', format: '{n}', nextValue: 1000 }],
  });
}

beforeAll(async () => {
  const directory = new FakeDirectory();
  state.directory = directory;
  state.contactBook = new FakeContactBook(directory);
  state.stripe = fakeStripe;
  fx = openStorefrontFixtures();
}, PROVISIONING_TIMEOUT);

afterAll(async () => {
  await fx?.close();
});

beforeEach(() => {
  sessions = [];
  const fake = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
  for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID']) vi.stubEnv(key, fake('test'));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function buyer() {
  return {
    name: `Alex Example ${randomUUID().slice(0, 8)}`,
    email: 'alex@example.com',
    addressLine1: 'Beispielweg 2',
    postalCode: '20095',
    city: 'Hamburg',
    country: 'DE',
  };
}

function request(shop: Shop, path: string, body: unknown): Request {
  return new Request(`http://${shop.host}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: shop.host },
    body: JSON.stringify(body),
  });
}

async function product(shop: Shop) {
  return seedBuyableProduct(shop.tenant.db, {
    title: `P-${randomUUID().slice(0, 6)}`,
    handle: `p-${randomUUID()}`,
    amountCents: 1000,
    stocked: 5,
  });
}

async function placeFor(shop: Shop, variantId: string) {
  const res = await placeOrder(request(shop, '/api/commerce/orders', { lines: [{ variantId, quantity: 1 }] }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function payOrder(shop: Shop, orderId: string, body: unknown) {
  const res = await pay(request(shop, `/api/commerce/orders/${orderId}/pay`, body), { params: Promise.resolve({ orderId }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function reserved(shop: Shop, item: string) {
  const level = await shop.tenant.db
    .selectFrom('inventory_level')
    .select('reserved_quantity')
    .where('inventory_item_id', '=', item)
    .executeTakeFirstOrThrow();
  return level.reserved_quantity;
}

async function orderCount(shop: Shop) {
  const { n } = await shop.tenant.db
    .selectFrom('order')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(n);
}

/** What the payments page in the editor reads for the company. */
async function ownerView(shop: Shop) {
  const config = stripeConfig();
  if (!config) throw new Error('the fake Stripe keys are not set');
  const res = await accountStatus({
    db: shop.tenant.db,
    companyId: DEMO_COMPANY_ID,
    tenantGroupId: shop.tenant.tgId,
    subject: 'owner',
    email: null,
    api: fakeStripe,
    config,
  });
  return (await res.json()) as { status: string; books: Record<string, unknown> };
}

const UNAVAILABLE = { status: 503, body: { error: { code: 'payments_unavailable' } } };

describe('Stripe payments wait for the Books', () => {
  it('forward: with the Books ready the order opens a Stripe payment and the buyer gets a checkout page', async () => {
    const shop = await stripeShop('books-ready');
    await initCompany(scopeOf(shop), { taxStatus: 'regular', invoiceNext: 1000 });
    expect(await ownerView(shop)).toMatchObject({ status: 'ready', books: { ready: true } });

    const seeded = await product(shop);
    const placed = await placeFor(shop, seeded.variantId);
    expect(placed).toMatchObject({ status: 201, body: { provider: 'stripe' } });
    expect(await payOrder(shop, String(placed.body.orderId), { buyer: buyer() })).toMatchObject({
      status: 200,
      body: { status: 'redirect', redirectUrl: 'https://checkout.stripe.test/pay' },
    });
    expect(sessions).toHaveLength(1);
  }, PROVISIONING_TIMEOUT);

  it.each([
    ['no Books at all', 'books_not_set_up', async () => {}],
    [
      'no invoice number series',
      'invoice_numbers_missing',
      (shop: Shop) =>
        initBooksCompany(scopeOf(shop), {
          taxStatus: 'regular',
          senderBlock: syntheticSender(),
          counters: [{ docType: 'credit_note', format: 'GS-{n}', nextValue: 1 }],
        }),
    ],
    ['an incomplete sender', 'sender_incomplete', incompleteSender],
  ])(
    'backtrack: %s refuses the order before anything is reserved, the owner hears why, and setting it up lets buyers pay',
    async (_label, blocker, prepare) => {
      const shop = await stripeShop(`books-${blocker.replace(/_/g, '-')}`);
      await prepare(shop);
      const seeded = await product(shop);

      expect(await placeFor(shop, seeded.variantId)).toMatchObject(UNAVAILABLE);
      expect(await orderCount(shop)).toBe(0);
      expect(await reserved(shop, seeded.inventoryItemId)).toBe(0);
      expect(sessions).toEqual([]);
      expect(await ownerView(shop)).toMatchObject({ status: 'ready', books: { ready: false, blocker } });

      // The Books set up (a re-run completes the sender and adds what is missing): the next order goes through.
      await initCompany(scopeOf(shop), { taxStatus: 'regular', invoiceNext: 1000 });
      expect((await ownerView(shop)).books).toEqual({ ready: true });
      const placed = await placeFor(shop, seeded.variantId);
      expect(placed).toMatchObject({ status: 201, body: { provider: 'stripe' } });
      expect(await payOrder(shop, String(placed.body.orderId), { buyer: buyer() })).toMatchObject({
        status: 200,
        body: { status: 'redirect' },
      });
      expect(sessions).toHaveLength(1);
    },
    PROVISIONING_TIMEOUT,
  );

  it('the owner hears which sender fields are missing, by name only', async () => {
    const shop = await stripeShop('books-sender-fields');
    await incompleteSender(shop);
    expect((await ownerView(shop)).books).toEqual({
      ready: false,
      blocker: 'sender_incomplete',
      missing: ['postalCode', 'taxNumber|vatId'],
    });
  }, PROVISIONING_TIMEOUT);

  it('resume and re-entry: an order whose Books broke after it was placed waits, is refused alike each time, and pays once fixed', async () => {
    const shop = await stripeShop('books-broke');
    await initCompany(scopeOf(shop), { taxStatus: 'regular', invoiceNext: 1000 });
    const seeded = await product(shop);
    const placed = await placeFor(shop, seeded.variantId);
    expect(placed).toMatchObject({ status: 201, body: { provider: 'stripe' } });
    const orderId = String(placed.body.orderId);

    // A re-run of the setup replaces the sender with one that lacks the address and the tax id.
    await incompleteSender(shop);
    const details = buyer();
    const first = await payOrder(shop, orderId, { buyer: details });
    expect(first).toMatchObject(UNAVAILABLE);
    expect(await payOrder(shop, orderId, { buyer: details })).toEqual(first);
    expect(sessions).toEqual([]);
    const waiting = await shop.tenant.db
      .selectFrom('order_payment')
      .select(['status', 'buyer', 'provider_payment_id'])
      .where('order_id', '=', orderId)
      .executeTakeFirstOrThrow();
    // Nothing was kept from the refused attempt: the buyer is not stored and no Stripe payment is linked.
    expect(waiting).toEqual({ status: 'pending', buyer: {}, provider_payment_id: null });
    expect(await reserved(shop, seeded.inventoryItemId)).toBe(1);

    await initCompany(scopeOf(shop), { taxStatus: 'regular', invoiceNext: 1000 });
    expect(await payOrder(shop, orderId, { buyer: details })).toMatchObject({ status: 200, body: { status: 'redirect' } });
    expect(sessions).toHaveLength(1);
    expect(await orderCount(shop)).toBe(1);
  }, PROVISIONING_TIMEOUT);
});
