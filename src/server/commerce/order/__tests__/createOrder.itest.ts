// src/server/commerce/order/__tests__/createOrder.itest.ts
//
// Integration test (Dockerized Postgres) for the server-authoritative order
// WRITE, run against a REAL provisioned company schema (tg_<hex32>) through the
// scoped Kysely handle, because the correctness story (atomic rollback, snapshot
// stability, the RESTRICT FK, the enum, the role REVOKEs) is Postgres semantics,
// not mockable. It runs on the SHARED integration database
// (vitest.integration.setup.ts) and provisions its own tenant group, so it boots
// no container of its own.
//
// Ported in CM-13 from the retired Prisma suite of the same name; every case is
// kept:
//   1. a placed order SNAPSHOTS line prices (a later price change does NOT alter
//      it),
//   2. totals are SERVER-computed integer cents, ignoring any client-sent total,
//   3. a short last line rolls back the ENTIRE order with ZERO reservations,
//   4. variant_ref_source accepts none|datatable|owned and the enum rejects
//      'medusa',
//   5. a B2B reverse-charge order carries the zero-VAT marker and the 13b notice,
//   6. kleinunternehmer suppresses VAT and carries the Section 19 notice,
//   7. a credit note links to its corrected order through the RESTRICT FK (the
//      order cannot be deleted),
//   8. order-level idempotency, sequential and concurrent (one order, one
//      reservation, reserved bumped once),
//   9. commerce_app may not DELETE an order or UPDATE an order / line (42501),
//  10. money math against the database: gross extraction, reduced 7%, zero rate,
//      and a two-line order whose totals are the sum of its snapshot rows.
//
// The schema wall, the backorder line and the total = subtotal + tax_amount CHECK
// are in createOrder.isolation.itest.ts; the control flow in createOrder.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { tenantDb } from '@marlinjai/tenant-db';

import type { CommerceDB } from '../../db-types';
import {
  openCommerceAppBase,
  openStorefrontFixtures,
  provisionCommerceTenant,
  type StorefrontFixtures,
} from '../../__tests__/storefrontFixtures';
import { createOrder, type Cart } from '../createOrder';

let fx: StorefrontFixtures;
let db: Kysely<CommerceDB>;
let tgId: string;
let appBase: Kysely<CommerceDB>;
let appDb: Kysely<CommerceDB>;

beforeAll(async () => {
  fx = openStorefrontFixtures();
  const tenant = await provisionCommerceTenant(fx, 'cm13-orders');
  db = tenant.db;
  tgId = tenant.tgId;
  appBase = openCommerceAppBase();
  appDb = tenantDb(appBase, tenant.tgId);
}, 120_000);

afterAll(async () => {
  await appBase?.destroy();
  await fx?.close();
});

/** Seed a product + variant + price_set + a base price (cents). */
async function seedPricedVariant(
  amountCents: number,
  opts: { currency?: string; taxClass?: string | null } = {},
): Promise<{ variantId: string; priceId: string }> {
  const now = new Date();
  const productId = randomUUID();
  await db
    .insertInto('product')
    .values({ id: productId, title: 'P', handle: `p-${randomUUID()}`, updated_at: now })
    .execute();
  const variantId = randomUUID();
  await db
    .insertInto('product_variant')
    .values({
      id: variantId,
      product_id: productId,
      title: `V-${variantId.slice(0, 6)}`,
      sku: `SKU-${randomUUID()}`,
      tax_class: opts.taxClass ?? null,
      updated_at: now,
    })
    .execute();
  const priceSetId = randomUUID();
  await db.insertInto('price_set').values({ id: priceSetId, variant_id: variantId, updated_at: now }).execute();
  const priceId = randomUUID();
  await db
    .insertInto('price')
    .values({
      id: priceId,
      price_set_id: priceSetId,
      currency_code: opts.currency ?? 'EUR',
      amount: amountCents,
      updated_at: now,
    })
    .execute();
  return { variantId, priceId };
}

/** Seed an inventory item + location + level with the given on-hand stock. */
async function seedStock(stocked: number): Promise<{ itemId: string; locationId: string }> {
  const now = new Date();
  const itemId = randomUUID();
  await db.insertInto('inventory_item').values({ id: itemId, sku: `INV-${randomUUID()}`, updated_at: now }).execute();
  const locationId = randomUUID();
  await db
    .insertInto('stock_location')
    .values({ id: locationId, name: `WH-${randomUUID()}`, updated_at: now })
    .execute();
  await db
    .insertInto('inventory_level')
    .values({
      id: randomUUID(),
      inventory_item_id: itemId,
      location_id: locationId,
      stocked_quantity: stocked,
      reserved_quantity: 0,
      updated_at: now,
    })
    .execute();
  return { itemId, locationId };
}

/** Place a one-line order and return its id (fails the test on ok:false). */
async function placeOneLine(
  line: { quantity: number; amountCents: number; taxClass?: string | null },
  cartExtras: Partial<Omit<Cart, 'lines'>> = {},
): Promise<string> {
  const { variantId } = await seedPricedVariant(line.amountCents, { taxClass: line.taxClass });
  const { itemId, locationId } = await seedStock(10);
  const result = await createOrder(db, tgId, {
    requestId: `order-${randomUUID()}`,
    currency: 'EUR',
    taxRegion: 'DE',
    ...cartExtras,
    lines: [{ inventoryItemId: itemId, variantId, quantity: line.quantity, locationId }],
  });
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.orderId;
}

async function readOrder(orderId: string) {
  return db.selectFrom('order').selectAll().where('id', '=', orderId).executeTakeFirstOrThrow();
}

async function readLines(orderId: string) {
  return db
    .selectFrom('order_line_item')
    .selectAll()
    .where('order_id', '=', orderId)
    .orderBy('subtotal', 'asc')
    .execute();
}

async function count(table: 'reservation' | 'stock_movement' | 'order', requestId: string): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select((eb) => eb.fn.countAll().as('c'))
    .where('request_id', '=', requestId)
    .executeTakeFirstOrThrow();
  return Number(row.c);
}

async function reservedOf(itemId: string, locationId: string): Promise<number> {
  const row = await db
    .selectFrom('inventory_level')
    .select('reserved_quantity')
    .where('inventory_item_id', '=', itemId)
    .where('location_id', '=', locationId)
    .executeTakeFirstOrThrow();
  return row.reserved_quantity;
}

describe('createOrder (tenant schema, Dockerized Postgres)', () => {
  it('snapshots line prices: a later price change does NOT alter the placed order', async () => {
    const { variantId, priceId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);
    const result = await createOrder(db, tgId, {
      requestId: `snap-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [{ inventoryItemId: itemId, variantId, quantity: 2, locationId }],
    });
    if (!result.ok) throw new Error('unreachable');

    const [lineBefore] = await readLines(result.orderId);
    expect(lineBefore.unit_price).toBe(1000);

    await db.updateTable('price').set({ amount: 5000 }).where('id', '=', priceId).execute();

    const [lineAfter] = await readLines(result.orderId);
    expect(lineAfter.unit_price).toBe(1000);
    expect((await readOrder(result.orderId)).subtotal).toBe(2000);
  });

  it('computes totals server-side in integer cents, ignoring any client-sent total', async () => {
    const orderId = await placeOneLine({ quantity: 2, amountCents: 1000 }, { clientTotal: 999999 });
    const order = await readOrder(orderId);
    expect(order.subtotal).toBe(2000);
    expect(order.tax_amount).toBe(380);
    expect(order.total).toBe(2380);
    expect(order.order_number).toMatch(/^ORD-\d{6}$/);
  });

  it('rolls back the ENTIRE order and creates zero reservations when the last line short-stocks', async () => {
    const a = await seedPricedVariant(1000);
    const b = await seedPricedVariant(2000);
    const stockA = await seedStock(10);
    const stockB = await seedStock(1);
    const requestId = `short-${randomUUID()}`;

    const result = await createOrder(db, tgId, {
      requestId,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        { inventoryItemId: stockA.itemId, variantId: a.variantId, quantity: 3, locationId: stockA.locationId },
        { inventoryItemId: stockB.itemId, variantId: b.variantId, quantity: 5, locationId: stockB.locationId },
      ],
    });
    expect(result).toEqual({
      ok: false,
      shortages: [{ inventoryItemId: stockB.itemId, locationId: stockB.locationId, needed: 5, available: 1 }],
    });

    expect(await count('order', requestId)).toBe(0);
    for (const i of [0, 1]) {
      expect(await count('reservation', `${requestId}:${i}`)).toBe(0);
      expect(await count('stock_movement', `${requestId}:${i}`)).toBe(0);
    }
    expect(await reservedOf(stockA.itemId, stockA.locationId)).toBe(0);
  });

  it('variant_ref_source accepts none|datatable|owned and rejects medusa', async () => {
    const { variantId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);
    const result = await createOrder(db, tgId, {
      requestId: `ref-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        {
          inventoryItemId: itemId,
          variantId,
          quantity: 1,
          locationId,
          variantRef: 'owned-variant-123',
          variantRefSource: 'owned',
        },
      ],
    });
    if (!result.ok) throw new Error('unreachable');

    const [line] = await readLines(result.orderId);
    expect(line.variant_ref_source).toBe('owned');
    expect(line.variant_ref).toBe('owned-variant-123');

    await expect(
      db
        .insertInto('order_line_item')
        .values({
          id: randomUUID(),
          order_id: result.orderId,
          unit_price: 1,
          quantity: 1,
          subtotal: 1,
          tax_rate: 0,
          tax_amount: 0,
          tax_treatment: 'standard',
          variant_ref_source: 'medusa' as never,
        })
        .execute(),
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it('B2B reverse_charge: zero-VAT marker + the legal notice flag', async () => {
    const orderId = await placeOneLine(
      { quantity: 2, amountCents: 1000 },
      { taxRegion: 'AT', customerType: 'b2b', vatId: 'ATU12345678', reverseCharge: true },
    );
    const order = await readOrder(orderId);
    expect(order.reverse_charge).toBe(true);
    expect(order.customer_type).toBe('b2b');
    expect(order.vat_id).toBe('ATU12345678');
    expect(order.tax_amount).toBe(0);
    expect(order.total).toBe(2000);
    expect(order.tax_note).toContain('13b');

    const [line] = await readLines(orderId);
    expect(line.tax_treatment).toBe('reverse_charge');
    expect(line.tax_amount).toBe(0);
  });

  it('kleinunternehmer: suppresses VAT and sets the Section 19 notice', async () => {
    const orderId = await placeOneLine({ quantity: 3, amountCents: 1000 }, { kleinunternehmer: true });
    const order = await readOrder(orderId);
    expect(order.kleinunternehmer).toBe(true);
    expect(order.tax_amount).toBe(0);
    expect(order.total).toBe(3000);
    expect(order.tax_note).toContain('19');

    const [line] = await readLines(orderId);
    expect(line.tax_treatment).toBe('kleinunternehmer');
    expect(line.tax_amount).toBe(0);
  });

  it('a credit note links to its corrected order via the RESTRICT FK (no DELETE path for the invoice)', async () => {
    const orderId = await placeOneLine({ quantity: 1, amountCents: 1000 });
    const noteId = randomUUID();
    await db
      .insertInto('credit_note')
      .values({
        id: noteId,
        order_id: orderId,
        corrected_ref: orderId,
        reason: 'price correction',
        currency_code: 'EUR',
        amount: 1190,
      })
      .execute();
    const linked = await db
      .selectFrom('credit_note')
      .innerJoin('order', 'order.id', 'credit_note.order_id')
      .select('order.id as order_id')
      .where('credit_note.id', '=', noteId)
      .executeTakeFirstOrThrow();
    expect(linked.order_id).toBe(orderId);

    // Even the owner role cannot delete an order a credit note corrects.
    await expect(db.deleteFrom('order').where('id', '=', orderId).execute()).rejects.toThrow(
      /foreign key|violates/,
    );
  });

  it('idempotency (sequential): a duplicate requestId returns the SAME orderId, one order, one reservation', async () => {
    const { variantId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);
    const requestId = `idem-seq-${randomUUID()}`;
    const cart: Cart = {
      requestId,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [{ inventoryItemId: itemId, variantId, quantity: 2, locationId }],
    };

    const first = await createOrder(db, tgId, cart);
    const second = await createOrder(db, tgId, cart);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.orderId).toBe(first.orderId);
    expect(await count('order', requestId)).toBe(1);
    expect(await count('reservation', `${requestId}:0`)).toBe(1);
    expect(await count('stock_movement', `${requestId}:0`)).toBe(1);
    expect(await reservedOf(itemId, locationId)).toBe(2);
  });

  it('idempotency (concurrent): two createOrder with the SAME requestId return the SAME orderId, no double reservation', async () => {
    const { variantId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(50);
    const requestId = `idem-conc-${randomUUID()}`;
    const cart: Cart = {
      requestId,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [{ inventoryItemId: itemId, variantId, quantity: 3, locationId }],
    };

    const [a, b] = await Promise.all([createOrder(db, tgId, cart), createOrder(db, tgId, cart)]);
    if (!a.ok || !b.ok) throw new Error(`expected both ok, got ${JSON.stringify([a, b])}`);
    expect(a.orderId).toBe(b.orderId);
    expect(await count('order', requestId)).toBe(1);
    expect(await count('reservation', `${requestId}:0`)).toBe(1);
    expect(await count('stock_movement', `${requestId}:0`)).toBe(1);
    expect(await reservedOf(itemId, locationId)).toBe(3);
  });

  it('commerce_app: DELETE on an order (no credit note) and UPDATE on an order or line are denied (42501)', async () => {
    const orderId = await placeOneLine({ quantity: 1, amountCents: 1000 });
    const [line] = await readLines(orderId);

    await expect(appDb.deleteFrom('order').where('id', '=', orderId).execute()).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appDb.updateTable('order_line_item').set({ quantity: 99 }).where('id', '=', line.id).execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(
      appDb.updateTable('order').set({ status: 'cancelled' }).where('id', '=', orderId).execute(),
    ).rejects.toThrow(/permission denied/);

    expect((await readOrder(orderId)).status).toBe('confirmed');
  });

  it('commerce_app can PLACE an order end to end (the role the storefront route uses)', async () => {
    const { variantId } = await seedPricedVariant(1500);
    const { itemId, locationId } = await seedStock(4);
    const result = await createOrder(appDb, tgId, {
      requestId: `app-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [{ inventoryItemId: itemId, variantId, quantity: 4, locationId }],
    });
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect((await readOrder(result.orderId)).total).toBe(7140); // 6000 + 19%
    expect(await reservedOf(itemId, locationId)).toBe(4);
  });

  it('money-math: gross-price extraction (1190 gross @ 1900bps -> tax=190, net=1000)', async () => {
    const orderId = await placeOneLine({ quantity: 1, amountCents: 1190 }, { netOrGross: 'gross' });
    const order = await readOrder(orderId);
    expect(order.net_or_gross).toBe('gross');
    expect(order.subtotal).toBe(1000);
    expect(order.tax_amount).toBe(190);
    expect(order.total).toBe(1190);
    const [line] = await readLines(orderId);
    expect(line.tax_rate).toBe(1900);
    expect(line.tax_treatment).toBe('standard');
  });

  it('money-math: reduced 7% (taxClass=reduced) snapshots rate 700 + treatment reduced', async () => {
    const orderId = await placeOneLine({ quantity: 1, amountCents: 1000, taxClass: 'reduced' });
    const order = await readOrder(orderId);
    expect(order.subtotal).toBe(1000);
    expect(order.tax_amount).toBe(70);
    expect(order.total).toBe(1070);
    const [line] = await readLines(orderId);
    expect(line.tax_rate).toBe(700);
    expect(line.tax_class).toBe('reduced');
    expect(line.tax_treatment).toBe('reduced');
  });

  it('money-math: zero rate (taxClass=zero) snapshots rate 0 + treatment zero, no VAT', async () => {
    const orderId = await placeOneLine({ quantity: 2, amountCents: 1000, taxClass: 'zero' });
    const order = await readOrder(orderId);
    expect(order.subtotal).toBe(2000);
    expect(order.tax_amount).toBe(0);
    expect(order.total).toBe(2000);
    const [line] = await readLines(orderId);
    expect(line.tax_rate).toBe(0);
    expect(line.tax_treatment).toBe('zero');
  });

  it('money-math: a 2-line order sums line nets/taxes into the order totals with two snapshot rows', async () => {
    const a = await seedPricedVariant(1000);
    const b = await seedPricedVariant(2000, { taxClass: 'reduced' });
    const stockA = await seedStock(10);
    const stockB = await seedStock(10);
    const result = await createOrder(db, tgId, {
      requestId: `two-line-${randomUUID()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        { inventoryItemId: stockA.itemId, variantId: a.variantId, quantity: 2, locationId: stockA.locationId },
        { inventoryItemId: stockB.itemId, variantId: b.variantId, quantity: 3, locationId: stockB.locationId },
      ],
    });
    if (!result.ok) throw new Error('unreachable');

    const lines = await readLines(result.orderId);
    expect(lines).toHaveLength(2);
    const sumNets = lines.reduce((acc, l) => acc + l.subtotal, 0);
    const sumTaxes = lines.reduce((acc, l) => acc + l.tax_amount, 0);
    expect(sumNets).toBe(8000);
    expect(sumTaxes).toBe(800);

    const order = await readOrder(result.orderId);
    expect(order.subtotal).toBe(sumNets);
    expect(order.tax_amount).toBe(sumTaxes);
    expect(order.total).toBe(order.subtotal + order.tax_amount);
    expect(order.total).toBe(8800);
  });
});
