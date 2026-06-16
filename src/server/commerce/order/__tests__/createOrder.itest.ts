// src/server/commerce/order/__tests__/createOrder.itest.ts
//
// Integration test (Dockerized Postgres) for the b6 minimal-orders WRITE. It
// boots its OWN throwaway Postgres in beforeAll (testcontainers), applies EVERY
// migration (dt_* init + b2 ledger + b3 guarded reservation + b4 catalog + b5
// pricing/tax + b6 orders), and proves the 7 spec assertions against a LIVE
// database, because the correctness story (atomic rollback, snapshot stability,
// the finalized FK, the enum constraint) is Postgres semantics, not mockable:
//
//   1. a successful order SNAPSHOTS line prices (a later price change does NOT
//      alter the placed order),
//   2. totals are SERVER-computed integer cents, ignoring any client-sent total,
//   3. an order whose last line short-stocks rolls back the ENTIRE order and
//      creates ZERO reservations,
//   4. variant_ref_source accepts only none|datatable|owned (a 'medusa' value is
//      rejected by the Postgres enum),
//   5. a B2B reverse_charge order produces a zero-VAT marker + the legal notice,
//   6. a kleinunternehmer flag suppresses VAT and sets the Section 19 notice,
//   7. a CreditNote links to its corrected Order via the finalized FK, and the
//      Order cannot be DELETEd while a credit note references it (Restrict).
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

import { createOrder, type Cart } from '../createOrder';

let container: StartedTestContainer | undefined;
let prisma: PrismaClient | undefined;

function makeUrl(user: string, password: string, host: string, port: number): string {
  return `postgresql://${user}:${password}@${host}:${port}/framer_clone_test`;
}

beforeAll(async () => {
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'framer_clone_test',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const url = makeUrl('test', 'test', container.getHost(), container.getMappedPort(5432));

  // Apply every migration through b6.
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });

  prisma = new PrismaClient({ datasourceUrl: url });
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await container?.stop();
});

let suffixCounter = 0;
function suffix(): string {
  suffixCounter += 1;
  return `${suffixCounter}`;
}

/** Seed a product + variant + price_set + a base price (cents). Returns ids. */
async function seedPricedVariant(
  amountCents: number,
  opts: { currency?: string; taxClass?: string | null } = {},
): Promise<{ variantId: string; priceId: string }> {
  const p = prisma!;
  const product = await p.product.create({
    data: { title: `P-${suffix()}`, handle: `p-${suffix()}` },
  });
  const variant = await p.productVariant.create({
    data: {
      productId: product.id,
      title: `V-${suffix()}`,
      sku: `SKU-${suffix()}`,
      taxClass: opts.taxClass ?? null,
    },
  });
  const priceSet = await p.priceSet.create({ data: { variantId: variant.id } });
  const price = await p.price.create({
    data: {
      priceSetId: priceSet.id,
      currencyCode: opts.currency ?? 'EUR',
      amount: amountCents,
    },
  });
  return { variantId: variant.id, priceId: price.id };
}

/** Seed an inventory item + location + level with the given on-hand stock. */
async function seedStock(stocked: number): Promise<{ itemId: string; locationId: string }> {
  const p = prisma!;
  const item = await p.inventoryItem.create({ data: { sku: `INV-${suffix()}` } });
  const location = await p.stockLocation.create({ data: { name: `WH-${suffix()}` } });
  await p.inventoryLevel.create({
    data: {
      inventoryItemId: item.id,
      locationId: location.id,
      stockedQuantity: stocked,
      reservedQuantity: 0,
    },
  });
  return { itemId: item.id, locationId: location.id };
}

describe('b6 createOrder (Dockerized Postgres)', () => {
  it('snapshots line prices: a later price change does NOT alter the placed order', async () => {
    const { variantId, priceId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);

    const cart: Cart = {
      requestId: `snap-${suffix()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [{ inventoryItemId: itemId, variantId, quantity: 2, locationId }],
    };
    const result = await createOrder(prisma!, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const lineBefore = await prisma!.orderLineItem.findFirstOrThrow({
      where: { orderId: result.orderId },
    });
    expect(lineBefore.unitPrice).toBe(1000);

    // Change the live price AFTER the order is placed.
    await prisma!.price.update({ where: { id: priceId }, data: { amount: 5000 } });

    // The placed order's snapshot is unchanged: a reprint reproduces it exactly.
    const lineAfter = await prisma!.orderLineItem.findUniqueOrThrow({
      where: { id: lineBefore.id },
    });
    expect(lineAfter.unitPrice).toBe(1000);
    const order = await prisma!.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(order.subtotal).toBe(2000); // 1000 * 2, snapshotted
  });

  it('computes totals server-side in integer cents, ignoring any client-sent total', async () => {
    const { variantId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);

    const cart: Cart = {
      requestId: `srv-total-${suffix()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      // A wildly wrong client total: it MUST be ignored.
      clientTotal: 999999,
      lines: [{ inventoryItemId: itemId, variantId, quantity: 2, locationId }],
    };
    const result = await createOrder(prisma!, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const order = await prisma!.order.findUniqueOrThrow({ where: { id: result.orderId } });
    // net 2000 + 19% standard VAT (380) = 2380, NOT the client's 999999.
    expect(order.subtotal).toBe(2000);
    expect(order.taxAmount).toBe(380);
    expect(order.total).toBe(2380);
  });

  it('rolls back the ENTIRE order and creates zero reservations when the last line short-stocks', async () => {
    const a = await seedPricedVariant(1000);
    const b = await seedPricedVariant(2000);
    const stockA = await seedStock(10); // ample
    const stockB = await seedStock(1); // short: needs 5, has 1

    const requestId = `short-${suffix()}`;
    const cart: Cart = {
      requestId,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [
        { inventoryItemId: stockA.itemId, variantId: a.variantId, quantity: 3, locationId: stockA.locationId },
        { inventoryItemId: stockB.itemId, variantId: b.variantId, quantity: 5, locationId: stockB.locationId },
      ],
    };
    const result = await createOrder(prisma!, cart);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.shortages).toEqual([
      { inventoryItemId: stockB.itemId, locationId: stockB.locationId, needed: 5, available: 1 },
    ]);

    // The whole order rolled back: no order row, no line items.
    expect(await prisma!.order.findUnique({ where: { requestId } })).toBeNull();
    // Zero reservations / movements for EITHER per-line request_id (line A too).
    for (const i of [0, 1]) {
      expect(await prisma!.reservation.count({ where: { requestId: `${requestId}:${i}` } })).toBe(0);
      expect(await prisma!.stockMovement.count({ where: { requestId: `${requestId}:${i}` } })).toBe(0);
    }
    // Line A's stock is untouched: reserved still 0.
    const levelA = await prisma!.inventoryLevel.findUniqueOrThrow({
      where: { inventoryItemId_locationId: { inventoryItemId: stockA.itemId, locationId: stockA.locationId } },
    });
    expect(levelA.reservedQuantity).toBe(0);
  });

  it('variant_ref_source accepts none|datatable|owned and rejects medusa', async () => {
    const { variantId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);

    const cart: Cart = {
      requestId: `ref-${suffix()}`,
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
    };
    const result = await createOrder(prisma!, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const line = await prisma!.orderLineItem.findFirstOrThrow({ where: { orderId: result.orderId } });
    expect(line.variantRefSource).toBe('owned');
    expect(line.variantRef).toBe('owned-variant-123');

    // The Postgres enum rejects a 'medusa' value (NEVER medusa) via a raw insert.
    await expect(
      prisma!.$executeRawUnsafe(
        `INSERT INTO "commerce"."order_line_item"
           ("id","order_id","unit_price","quantity","subtotal","tax_rate","tax_amount","tax_treatment","variant_ref_source")
         VALUES ($1,$2,1,1,1,0,0,'standard','medusa')`,
        `bad-${suffix()}`,
        result.orderId,
      ),
    ).rejects.toThrow(/invalid input value for enum|medusa/i);
  });

  it('B2B reverse_charge: zero-VAT marker + the legal notice flag', async () => {
    const { variantId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);

    const cart: Cart = {
      requestId: `rc-${suffix()}`,
      currency: 'EUR',
      taxRegion: 'AT',
      customerType: 'b2b',
      vatId: 'ATU12345678',
      reverseCharge: true,
      lines: [{ inventoryItemId: itemId, variantId, quantity: 2, locationId }],
    };
    const result = await createOrder(prisma!, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const order = await prisma!.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(order.reverseCharge).toBe(true);
    expect(order.taxAmount).toBe(0); // zero-VAT marker
    expect(order.total).toBe(2000); // net == total (no VAT added)
    expect(order.taxNote).toContain('13b'); // the legal-notice flag (Section 13b)

    const line = await prisma!.orderLineItem.findFirstOrThrow({ where: { orderId: result.orderId } });
    expect(line.taxTreatment).toBe('reverse_charge');
    expect(line.taxAmount).toBe(0);
  });

  it('kleinunternehmer: suppresses VAT and sets the Section 19 notice', async () => {
    const { variantId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);

    const cart: Cart = {
      requestId: `klein-${suffix()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      kleinunternehmer: true,
      lines: [{ inventoryItemId: itemId, variantId, quantity: 3, locationId }],
    };
    const result = await createOrder(prisma!, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const order = await prisma!.order.findUniqueOrThrow({ where: { id: result.orderId } });
    expect(order.kleinunternehmer).toBe(true);
    expect(order.taxAmount).toBe(0); // VAT suppressed
    expect(order.total).toBe(3000);
    expect(order.taxNote).toContain('19'); // Section 19 notice

    const line = await prisma!.orderLineItem.findFirstOrThrow({ where: { orderId: result.orderId } });
    expect(line.taxTreatment).toBe('kleinunternehmer');
    expect(line.taxAmount).toBe(0);
  });

  it('a CreditNote links to its corrected Order via the finalized FK (no DELETE path for the invoice)', async () => {
    const { variantId } = await seedPricedVariant(1000);
    const { itemId, locationId } = await seedStock(10);

    const cart: Cart = {
      requestId: `cn-${suffix()}`,
      currency: 'EUR',
      taxRegion: 'DE',
      lines: [{ inventoryItemId: itemId, variantId, quantity: 1, locationId }],
    };
    const result = await createOrder(prisma!, cart);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // The credit note carries the HARD FK to the corrected Order.
    const creditNote = await prisma!.creditNote.create({
      data: {
        orderId: result.orderId,
        correctedRef: result.orderId,
        reason: 'price correction',
        currencyCode: 'EUR',
        amount: 1190,
      },
    });
    const linked = await prisma!.creditNote.findUniqueOrThrow({
      where: { id: creditNote.id },
      include: { order: true },
    });
    expect(linked.order?.id).toBe(result.orderId);

    // No DELETE path for the invoice: the FK is ON DELETE RESTRICT, so an Order a
    // credit note corrects can never be erased.
    await expect(prisma!.order.delete({ where: { id: result.orderId } })).rejects.toThrow();
  });
});
