// src/server/commerce/inventory/__tests__/schema.itest.ts
//
// Integration test (Dockerized Postgres) for the b2 owned inventory ledger
// schema. Verifies the five database-level guarantees that make oversell
// structurally impossible and that Prisma cannot express in the datamodel:
//
//   1. inventory_level.available_quantity is a GENERATED STORED column that
//      auto-updates when stocked_quantity / reserved_quantity change.
//   2. the CHECK (reserved_quantity <= stocked_quantity) backstop rejects an
//      oversell, on the INSERT path AND on the UPDATE path (the path b3's
//      guarded decrement actually drives).
//   2b. the non-negativity floor CHECK (reserved_quantity >= 0) rejects a
//      negative reservation that would mint phantom available stock.
//   3. UPDATE on stock_movement as commerce_app is DENIED (append-only REVOKE).
//   4. the partial-unique sku (UNIQUE WHERE deleted_at IS NULL) frees a SKU on
//      soft-delete.
//   5. stock_movement.request_id is UNIQUE.
//
// Where practical, rejections are asserted against the SPECIFIC constraint name
// (CHECK / unique index) or the Postgres SQLSTATE code, not a bare throw, so the
// test proves WHICH guard fired rather than merely that SOMETHING failed.
//
// This file boots its OWN throwaway Postgres (testcontainers) in beforeAll, so
// it is fully self-contained. It uses the `.itest.ts` suffix on purpose: that
// suffix is matched by NEITHER the headless unit run (vitest.config.ts:
// *.{test,spec}.{ts,tsx}) NOR the existing Docker harness
// (vitest.integration.config.ts: test/integration/**). It is therefore kept out
// of the placeholder-DATABASE_URL verify gate and is run explicitly against
// Docker. It requires a running Docker daemon.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const COMMERCE_APP_PASSWORD = 'commerce_app_itest_pw';

let container: StartedTestContainer | undefined;
// adminPrisma connects as the container superuser: it runs migrations and seeds.
let adminPrisma: PrismaClient | undefined;
// appPrisma connects as commerce_app (the DML-only, non-owner application role):
// it is the role the append-only REVOKE is enforced against.
let appPrisma: PrismaClient | undefined;

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

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const adminUrl = makeUrl('test', 'test', host, port);

  // Apply every migration (dt_* init + the b2 commerce ledger) against the fresh
  // database. The b2 migration's REVOKE is guarded on role existence, so at this
  // point (no commerce_app yet) it is a no-op; we provision the role and apply
  // the append-only REVOKE explicitly below, exactly as the out-of-band role
  // provisioning (prisma/sql/commerce-roles.sql) does in a real environment.
  execSync('pnpm exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: adminUrl },
  });

  adminPrisma = new PrismaClient({ datasourceUrl: adminUrl });

  // Provision the b1 role topology bits this test needs: commerce_app as a
  // DML-only, non-owner LOGIN role, then the b2 append-only REVOKE on the ledger.
  await adminPrisma.$executeRawUnsafe(
    `CREATE ROLE commerce_app LOGIN PASSWORD '${COMMERCE_APP_PASSWORD}'`,
  );
  await adminPrisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA commerce TO commerce_app`);
  await adminPrisma.$executeRawUnsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA commerce TO commerce_app`,
  );
  // The append-only enforcement: revoke UPDATE/DELETE on the ledger only.
  await adminPrisma.$executeRawUnsafe(
    `REVOKE UPDATE, DELETE ON "commerce"."stock_movement" FROM commerce_app`,
  );

  appPrisma = new PrismaClient({
    datasourceUrl: makeUrl('commerce_app', COMMERCE_APP_PASSWORD, host, port),
  });
}, 180_000);

afterAll(async () => {
  await appPrisma?.$disconnect();
  await adminPrisma?.$disconnect();
  await container?.stop();
});

/** Reads the GENERATED available_quantity column (absent from the Prisma model). */
async function readAvailable(prisma: PrismaClient, levelId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ available_quantity: number }>>(
    `SELECT "available_quantity" FROM "commerce"."inventory_level" WHERE "id" = $1`,
    levelId,
  );
  return rows[0].available_quantity;
}

// Prisma surfaces the underlying Postgres error in different shapes depending on
// the path (engine-validated create/update vs $executeRawUnsafe). For both, the
// driver's message text and SQLSTATE survive somewhere on the error object, so we
// flatten message + meta into one searchable string and assert against the
// SPECIFIC constraint name (and/or SQLSTATE) rather than a bare throw. This proves
// WHICH guard fired. Postgres SQLSTATEs of interest: 23514 = check_violation,
// 23505 = unique_violation, 42501 = insufficient_privilege.
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

/**
 * Runs an operation expected to reject, and asserts the rejection text matches
 * EVERY supplied pattern (constraint name, SQLSTATE code, etc.). Fails loudly if
 * the operation does NOT reject.
 */
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

describe('b2 inventory ledger schema (Dockerized Postgres)', () => {
  it('available_quantity is generated and auto-updates when stocked/reserved change', async () => {
    const prisma = adminPrisma!;
    const item = await prisma.inventoryItem.create({ data: { sku: 'GEN-SKU-1' } });
    const location = await prisma.stockLocation.create({ data: { name: 'Main warehouse' } });

    const level = await prisma.inventoryLevel.create({
      data: {
        inventoryItemId: item.id,
        locationId: location.id,
        stockedQuantity: 10,
        reservedQuantity: 3,
      },
    });
    expect(await readAvailable(prisma, level.id)).toBe(7);

    await prisma.inventoryLevel.update({
      where: { id: level.id },
      data: { reservedQuantity: 5 },
    });
    expect(await readAvailable(prisma, level.id)).toBe(5);

    await prisma.inventoryLevel.update({
      where: { id: level.id },
      data: { stockedQuantity: 20 },
    });
    expect(await readAvailable(prisma, level.id)).toBe(15);
  });

  it('the CHECK constraint rejects reserved_quantity > stocked_quantity on INSERT', async () => {
    const prisma = adminPrisma!;
    const item = await prisma.inventoryItem.create({ data: { sku: 'CHK-SKU-1' } });
    const location = await prisma.stockLocation.create({ data: { name: 'Check warehouse' } });

    // Proves the specific constraint fired (name + check_violation SQLSTATE).
    await expectRejectionMatching(
      () =>
        prisma.inventoryLevel.create({
          data: {
            inventoryItemId: item.id,
            locationId: location.id,
            stockedQuantity: 10,
            reservedQuantity: 11,
          },
        }),
      /inventory_level_reserved_lte_stocked_check/,
    );
  });

  it('the CHECK constraint rejects reserved_quantity > stocked_quantity on UPDATE', async () => {
    // This is the path b3's guarded decrement actually drives: an in-place UPDATE
    // of an existing level, not an INSERT. Start valid (10/3, available 7), then
    // attempt to push reserved to 11 (> stocked 10) and assert it is REJECTED.
    const prisma = adminPrisma!;
    const item = await prisma.inventoryItem.create({ data: { sku: 'CHK-UPD-SKU-1' } });
    const location = await prisma.stockLocation.create({ data: { name: 'Check update warehouse' } });

    const level = await prisma.inventoryLevel.create({
      data: {
        inventoryItemId: item.id,
        locationId: location.id,
        stockedQuantity: 10,
        reservedQuantity: 3,
      },
    });
    expect(await readAvailable(prisma, level.id)).toBe(7);

    await expectRejectionMatching(
      () =>
        prisma.inventoryLevel.update({
          where: { id: level.id },
          data: { reservedQuantity: 11 },
        }),
      /inventory_level_reserved_lte_stocked_check/,
    );

    // The rejected UPDATE left the row untouched: still 10/3, available 7.
    const after = await prisma.inventoryLevel.findUniqueOrThrow({ where: { id: level.id } });
    expect(after.reservedQuantity).toBe(3);
    expect(after.stockedQuantity).toBe(10);
    expect(await readAvailable(prisma, level.id)).toBe(7);
  });

  it('the non-negativity floor rejects reserved_quantity < 0', async () => {
    // Without the floor, reserved = -1 (stocked 0) yields available = 1: phantom
    // stock minted from nothing, while still satisfying reserved <= stocked. The
    // reserved_quantity >= 0 CHECK is what closes that hole. Assert that the
    // SPECIFIC non-negativity constraint fires, not just any error.
    const prisma = adminPrisma!;
    const item = await prisma.inventoryItem.create({ data: { sku: 'NONNEG-SKU-1' } });
    const location = await prisma.stockLocation.create({ data: { name: 'Nonneg warehouse' } });

    await expectRejectionMatching(
      () =>
        prisma.inventoryLevel.create({
          data: {
            inventoryItemId: item.id,
            locationId: location.id,
            stockedQuantity: 0,
            reservedQuantity: -1,
          },
        }),
      /inventory_level_reserved_nonneg_check/,
    );
  });

  it('UPDATE on stock_movement as commerce_app is DENIED (append-only ledger)', async () => {
    const admin = adminPrisma!;
    const app = appPrisma!;
    const item = await admin.inventoryItem.create({ data: { sku: 'LEDGER-SKU-1' } });
    const location = await admin.stockLocation.create({ data: { name: 'Ledger warehouse' } });

    // commerce_app CAN append to the ledger (INSERT is allowed).
    const movement = await app.stockMovement.create({
      data: {
        inventoryItemId: item.id,
        locationId: location.id,
        movementType: 'receive',
        quantity: 5,
        requestId: 'req-ledger-insert-1',
      },
    });
    expect(movement.id).toBeTruthy();

    // commerce_app CANNOT mutate it: UPDATE is revoked, so Postgres rejects.
    await expect(
      app.$executeRawUnsafe(
        `UPDATE "commerce"."stock_movement" SET "quantity" = 999 WHERE "id" = $1`,
        movement.id,
      ),
    ).rejects.toThrow(/permission denied/i);

    // DELETE is revoked too.
    await expect(
      app.$executeRawUnsafe(
        `DELETE FROM "commerce"."stock_movement" WHERE "id" = $1`,
        movement.id,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the partial-unique sku frees on soft-delete', async () => {
    const prisma = adminPrisma!;
    const first = await prisma.inventoryItem.create({ data: { sku: 'REUSE-SKU' } });

    // A second live row with the same SKU is rejected by the partial-unique index.
    // Prisma normalizes the underlying unique-index violation to P2002 and reports
    // target: ["sku"] (the column), not the raw index name, so assert on the
    // P2002 code AND the sku field: this proves the unique guard fired ON the sku
    // column, not merely that something failed.
    await expectRejectionMatching(
      () => prisma.inventoryItem.create({ data: { sku: 'REUSE-SKU' } }),
      /P2002/,
      /sku/,
    );

    // Soft-delete the first row: the SKU is now free.
    await prisma.inventoryItem.update({
      where: { id: first.id },
      data: { deletedAt: new Date() },
    });

    const reused = await prisma.inventoryItem.create({ data: { sku: 'REUSE-SKU' } });
    expect(reused.id).toBeTruthy();
    expect(reused.id).not.toBe(first.id);
  });

  it('stock_movement.request_id is UNIQUE', async () => {
    const prisma = adminPrisma!;
    const item = await prisma.inventoryItem.create({ data: { sku: 'REQ-SKU-1' } });
    const location = await prisma.stockLocation.create({ data: { name: 'Req warehouse' } });

    await prisma.stockMovement.create({
      data: {
        inventoryItemId: item.id,
        locationId: location.id,
        movementType: 'receive',
        quantity: 1,
        requestId: 'req-duplicate-1',
      },
    });

    // Prisma raises P2002 (unique constraint violation) on the modeled @unique
    // request_id; the meta.target / message names the request_id constraint.
    await expectRejectionMatching(
      () =>
        prisma.stockMovement.create({
          data: {
            inventoryItemId: item.id,
            locationId: location.id,
            movementType: 'receive',
            quantity: 1,
            requestId: 'req-duplicate-1',
          },
        }),
      /P2002|request_id/,
    );
  });
});
