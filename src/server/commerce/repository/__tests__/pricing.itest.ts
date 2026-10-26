// src/server/commerce/repository/__tests__/pricing.itest.ts
//
// Integration test (Dockerized Postgres) for the pricing graph, the
// catalog-side tax_class and the append-only credit note, run against a REAL
// provisioned company schema (tg_<hex32>) through the scoped Kysely handle. It
// runs on the SHARED integration database (vitest.integration.setup.ts) and
// provisions its own tenant group, so it boots no container of its own.
//
// Ported in CM-13 from the retired Prisma suite of the same name:
//   1. price amounts round-trip as integer cents; a float is rejected,
//   2. resolvePrice returns integer cents, prefers an active requested price-list
//      price over the base, ignores a draft list, and returns null for a variant
//      without a price_set,
//   3. the database CHECKs bite even when the repository guard is bypassed
//      (negative amount, negative credit note, inverted / negative band,
//      mis-cased currency), while a well-formed row inserts,
//   4. tax_class is set and read on product and variant (nullable),
//   5. a credit note is append-only for commerce_app: INSERT / SELECT allowed,
//      UPDATE / DELETE denied (the no-DELETE contract), on the junction too.
//
// The resolution rules themselves (window, band, tie-break) are unit-pinned in
// pricing.test.ts; the schema wall in pricing.isolation.itest.ts.

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
import { catalogRepository } from '../catalog';
import { pricingRepository } from '../pricing';
import { DEMO_COMPANY_ID } from '@/lib/renderer/server/demoTenant';

let fx: StorefrontFixtures;
let db: Kysely<CommerceDB>;
let appBase: Kysely<CommerceDB>;
let appDb: Kysely<CommerceDB>;

beforeAll(async () => {
  fx = openStorefrontFixtures();
  const tenant = await provisionCommerceTenant(fx, 'cm13-pricing');
  db = tenant.db;
  appBase = openCommerceAppBase();
  appDb = tenantDb(appBase, tenant.tgId);
}, 120_000);

afterAll(async () => {
  await appBase?.destroy();
  await fx?.close();
});

/** Create a product + a single variant through the catalog repo; returns the variant id. */
async function makeVariant(handle: string, sku: string): Promise<string> {
  const product = await catalogRepository.createProduct(db, { tenantId: DEMO_COMPANY_ID, title: handle, handle });
  const variant = await catalogRepository.addVariant(db, { tenantId: DEMO_COMPANY_ID, productId: product.id, sku });
  return variant.id;
}

async function makeList(status: 'draft' | 'active', type: 'override' | 'sale'): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto('price_list')
    .values({ id, title: `${status}-${type}`, status, type, updated_at: new Date() })
    .execute();
  return id;
}

describe('pricing graph + tax_class + credit note (tenant schema, Dockerized Postgres)', () => {
  it('price amounts round-trip as integer cents and a float amount is rejected', async () => {
    const variantId = await makeVariant('tee-cents', 'TEE-CENTS-1');
    const priceSet = await pricingRepository.createPriceSet(db, { tenantId: DEMO_COMPANY_ID, variantId });

    const created = await pricingRepository.addPrice(db, { tenantId: DEMO_COMPANY_ID,
      priceSetId: priceSet.id,
      currency: 'EUR',
      amount: 1999,
    });
    expect(created.amount).toBe(1999);

    const reread = await db
      .selectFrom('price')
      .select('amount')
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(reread.amount).toBe(1999);
    expect(Number.isInteger(reread.amount)).toBe(true);

    expect(() =>
      pricingRepository.addPrice(db, { tenantId: DEMO_COMPANY_ID, priceSetId: priceSet.id, currency: 'EUR', amount: 19.99 }),
    ).toThrow(/integer number of minor units/);
  });

  it('resolvePrice returns integer cents and prefers an active requested price-list price over the base', async () => {
    const variantId = await makeVariant('hoodie-resolve', 'HOOD-RES-1');
    const priceSet = await pricingRepository.createPriceSet(db, { tenantId: DEMO_COMPANY_ID, variantId });
    await pricingRepository.addPrice(db, { tenantId: DEMO_COMPANY_ID, priceSetId: priceSet.id, currency: 'EUR', amount: 2000 });

    const sale = await makeList('active', 'sale');
    await pricingRepository.addPrice(db, { tenantId: DEMO_COMPANY_ID,
      priceSetId: priceSet.id,
      currency: 'EUR',
      amount: 1500,
      priceListId: sale,
    });

    const withList = await pricingRepository.resolvePrice(db, variantId, {
      currency: 'EUR',
      priceListIds: [sale],
    });
    expect(withList).toBe(1500);
    expect(Number.isInteger(withList)).toBe(true);
    expect(await pricingRepository.resolvePrice(db, variantId, { currency: 'EUR' })).toBe(2000);
    // A currency with no price resolves to null, not to a converted amount.
    expect(await pricingRepository.resolvePrice(db, variantId, { currency: 'USD' })).toBeNull();

    // A draft list is invisible even when requested: its 1000 override is ignored.
    const draft = await makeList('draft', 'override');
    await pricingRepository.addPrice(db, { tenantId: DEMO_COMPANY_ID,
      priceSetId: priceSet.id,
      currency: 'EUR',
      amount: 1000,
      priceListId: draft,
    });
    expect(
      await pricingRepository.resolvePrice(db, variantId, { currency: 'EUR', priceListIds: [draft] }),
    ).toBe(2000);

    // A list whose window lies in the past is ignored against a real timestamp.
    const expired = randomUUID();
    await db
      .insertInto('price_list')
      .values({
        id: expired,
        title: 'expired',
        status: 'active',
        type: 'sale',
        starts_at: new Date('2026-01-01T00:00:00.000Z'),
        ends_at: new Date('2026-01-31T00:00:00.000Z'),
        updated_at: new Date(),
      })
      .execute();
    await pricingRepository.addPrice(db, { tenantId: DEMO_COMPANY_ID,
      priceSetId: priceSet.id,
      currency: 'EUR',
      amount: 900,
      priceListId: expired,
    });
    expect(
      await pricingRepository.resolvePrice(db, variantId, {
        currency: 'EUR',
        priceListIds: [expired],
        now: new Date('2026-06-15T12:00:00.000Z'),
      }),
    ).toBe(2000);

    const orphan = await makeVariant('orphan-resolve', 'ORPH-RES-1');
    expect(await pricingRepository.resolvePrice(db, orphan, { currency: 'EUR' })).toBeNull();
  });

  it('the database CHECKs bite with the repository guard bypassed; a well-formed row still inserts', async () => {
    const variantId = await makeVariant('tee-checks', 'TEE-CHECKS-1');
    const priceSet = await pricingRepository.createPriceSet(db, { tenantId: DEMO_COMPANY_ID, variantId });
    const rawPrice = (over: { amount?: number; currency?: string; min?: number; max?: number }) =>
      db
        .insertInto('price')
        .values({ tenant_id: DEMO_COMPANY_ID,
          id: randomUUID(),
          price_set_id: priceSet.id,
          currency_code: over.currency ?? 'EUR',
          amount: over.amount ?? 1000,
          min_quantity: over.min ?? null,
          max_quantity: over.max ?? null,
          updated_at: new Date(),
        })
        .execute();

    await expect(rawPrice({ amount: -1 })).rejects.toThrow(/price_amount_nonneg_check/);
    await expect(rawPrice({ min: 5, max: 3 })).rejects.toThrow(/price_quantity_band_check/);
    await expect(rawPrice({ min: -1 })).rejects.toThrow(/price_min_quantity_nonneg_check/);
    await expect(rawPrice({ currency: 'eur' })).rejects.toThrow(/check constraint/);
    await expect(
      db
        .insertInto('credit_note')
        .values({ id: randomUUID(), currency_code: 'EUR', amount: -1 })
        .execute(),
    ).rejects.toThrow(/credit_note_amount_nonneg_check/);

    const ok = await pricingRepository.addPrice(db, { tenantId: DEMO_COMPANY_ID,
      priceSetId: priceSet.id,
      currency: 'EUR',
      amount: 1000,
      minQuantity: 1,
      maxQuantity: 10,
    });
    expect(ok.amount).toBe(1000);
  });

  it('tax_class is set and read on product and variant (nullable)', async () => {
    const product = await catalogRepository.createProduct(db, { tenantId: DEMO_COMPANY_ID, title: 'Book', handle: 'book-tax' });
    const variant = await catalogRepository.addVariant(db, { tenantId: DEMO_COMPANY_ID, productId: product.id, sku: 'BOOK-TAX-1' });

    await db.updateTable('product').set({ tax_class: 'reduced' }).where('id', '=', product.id).execute();
    await db
      .updateTable('product_variant')
      .set({ tax_class: 'standard' })
      .where('id', '=', variant.id)
      .execute();

    const p = await db.selectFrom('product').select('tax_class').where('id', '=', product.id).executeTakeFirstOrThrow();
    const v = await db
      .selectFrom('product_variant')
      .select('tax_class')
      .where('id', '=', variant.id)
      .executeTakeFirstOrThrow();
    expect(p.tax_class).toBe('reduced');
    expect(v.tax_class).toBe('standard');

    const bare = await catalogRepository.addVariant(db, { tenantId: DEMO_COMPANY_ID, productId: product.id, sku: 'BOOK-TAX-2' });
    expect(bare.tax_class).toBeNull();
  });

  it('a credit note is append-only for commerce_app: INSERT/SELECT allowed, UPDATE/DELETE denied', async () => {
    const noteId = randomUUID();
    await db
      .insertInto('credit_note')
      .values({
        id: noteId,
        currency_code: 'EUR',
        amount: 1999,
        reason: 'Storno: wrong address',
        corrected_ref: 'order-placeholder-id',
      })
      .execute();
    await db
      .insertInto('credit_note_ref')
      .values({ id: randomUUID(), credit_note_id: noteId, ref_type: 'order', ref_id: 'order-placeholder-id' })
      .execute();

    // commerce_app may SELECT the credit note and INSERT a new one.
    const seen = await appDb.selectFrom('credit_note').select('id').where('id', '=', noteId).execute();
    expect(seen).toHaveLength(1);
    await appDb
      .insertInto('credit_note')
      .values({ id: randomUUID(), currency_code: 'EUR', amount: 500 })
      .execute();

    // ...but may NOT UPDATE or DELETE it, nor DELETE its junction (SQLSTATE 42501).
    await expect(
      appDb.updateTable('credit_note').set({ reason: 'tampered' }).where('id', '=', noteId).execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(appDb.deleteFrom('credit_note').where('id', '=', noteId).execute()).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      appDb.deleteFrom('credit_note_ref').where('credit_note_id', '=', noteId).execute(),
    ).rejects.toThrow(/permission denied/);

    const refs = await db
      .selectFrom('credit_note_ref')
      .select('id')
      .where('credit_note_id', '=', noteId)
      .execute();
    expect(refs).toHaveLength(1);
    const survived = await db
      .selectFrom('credit_note')
      .select('reason')
      .where('id', '=', noteId)
      .executeTakeFirstOrThrow();
    expect(survived.reason).toBe('Storno: wrong address');
  });
});
