// src/server/commerce/repository/__tests__/catalog.itest.ts
//
// Integration test (Dockerized Postgres) for the catalog repository and the
// catalog guarantees of migration 003_catalog, run against a REAL provisioned
// company schema (tg_<hex32>) through the scoped Kysely handle. It runs on the
// SHARED integration database (vitest.integration.setup.ts) and provisions its
// own tenant group, so it boots no container of its own.
//
// Ported in CM-13 from the retired Prisma suite of the same name; every case is
// kept:
//   1. the composite FK rejects a matrix row whose value belongs to another
//      option, and accepts the correct pairing,
//   2. two variants with the same option combination collide on option_signature
//      (the rejected write rolls back),
//   3. editing a variant's options recomputes the signature and frees the old
//      combination,
//   4. a soft-deleted handle frees the partial-unique,
//   5. matrix-only writes (never touching the variant row) recompute the
//      signature and reject a duplicate combination (path independence),
//   6. a two-axis combination written in the opposite order collides (the
//      signature is the SORTED join of the value ids),
//   7. the sku and barcode partial-uniques reject a live duplicate and free on
//      soft-delete,
//   8. soft-deleting a variant frees its option combination.
//
// The schema wall (tg_a vs tg_b vs a public decoy) is catalog.isolation.itest.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';

import type { CommerceDB } from '../../db-types';
import {
  openStorefrontFixtures,
  provisionCommerceTenant,
  type StorefrontFixtures,
} from '../../__tests__/storefrontFixtures';
import { catalogRepository } from '../catalog';

let fx: StorefrontFixtures;
let db: Kysely<CommerceDB>;

beforeAll(async () => {
  fx = openStorefrontFixtures();
  db = (await provisionCommerceTenant(fx, 'cm13-catalog')).db;
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

const SIGNATURE_COLLISION = /product_variant_option_signature_active_key|duplicate key/;

/** Read the trigger-maintained option_signature column. */
async function readSignature(variantId: string): Promise<string | null> {
  const row = await db
    .selectFrom('product_variant')
    .select('option_signature')
    .where('id', '=', variantId)
    .executeTakeFirstOrThrow();
  return row.option_signature;
}

async function softDeleteVariant(id: string): Promise<void> {
  await db.updateTable('product_variant').set({ deleted_at: new Date() }).where('id', '=', id).execute();
}

/** A product with one option and the given values. */
async function productWithOption(handle: string, values: string[]) {
  const product = await catalogRepository.createProduct(db, { title: handle, handle });
  const option = await catalogRepository.addOption(db, { productId: product.id, title: 'Color' });
  const optionValues = [];
  for (const value of values) {
    optionValues.push(await catalogRepository.addOptionValue(db, { optionId: option.id, value }));
  }
  return { product, option, values: optionValues };
}

describe('catalog repository + 003_catalog guarantees (tenant schema, Dockerized Postgres)', () => {
  it('the composite FK rejects a product_variant_option with a mismatched option_id', async () => {
    const { product, option: color, values } = await productWithOption('tee-fk', ['Red']);
    const red = values[0];
    const size = await catalogRepository.addOption(db, { productId: product.id, title: 'Size' });
    const variant = await catalogRepository.addVariant(db, { productId: product.id, sku: 'TEE-FK-1' });

    // 'Red' belongs to Color, attached under Size: (red.id, size.id) is not a real
    // (id, option_id) pair, so the composite FK rejects it (SQLSTATE 23503).
    await expect(
      catalogRepository.setVariantOptions(db, variant.id, [{ optionId: size.id, optionValueId: red.id }]),
    ).rejects.toThrow(/product_variant_option_option_value_id_option_id_fkey|foreign key/);

    // The correct pairing is accepted: the FK rejects ONLY the mismatch.
    await catalogRepository.setVariantOptions(db, variant.id, [{ optionId: color.id, optionValueId: red.id }]);
    const rows = await db
      .selectFrom('product_variant_option')
      .select('option_id')
      .where('variant_id', '=', variant.id)
      .execute();
    expect(rows).toEqual([{ option_id: color.id }]);
  });

  it('two variants with the same option combination collide on option_signature', async () => {
    const { product, option: color, values } = await productWithOption('hoodie-sig', ['Red']);
    const red = values[0];
    const v1 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'HOOD-SIG-1' });
    const v2 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'HOOD-SIG-2' });

    await catalogRepository.setVariantOptions(db, v1.id, [{ optionId: color.id, optionValueId: red.id }]);
    expect(await readSignature(v1.id)).toBe(red.id);

    await expect(
      catalogRepository.setVariantOptions(db, v2.id, [{ optionId: color.id, optionValueId: red.id }]),
    ).rejects.toThrow(SIGNATURE_COLLISION);
    // The rejected transaction rolled back: v2 has no signature and no matrix row.
    expect(await readSignature(v2.id)).toBeNull();
  });

  it('editing a variant options recomputes the signature and frees the old combination', async () => {
    const { product, option: color, values } = await productWithOption('cap-recompute', ['Red', 'Blue']);
    const [red, blue] = values;
    const v = await catalogRepository.addVariant(db, { productId: product.id, sku: 'CAP-RC-1' });

    await catalogRepository.setVariantOptions(db, v.id, [{ optionId: color.id, optionValueId: red.id }]);
    expect(await readSignature(v.id)).toBe(red.id);
    await catalogRepository.setVariantOptions(db, v.id, [{ optionId: color.id, optionValueId: blue.id }]);
    expect(await readSignature(v.id)).toBe(blue.id);

    const other = await catalogRepository.addVariant(db, { productId: product.id, sku: 'CAP-RC-2' });
    await catalogRepository.setVariantOptions(db, other.id, [{ optionId: color.id, optionValueId: red.id }]);
    expect(await readSignature(other.id)).toBe(red.id);
  });

  it('a soft-deleted handle frees the partial-unique', async () => {
    const first = await catalogRepository.createProduct(db, { title: 'Shoes', handle: 'shoes' });
    await expect(catalogRepository.createProduct(db, { title: 'Shoes 2', handle: 'shoes' })).rejects.toThrow(
      /product_handle_active_key|duplicate key/,
    );

    await db.updateTable('product').set({ deleted_at: new Date() }).where('id', '=', first.id).execute();
    const reused = await catalogRepository.createProduct(db, { title: 'Shoes 3', handle: 'shoes' });
    expect(reused.id).not.toBe(first.id);
  });

  it('matrix-only writes recompute the signature and reject a duplicate combination (path independence)', async () => {
    // The AFTER INSERT/UPDATE/DELETE trigger on product_variant_option recomputes
    // the signature without anyone touching the variant row, so the no-duplicate
    // rule is a DATABASE guarantee whichever table is written.
    const { product, option: color, values } = await productWithOption('sock-pathindep', ['Green']);
    const green = values[0];
    const v1 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'SOCK-PI-1' });
    const v2 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'SOCK-PI-2' });
    expect(await readSignature(v1.id)).toBeNull();
    expect(await readSignature(v2.id)).toBeNull();

    await db
      .insertInto('product_variant_option')
      .values({ variant_id: v1.id, option_id: color.id, option_value_id: green.id })
      .execute();
    expect(await readSignature(v1.id)).toBe(green.id);

    await expect(
      db
        .insertInto('product_variant_option')
        .values({ variant_id: v2.id, option_id: color.id, option_value_id: green.id })
        .execute(),
    ).rejects.toThrow(SIGNATURE_COLLISION);

    expect(await readSignature(v2.id)).toBeNull();
    const v2Rows = await db
      .selectFrom('product_variant_option')
      .select('variant_id')
      .where('variant_id', '=', v2.id)
      .execute();
    expect(v2Rows).toHaveLength(0);
  });

  it('a two-axis combination written in opposite order collides (signature is order-canonical)', async () => {
    const product = await catalogRepository.createProduct(db, { title: 'Shirt', handle: 'shirt-canon' });
    const color = await catalogRepository.addOption(db, { productId: product.id, title: 'Color' });
    const size = await catalogRepository.addOption(db, { productId: product.id, title: 'Size' });
    const red = await catalogRepository.addOptionValue(db, { optionId: color.id, value: 'Red' });
    const small = await catalogRepository.addOptionValue(db, { optionId: size.id, value: 'Small' });
    const v1 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'SHIRT-CN-1' });
    const v2 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'SHIRT-CN-2' });

    await catalogRepository.setVariantOptions(db, v1.id, [
      { optionId: color.id, optionValueId: red.id },
      { optionId: size.id, optionValueId: small.id },
    ]);
    expect(await readSignature(v1.id)).toBe([red.id, small.id].sort().join(','));

    await expect(
      catalogRepository.setVariantOptions(db, v2.id, [
        { optionId: size.id, optionValueId: small.id },
        { optionId: color.id, optionValueId: red.id },
      ]),
    ).rejects.toThrow(SIGNATURE_COLLISION);
    expect(await readSignature(v2.id)).toBeNull();
  });

  it('the sku partial-unique rejects a duplicate live value and frees it on soft-delete', async () => {
    const product = await catalogRepository.createProduct(db, { title: 'Mug', handle: 'mug-sku' });
    const v1 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'SKU-DUP' });
    await expect(catalogRepository.addVariant(db, { productId: product.id, sku: 'SKU-DUP' })).rejects.toThrow(
      /product_variant_sku_active_key|duplicate key/,
    );

    await softDeleteVariant(v1.id);
    const v3 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'SKU-DUP' });
    expect(v3.id).not.toBe(v1.id);
  });

  it('the barcode partial-unique rejects a duplicate live value and frees it on soft-delete', async () => {
    const product = await catalogRepository.createProduct(db, { title: 'Bottle', handle: 'bottle-barcode' });
    const v1 = await catalogRepository.addVariant(db, { productId: product.id, barcode: 'BC-DUP' });
    await expect(
      catalogRepository.addVariant(db, { productId: product.id, barcode: 'BC-DUP' }),
    ).rejects.toThrow(/product_variant_barcode_active_key|duplicate key/);

    await softDeleteVariant(v1.id);
    const v3 = await catalogRepository.addVariant(db, { productId: product.id, barcode: 'BC-DUP' });
    expect(v3.id).not.toBe(v1.id);
  });

  it('soft-deleting a variant frees its option combination for a new variant', async () => {
    const { product, option: color, values } = await productWithOption('glove-sigfree', ['Red']);
    const red = values[0];
    const v1 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'GLOVE-SF-1' });
    await catalogRepository.setVariantOptions(db, v1.id, [{ optionId: color.id, optionValueId: red.id }]);
    expect(await readSignature(v1.id)).toBe(red.id);

    await softDeleteVariant(v1.id);
    const v2 = await catalogRepository.addVariant(db, { productId: product.id, sku: 'GLOVE-SF-2' });
    await catalogRepository.setVariantOptions(db, v2.id, [{ optionId: color.id, optionValueId: red.id }]);
    expect(await readSignature(v2.id)).toBe(red.id);
  });

  it('count() counts the products of this schema; createProduct defaults status to draft', async () => {
    const before = await catalogRepository.count(db);
    const product = await catalogRepository.createProduct(db, { title: 'Counted', handle: 'counted' });
    expect(product.status).toBe('draft');
    const published = await catalogRepository.createProduct(db, {
      title: 'Live',
      handle: 'live',
      status: 'published',
    });
    expect(published.status).toBe('published');
    expect(await catalogRepository.count(db)).toBe(before + 2);
  });
});
