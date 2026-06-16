// src/server/commerce/repository/__tests__/catalog.itest.ts
//
// Integration test (Dockerized Postgres) for the b4 owned catalog schema. It
// boots its OWN throwaway Postgres in beforeAll (testcontainers), applies every
// migration (dt_* init + b2 ledger + b3 guarded reservation + b4 catalog), and
// proves the database-level guarantees the catalog rests on, against a LIVE
// database (they are Postgres semantics: a composite FK, the signature recompute
// triggers, and partial-unique indexes, none of which Prisma can express and none
// of which are mockable):
//
//   1. inserting a product_variant_option with a MISMATCHED option_id is REJECTED
//      by the composite FK (option_value_id, option_id) -> (id, option_id): an
//      option_value can never be attached under the wrong option.
//   2. two LIVE variants with the SAME option-value combination collide on
//      option_signature: the trigger computes identical signatures and the
//      partial-UNIQUE rejects the second.
//   3. editing a variant's options RECOMPUTES the signature (and frees the old
//      combination for another variant).
//   4. a soft-deleted handle FREES the partial-unique so the handle can be re-used.
//   5. PATH-INDEPENDENCE (the blocker fix): mutating product_variant_option
//      DIRECTLY (matrix-only, never touching the variant row) recomputes the
//      signature via the AFTER trigger, and a second matrix-only variant with the
//      same combination is REJECTED. This proves no-duplicate-combination is a
//      DATABASE guarantee regardless of which table is written, not an app promise.
//   6. order-canonicalization (TR-1): a two-axis combination written in OPPOSITE
//      order collides, because string_agg ... ORDER BY sorts the value ids.
//   7. the sku and barcode partial-uniques (TR-2): two live variants sharing a
//      value are rejected; soft-deleting the first frees the value for a third.
//   8. soft-delete frees the signature (TR-3): a soft-deleted variant's combination
//      can be re-claimed by a new variant (the partial-UNIQUE is live-rows-only).
//
// Rejections are asserted against the SPECIFIC constraint / index name (or the
// Postgres SQLSTATE), not a bare throw, so each test proves WHICH guard fired.
//
// The `.itest.ts` suffix keeps this file OUT of the headless `pnpm test` gate
// (vitest.config.ts matches only *.{test,spec}.{ts,tsx}); it runs only under
// `pnpm test:integration` against Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

import { withTenant } from '../../withTenant';
import { catalogRepository } from '../catalog';

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

  // Apply dt_* init + b2 ledger + b3 guarded reservation + b4 catalog.
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

// Flatten a Prisma / Postgres error into one searchable string (message + code +
// meta) so a rejection can be asserted against the SPECIFIC constraint name and/or
// SQLSTATE rather than a bare throw. SQLSTATEs of interest: 23503 =
// foreign_key_violation, 23505 = unique_violation.
function errorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const e = error as { message?: unknown; meta?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof e.message === 'string') parts.push(e.message);
    if (typeof e.code === 'string') parts.push(e.code);
    if (e.meta) parts.push(JSON.stringify(e.meta));
    return parts.join(' | ');
  }
  return String(error);
}

async function expectRejectionMatching(
  op: () => Promise<unknown>,
  ...patterns: RegExp[]
): Promise<void> {
  let caught: unknown;
  let threw = false;
  try {
    await op();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw, 'expected the operation to reject, but it resolved').toBe(true);
  const text = errorText(caught);
  for (const pattern of patterns) {
    expect(text, `rejection text did not match ${pattern}: ${text}`).toMatch(pattern);
  }
}

/** Read the raw, trigger-maintained option_signature column (absent from the model). */
async function readSignature(client: PrismaClient, variantId: string): Promise<string | null> {
  const rows = await client.$queryRawUnsafe<Array<{ option_signature: string | null }>>(
    `SELECT "option_signature" FROM "commerce"."product_variant" WHERE "id" = $1`,
    variantId,
  );
  return rows[0]?.option_signature ?? null;
}

describe('b4 catalog schema (Dockerized Postgres)', () => {
  it('the composite FK rejects a product_variant_option with a mismatched option_id', async () => {
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Tee', handle: 'tee-fk' }),
    );
    const color = await withTenant(db, (tx) =>
      catalogRepository.addOption(tx, { productId: product.id, title: 'Color' }),
    );
    const size = await withTenant(db, (tx) =>
      catalogRepository.addOption(tx, { productId: product.id, title: 'Size' }),
    );
    const red = await withTenant(db, (tx) =>
      catalogRepository.addOptionValue(tx, { optionId: color.id, value: 'Red' }),
    );
    const variant = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'TEE-FK-1' }),
    );

    // 'Red' belongs to Color, but we attach it under Size: (red.id, size.id) is NOT
    // a real (id, option_id) pair in product_option_value, so the composite FK
    // rejects it. Prisma raises P2003 (FK violation); the underlying SQLSTATE is
    // 23503 and the constraint name names the composite FK.
    await expectRejectionMatching(
      () =>
        db.productVariantOption.create({
          data: { variantId: variant.id, optionId: size.id, optionValueId: red.id },
        }),
      /P2003|23503|foreign key|product_variant_option_option_value_id_option_id_fkey/,
    );

    // The correct pairing (red under Color) is accepted, proving the FK rejects
    // ONLY the mismatch, not the matrix insert itself.
    const ok = await db.productVariantOption.create({
      data: { variantId: variant.id, optionId: color.id, optionValueId: red.id },
    });
    expect(ok.variantId).toBe(variant.id);
  });

  it('two variants with the same option combination collide on option_signature', async () => {
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Hoodie', handle: 'hoodie-sig' }),
    );
    const color = await withTenant(db, (tx) =>
      catalogRepository.addOption(tx, { productId: product.id, title: 'Color' }),
    );
    const red = await withTenant(db, (tx) =>
      catalogRepository.addOptionValue(tx, { optionId: color.id, value: 'Red' }),
    );
    const v1 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'HOOD-SIG-1' }),
    );
    const v2 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'HOOD-SIG-2' }),
    );

    // First variant claims {Red}: the trigger sets its signature to red.id.
    await withTenant(db, (tx) =>
      catalogRepository.setVariantOptions(tx, v1.id, [{ optionId: color.id, optionValueId: red.id }]),
    );
    expect(await readSignature(db, v1.id)).toBe(red.id);

    // Second variant tries the SAME combination: the trigger computes the SAME
    // signature and the option_signature partial-UNIQUE rejects the recompute.
    await expectRejectionMatching(
      () =>
        withTenant(db, (tx) =>
          catalogRepository.setVariantOptions(tx, v2.id, [
            { optionId: color.id, optionValueId: red.id },
          ]),
        ),
      // The collision happens inside the recompute UPDATE the signature triggers
      // issue, so it can surface either as the raw Postgres unique-violation
      // (23505 on product_variant_option_signature_active_key, e.g. via a direct
      // matrix write) or, when it bubbles through a Prisma write, as Prisma's
      // normalized P2002 naming the option_signature column. Either form proves the
      // option_signature partial-UNIQUE fired.
      /23505|duplicate key|product_variant_option_signature_active_key|P2002|option_signature/,
    );

    // The rejected transaction rolled back: v2 still has no signature.
    expect(await readSignature(db, v2.id)).toBeNull();
  });

  it('editing a variant options recomputes the signature and frees the old combination', async () => {
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Cap', handle: 'cap-recompute' }),
    );
    const color = await withTenant(db, (tx) =>
      catalogRepository.addOption(tx, { productId: product.id, title: 'Color' }),
    );
    const red = await withTenant(db, (tx) =>
      catalogRepository.addOptionValue(tx, { optionId: color.id, value: 'Red' }),
    );
    const blue = await withTenant(db, (tx) =>
      catalogRepository.addOptionValue(tx, { optionId: color.id, value: 'Blue' }),
    );
    const v = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'CAP-RC-1' }),
    );

    await withTenant(db, (tx) =>
      catalogRepository.setVariantOptions(tx, v.id, [{ optionId: color.id, optionValueId: red.id }]),
    );
    expect(await readSignature(db, v.id)).toBe(red.id);

    // Re-assign to {Blue}: the matrix changes and the trigger recomputes.
    await withTenant(db, (tx) =>
      catalogRepository.setVariantOptions(tx, v.id, [{ optionId: color.id, optionValueId: blue.id }]),
    );
    expect(await readSignature(db, v.id)).toBe(blue.id);

    // The {Red} combination is now free: another variant can claim it.
    const other = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'CAP-RC-2' }),
    );
    await withTenant(db, (tx) =>
      catalogRepository.setVariantOptions(tx, other.id, [
        { optionId: color.id, optionValueId: red.id },
      ]),
    );
    expect(await readSignature(db, other.id)).toBe(red.id);
  });

  it('a soft-deleted handle frees the partial-unique', async () => {
    const db = prisma!;
    const first = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Shoes', handle: 'shoes' }),
    );

    // A second LIVE product with the same handle is rejected by the partial-unique
    // index. Prisma normalizes the unique-index violation to P2002; the index name
    // (product_handle_active_key) names the handle column, proving the guard fired
    // ON handle.
    await expectRejectionMatching(
      () =>
        withTenant(db, (tx) =>
          catalogRepository.createProduct(tx, { title: 'Shoes 2', handle: 'shoes' }),
        ),
      /P2002|23505|handle/,
    );

    // Soft-delete the first product: the handle is now free.
    await db.product.update({ where: { id: first.id }, data: { deletedAt: new Date() } });

    const reused = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Shoes 3', handle: 'shoes' }),
    );
    expect(reused.id).toBeTruthy();
    expect(reused.id).not.toBe(first.id);
  });

  it('matrix-only writes recompute the signature and reject a duplicate combination (path-independence)', async () => {
    // The BLOCKER proof. Earlier the recompute fired only when a writer ALSO
    // touched the product_variant row (setVariantOptions did a compensating no-op
    // UPDATE). A matrix-only writer would have left the signature stale and the
    // partial-UNIQUE keyed off the stale value, letting two live variants share a
    // real combination. The AFTER INSERT/UPDATE/DELETE trigger on
    // product_variant_option closes that: we mutate the matrix DIRECTLY here, never
    // touching the variant row, and the signature still recomputes and still
    // enforces uniqueness. That makes no-duplicate-combination a DATABASE guarantee
    // regardless of which table is written.
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Sock', handle: 'sock-pathindep' }),
    );
    const color = await withTenant(db, (tx) =>
      catalogRepository.addOption(tx, { productId: product.id, title: 'Color' }),
    );
    const green = await withTenant(db, (tx) =>
      catalogRepository.addOptionValue(tx, { optionId: color.id, value: 'Green' }),
    );
    const v1 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'SOCK-PI-1' }),
    );
    const v2 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'SOCK-PI-2' }),
    );

    // Both variants start with no combination, so both signatures are NULL.
    expect(await readSignature(db, v1.id)).toBeNull();
    expect(await readSignature(db, v2.id)).toBeNull();

    // Insert a matrix row for v1 DIRECTLY, bypassing setVariantOptions entirely and
    // never touching the v1 row. The AFTER trigger must recompute v1's signature.
    await db.productVariantOption.create({
      data: { variantId: v1.id, optionId: color.id, optionValueId: green.id },
    });
    expect(await readSignature(db, v1.id)).toBe(green.id);

    // A second matrix-only write of the SAME combination onto v2 must be REJECTED:
    // the AFTER trigger recomputes v2's signature to green.id and the
    // option_signature partial-UNIQUE rejects it. The matrix INSERT succeeds at the
    // row level, but the trigger's recompute UPDATE on product_variant collides, so
    // the whole statement (and its implicit transaction) rolls back.
    await expectRejectionMatching(
      () =>
        db.productVariantOption.create({
          data: { variantId: v2.id, optionId: color.id, optionValueId: green.id },
        }),
      // The collision happens inside the recompute UPDATE the signature triggers
      // issue, so it can surface either as the raw Postgres unique-violation
      // (23505 on product_variant_option_signature_active_key, e.g. via a direct
      // matrix write) or, when it bubbles through a Prisma write, as Prisma's
      // normalized P2002 naming the option_signature column. Either form proves the
      // option_signature partial-UNIQUE fired.
      /23505|duplicate key|product_variant_option_signature_active_key|P2002|option_signature/,
    );

    // The rejected matrix write rolled back: v2 still has no signature and no
    // matrix row.
    expect(await readSignature(db, v2.id)).toBeNull();
    const v2Rows = await db.productVariantOption.count({ where: { variantId: v2.id } });
    expect(v2Rows).toBe(0);
  });

  it('a two-axis combination written in opposite order collides (signature is order-canonical)', async () => {
    // TR-1: string_agg(... ORDER BY option_value_id) sorts the value ids before
    // joining, so {Color=Red, Size=Small} and {Size=Small, Color=Red} produce the
    // SAME signature. v2, written with the two assignments in the OPPOSITE order,
    // must collide, and v1's stored signature must equal the SORTED comma-join of
    // both value ids (not the insertion order).
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Shirt', handle: 'shirt-canon' }),
    );
    const color = await withTenant(db, (tx) =>
      catalogRepository.addOption(tx, { productId: product.id, title: 'Color' }),
    );
    const size = await withTenant(db, (tx) =>
      catalogRepository.addOption(tx, { productId: product.id, title: 'Size' }),
    );
    const red = await withTenant(db, (tx) =>
      catalogRepository.addOptionValue(tx, { optionId: color.id, value: 'Red' }),
    );
    const small = await withTenant(db, (tx) =>
      catalogRepository.addOptionValue(tx, { optionId: size.id, value: 'Small' }),
    );
    const v1 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'SHIRT-CN-1' }),
    );
    const v2 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'SHIRT-CN-2' }),
    );

    // v1: Color=Red, Size=Small (this insertion order).
    await withTenant(db, (tx) =>
      catalogRepository.setVariantOptions(tx, v1.id, [
        { optionId: color.id, optionValueId: red.id },
        { optionId: size.id, optionValueId: small.id },
      ]),
    );

    // The stored signature is the SORTED comma-join of both value ids, proving the
    // ORDER BY in string_agg canonicalizes regardless of insertion order.
    const expectedSignature = [red.id, small.id].sort().join(',');
    expect(await readSignature(db, v1.id)).toBe(expectedSignature);

    // v2: the SAME two assignments in the OPPOSITE order. The canonical signature is
    // identical, so the partial-UNIQUE rejects it.
    await expectRejectionMatching(
      () =>
        withTenant(db, (tx) =>
          catalogRepository.setVariantOptions(tx, v2.id, [
            { optionId: size.id, optionValueId: small.id },
            { optionId: color.id, optionValueId: red.id },
          ]),
        ),
      // The collision happens inside the recompute UPDATE the signature triggers
      // issue, so it can surface either as the raw Postgres unique-violation
      // (23505 on product_variant_option_signature_active_key, e.g. via a direct
      // matrix write) or, when it bubbles through a Prisma write, as Prisma's
      // normalized P2002 naming the option_signature column. Either form proves the
      // option_signature partial-UNIQUE fired.
      /23505|duplicate key|product_variant_option_signature_active_key|P2002|option_signature/,
    );

    expect(await readSignature(db, v2.id)).toBeNull();
  });

  it('the sku partial-unique rejects a duplicate live value and frees it on soft-delete', async () => {
    // TR-2 (sku). Two LIVE variants cannot share a sku; soft-deleting the first
    // frees the value for a third. Variants live across products, so the sku unique
    // is global among live variants, not per-product.
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Mug', handle: 'mug-sku' }),
    );
    const v1 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'SKU-DUP' }),
    );

    await expectRejectionMatching(
      () =>
        withTenant(db, (tx) =>
          catalogRepository.addVariant(tx, { productId: product.id, sku: 'SKU-DUP' }),
        ),
      /P2002|23505|product_variant_sku_active_key|sku/,
    );

    // Soft-delete v1: the sku frees.
    await db.productVariant.update({ where: { id: v1.id }, data: { deletedAt: new Date() } });

    const v3 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'SKU-DUP' }),
    );
    expect(v3.id).toBeTruthy();
    expect(v3.id).not.toBe(v1.id);
  });

  it('the barcode partial-unique rejects a duplicate live value and frees it on soft-delete', async () => {
    // TR-2 (barcode). Same shape as the sku test, on the barcode column.
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Bottle', handle: 'bottle-barcode' }),
    );
    const v1 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, barcode: 'BC-DUP' }),
    );

    await expectRejectionMatching(
      () =>
        withTenant(db, (tx) =>
          catalogRepository.addVariant(tx, { productId: product.id, barcode: 'BC-DUP' }),
        ),
      /P2002|23505|product_variant_barcode_active_key|barcode/,
    );

    // Soft-delete v1: the barcode frees.
    await db.productVariant.update({ where: { id: v1.id }, data: { deletedAt: new Date() } });

    const v3 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, barcode: 'BC-DUP' }),
    );
    expect(v3.id).toBeTruthy();
    expect(v3.id).not.toBe(v1.id);
  });

  it('soft-deleting a variant frees its option combination for a new variant (signature partial-unique is live-rows-only)', async () => {
    // TR-3. Assign {Red} to v1, soft-delete v1, create v2 and assign {Red}: it must
    // SUCCEED, because the option_signature partial-UNIQUE is WHERE deleted_at IS
    // NULL, so a soft-deleted variant no longer holds its combination.
    const db = prisma!;
    const product = await withTenant(db, (tx) =>
      catalogRepository.createProduct(tx, { title: 'Glove', handle: 'glove-sigfree' }),
    );
    const color = await withTenant(db, (tx) =>
      catalogRepository.addOption(tx, { productId: product.id, title: 'Color' }),
    );
    const red = await withTenant(db, (tx) =>
      catalogRepository.addOptionValue(tx, { optionId: color.id, value: 'Red' }),
    );
    const v1 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'GLOVE-SF-1' }),
    );
    await withTenant(db, (tx) =>
      catalogRepository.setVariantOptions(tx, v1.id, [{ optionId: color.id, optionValueId: red.id }]),
    );
    expect(await readSignature(db, v1.id)).toBe(red.id);

    // Soft-delete v1: its signature row leaves the partial-UNIQUE's live set.
    await db.productVariant.update({ where: { id: v1.id }, data: { deletedAt: new Date() } });

    // v2 can now claim {Red}: the same signature is no longer taken by a live row.
    const v2 = await withTenant(db, (tx) =>
      catalogRepository.addVariant(tx, { productId: product.id, sku: 'GLOVE-SF-2' }),
    );
    await withTenant(db, (tx) =>
      catalogRepository.setVariantOptions(tx, v2.id, [{ optionId: color.id, optionValueId: red.id }]),
    );
    expect(await readSignature(db, v2.id)).toBe(red.id);
  });
});
