// src/app/api/commerce/orders/[orderId]/pay/__tests__/refuseForeign.itest.ts
//
// A buyer whose order cannot get a correct invoice is refused before any money moves (decided by Marlin on
// 2026-11-01). Through the real routes against a provisioned tenant schema, with real Books settings, the real
// German VAT module and the real issue; only the shared contacts database is a fake.
//
//   - regular taxation: a foreign address and a VAT id that is not German answer 422, the payment stays pending,
//     the stock stays held, no document exists, and the same order pays once the buyer corrects the input;
//   - a company without Books is priced as a regular one, so it refuses the same way;
//   - section 19 (small business): every line is free of VAT whoever buys, so any address and any VAT id are
//     accepted and the receipt adds up to what was paid. An order the company priced with VAT before it became a
//     small business cannot be invoiced that way and is refused;
//   - the four paths of a stateful flow: forward, backtrack and revise, resume from the buyer stored with the
//     order, and re-entry after the order was paid.
// All data is synthetic.

import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
import { FakeContactBook, FakeDirectory, initCompany } from '@/server/books/__tests__/booksFixtures';
import { booksScope } from '@/server/books/scope';
import {
  createPublishedSite,
  openStorefrontFixtures,
  provisionCommerceTenant,
  seedBuyableProduct,
  type ProvisionedTenant,
  type StorefrontFixtures,
} from '@/server/commerce/__tests__/storefrontFixtures';
import type { StripeApi } from '@/server/commerce/payment/stripe/client';
import { refreshAccount, startOnboarding } from '@/server/commerce/payment/stripe/connect';
import { POST as placeOrder } from '../../../route';
import { POST as pay } from '../route';

interface Shop {
  tenant: ProvisionedTenant;
  host: string;
}

let fx: StorefrontFixtures;
let regular: Shop;
let smallBusiness: Shop;
let noBooks: Shop;

// Provisioning takes a lock every suite of the integration run shares, so waiting for it outlasts the default budget.
const PROVISIONING_TIMEOUT = 300_000;

function setUpBooks(shop: Shop, taxStatus: 'regular' | 'small_business') {
  const scope = booksScope(shop.tenant.db, shop.tenant.tgId, DEMO_COMPANY_ID, { recipients: state.directory as FakeDirectory });
  return initCompany(scope, { taxStatus, invoiceNext: 1000 });
}

async function newShop(slug: string, taxStatus: 'regular' | 'small_business' | null): Promise<Shop> {
  const tenant = await provisionCommerceTenant(fx, slug);
  const { host } = await createPublishedSite(fx, tenant.tgId, slug);
  const shop = { tenant, host };
  if (taxStatus) await setUpBooks(shop, taxStatus);
  return shop;
}

beforeAll(async () => {
  const directory = new FakeDirectory();
  state.directory = directory;
  state.contactBook = new FakeContactBook(directory);
  fx = openStorefrontFixtures();
  regular = await newShop('refuse-regular', 'regular');
  smallBusiness = await newShop('refuse-small', 'small_business');
  noBooks = await newShop('refuse-no-books', null);
}, PROVISIONING_TIMEOUT);

afterAll(async () => {
  await fx?.close();
});

/** A buyer of its own (the contacts database matches by name), Germany unless a test says otherwise. */
function buyer(overrides: Record<string, unknown> = {}) {
  return {
    name: `Alex Example ${randomUUID().slice(0, 8)}`,
    email: 'alex@example.com',
    addressLine1: 'Beispielweg 2',
    postalCode: '20095',
    city: 'Hamburg',
    country: 'DE',
    ...overrides,
  };
}

const austrianBusiness = () =>
  buyer({ kind: 'organization', companyName: 'Muster GmbH', vatId: 'ATU12345678', country: 'AT', postalCode: '1010', city: 'Wien' });
const swissBuyer = () => buyer({ country: 'CH', postalCode: '8001', city: 'Zürich' });

function request(shop: Shop, path: string, body: unknown): Request {
  return new Request(`http://${shop.host}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: shop.host },
    body: JSON.stringify(body),
  });
}

async function order(shop: Shop, opts: { basis?: 'net' | 'gross'; buyer?: unknown } = {}) {
  const seeded = await seedBuyableProduct(shop.tenant.db, {
    title: `P-${randomUUID().slice(0, 6)}`,
    handle: `p-${randomUUID()}`,
    amountCents: 1000,
    stocked: 5,
  });
  await shop.tenant.db
    .updateTable('product')
    .set({ price_basis: opts.basis ?? 'net' })
    .where('id', '=', seeded.productId)
    .execute();
  const res = await placeOrder(
    request(shop, '/api/commerce/orders', { lines: [{ variantId: seeded.variantId, quantity: 1 }], buyer: opts.buyer }),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { orderId: string; totalCents: number };
  return { ...seeded, orderId: body.orderId, totalCents: body.totalCents };
}

async function payOrder(shop: Shop, orderId: string, body: unknown) {
  const res = await pay(request(shop, `/api/commerce/orders/${orderId}/pay`, body), {
    params: Promise.resolve({ orderId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function paymentOf(shop: Shop, orderId: string) {
  return shop.tenant.db
    .selectFrom('order_payment')
    .select(['status', 'buyer', 'receipt_error'])
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

async function documentsOf(shop: Shop, orderId: string) {
  return shop.tenant.db
    .selectFrom('sales_document')
    .select(['status', 'total', 'tax_amount', 'reverse_charge', 'kleinunternehmer', 'tax_note'])
    .where('source_order_id', '=', orderId)
    .execute();
}

async function reserved(shop: Shop, item: string) {
  const level = await shop.tenant.db
    .selectFrom('inventory_level')
    .select('reserved_quantity')
    .where('inventory_item_id', '=', item)
    .executeTakeFirstOrThrow();
  return level.reserved_quantity;
}

/** Refused, and nothing moved: the payment waits, the stock is held, no document exists. */
async function expectRefused(
  shop: Shop,
  placed: { orderId: string; inventoryItemId: string },
  answer: { status: number; body: Record<string, unknown> },
  field: 'country' | 'vatId',
) {
  expect(answer).toMatchObject({ status: 422, body: { error: { code: 'buyer_not_invoiceable', field } } });
  expect((await paymentOf(shop, placed.orderId)).status).toBe('pending');
  expect(await reserved(shop, placed.inventoryItemId)).toBe(1);
  expect(await documentsOf(shop, placed.orderId)).toEqual([]);
}

describe('pay under regular taxation: only a German address and a German VAT id', () => {
  it.each(['net', 'gross'] as const)('an Austrian business with a VAT id is refused (%s prices)', async (basis) => {
    const placed = await order(regular, { basis });
    await expectRefused(regular, placed, await payOrder(regular, placed.orderId, { buyer: austrianBusiness() }), 'country');
  });

  it.each(['net', 'gross'] as const)('a Swiss buyer is refused (%s prices)', async (basis) => {
    const placed = await order(regular, { basis });
    await expectRefused(regular, placed, await payOrder(regular, placed.orderId, { buyer: swissBuyer() }), 'country');
  });

  it('an Austrian consumer is refused as well: the refusal is the address, not only the VAT id', async () => {
    const placed = await order(regular);
    const answer = await payOrder(regular, placed.orderId, { buyer: buyer({ country: 'at', postalCode: '1010', city: 'Wien' }) });
    await expectRefused(regular, placed, answer, 'country');
  });

  it('a German address with a foreign VAT id is refused', async () => {
    const placed = await order(regular);
    const answer = await payOrder(regular, placed.orderId, { buyer: buyer({ kind: 'organization', vatId: 'ATU12345678' }) });
    await expectRefused(regular, placed, answer, 'vatId');
  });

  it('something that is no German VAT id is refused, not printed on an invoice', async () => {
    const placed = await order(regular);
    const answer = await payOrder(regular, placed.orderId, { buyer: buyer({ kind: 'organization', vatId: '12/345/67890' }) });
    await expectRefused(regular, placed, answer, 'vatId');
  });

  it('a refused buyer never becomes the order\'s buyer, and a declined card is not even tried', async () => {
    const accepted = buyer();
    const placed = await order(regular, { buyer: accepted });
    const answer = await payOrder(regular, placed.orderId, { buyer: swissBuyer(), simulateDecline: true });
    await expectRefused(regular, placed, answer, 'country');
    expect((await paymentOf(regular, placed.orderId)).buyer).toMatchObject({ name: accepted.name, country: 'DE' });
  });

  it('forward: a German buyer pays and gets a receipt with German VAT, also with a German VAT id', async () => {
    for (const details of [{}, { kind: 'organization', vatId: 'de 123 456 789' }]) {
      const placed = await order(regular);
      const answer = await payOrder(regular, placed.orderId, { buyer: buyer(details) });
      expect(answer).toMatchObject({ status: 200, body: { status: 'paid', receiptError: null } });
      expect(await documentsOf(regular, placed.orderId)).toEqual([
        { status: 'issued', total: 1190, tax_amount: 190, reverse_charge: false, kleinunternehmer: false, tax_note: null },
      ]);
    }
  });

  it('backtrack: the refused order pays once the buyer corrects the address, nothing placed again', async () => {
    const placed = await order(regular);
    await expectRefused(regular, placed, await payOrder(regular, placed.orderId, { buyer: swissBuyer() }), 'country');
    const answer = await payOrder(regular, placed.orderId, { buyer: buyer() });
    expect(answer).toMatchObject({ status: 200, body: { status: 'paid', receiptError: null } });
    expect((await paymentOf(regular, placed.orderId)).status).toBe('paid');
    expect(await documentsOf(regular, placed.orderId)).toHaveLength(1);
  });

  it('resume: a foreign buyer stored with the order is refused on a bare pay, then corrected', async () => {
    const placed = await order(regular, { buyer: austrianBusiness() });
    await expectRefused(regular, placed, await payOrder(regular, placed.orderId, {}), 'country');
    expect((await payOrder(regular, placed.orderId, { buyer: buyer() })).status).toBe(200);
  });

  it('re-entry: a paid order answers closed, whoever asks', async () => {
    const placed = await order(regular);
    expect((await payOrder(regular, placed.orderId, { buyer: buyer() })).status).toBe(200);
    expect(await payOrder(regular, placed.orderId, { buyer: swissBuyer() })).toMatchObject({
      status: 409,
      body: { error: { code: 'payment_closed' } },
    });
  });

  it('a hosted checkout is never opened for a refused buyer, and is for the corrected one', async () => {
    const fake = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;
    for (const key of ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CONNECT_CLIENT_ID']) vi.stubEnv(key, fake('test'));
    const sessions: unknown[] = [];
    const stripe = {
      createAccount: async () => ({ id: `acct_${randomBytes(6).toString('hex')}`, charges_enabled: false, details_submitted: false }),
      retrieveAccount: async (id: string) => ({ id, charges_enabled: true, details_submitted: true }),
      createAccountLink: async () => ({ url: 'https://connect.stripe.test/setup' }),
      createCheckoutSession: async (args: unknown) => {
        sessions.push(args);
        return { id: `cs_${randomBytes(6).toString('hex')}`, url: 'https://checkout.stripe.test/pay' };
      },
    } as unknown as StripeApi;
    state.stripe = stripe;
    try {
      const shop = regular;
      const onboarding = { tenantId: DEMO_COMPANY_ID, country: 'DE', refreshUrl: 'r', returnUrl: 'r' };
      await startOnboarding(shop.tenant.db, stripe, onboarding);
      await refreshAccount(shop.tenant.db, stripe, DEMO_COMPANY_ID);

      const placed = await order(shop);
      const { provider } = await shop.tenant.db
        .selectFrom('order_payment')
        .select('provider')
        .where('order_id', '=', placed.orderId)
        .executeTakeFirstOrThrow();
      expect(provider).toBe('stripe');

      await expectRefused(shop, placed, await payOrder(shop, placed.orderId, { buyer: austrianBusiness() }), 'country');
      expect(sessions).toEqual([]);

      expect(await payOrder(shop, placed.orderId, { buyer: buyer() })).toMatchObject({
        status: 200,
        body: { status: 'redirect', redirectUrl: 'https://checkout.stripe.test/pay' },
      });
      expect(sessions).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('pay for a company without Books: priced as a regular business', () => {
  it('refuses a foreign buyer before the money moves', async () => {
    const placed = await order(noBooks);
    await expectRefused(noBooks, placed, await payOrder(noBooks, placed.orderId, { buyer: austrianBusiness() }), 'country');
  });

  it('still takes a German buyer, whose receipt waits for the Books', async () => {
    const placed = await order(noBooks);
    expect(await payOrder(noBooks, placed.orderId, { buyer: buyer() })).toMatchObject({
      status: 200,
      body: { status: 'paid', receiptError: 'SETTINGS_MISSING' },
    });
  });
});

describe('pay under section 19: no VAT on any line, whoever buys', () => {
  it.each([
    ['an Austrian business with a VAT id', austrianBusiness],
    ['a Swiss buyer', swissBuyer],
    ['a German address with a foreign VAT id', () => buyer({ kind: 'organization', vatId: 'ATU12345678' })],
  ])('%s pays and gets a receipt that adds up to the payment', async (_label, makeBuyer) => {
    for (const basis of ['net', 'gross'] as const) {
      const placed = await order(smallBusiness, { basis });
      expect(placed.totalCents).toBe(1000);
      const answer = await payOrder(smallBusiness, placed.orderId, { buyer: makeBuyer() });
      expect(answer).toMatchObject({ status: 200, body: { status: 'paid', receiptError: null } });
      const [receipt] = await documentsOf(smallBusiness, placed.orderId);
      expect(receipt).toMatchObject({ status: 'issued', total: 1000, tax_amount: 0, reverse_charge: false, kleinunternehmer: true });
      expect(receipt.tax_note).toBeTruthy();
    }
  });

  it('a VAT id the Books would not store is refused, not found out after the payment', async () => {
    const placed = await order(smallBusiness);
    const answer = await payOrder(smallBusiness, placed.orderId, { buyer: buyer({ kind: 'organization', vatId: '12/345/67890' }) });
    await expectRefused(smallBusiness, placed, answer, 'vatId');
  });

  it('an order priced with VAT before the company set up its Books as a small business takes no foreign buyer', async () => {
    const shop = await newShop('refuse-late-small', null);
    const placed = await order(shop);
    expect(placed.totalCents).toBe(1190);
    await setUpBooks(shop, 'small_business');
    await expectRefused(shop, placed, await payOrder(shop, placed.orderId, { buyer: austrianBusiness() }), 'country');
  }, PROVISIONING_TIMEOUT);
});
