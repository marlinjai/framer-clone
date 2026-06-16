// src/server/commerce/inventory/__tests__/schema.itest.ts
//
// Integration test (Dockerized Postgres) for the b2 owned inventory ledger
// schema. Verifies the five database-level guarantees that make oversell
// structurally impossible and that Prisma cannot express in the datamodel:
//
//   1. inventory_level.available_quantity is a GENERATED STORED column that
//      auto-updates when stocked_quantity / reserved_quantity change.
//   2. the CHECK (reserved_quantity <= stocked_quantity) backstop rejects an
//      oversell.
//   3. UPDATE on stock_movement as commerce_app is DENIED (append-only REVOKE).
//   4. the partial-unique sku (UNIQUE WHERE deleted_at IS NULL) frees a SKU on
//      soft-delete.
//   5. stock_movement.request_id is UNIQUE.
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

  it('the CHECK constraint rejects reserved_quantity > stocked_quantity', async () => {
    const prisma = adminPrisma!;
    const item = await prisma.inventoryItem.create({ data: { sku: 'CHK-SKU-1' } });
    const location = await prisma.stockLocation.create({ data: { name: 'Check warehouse' } });

    await expect(
      prisma.inventoryLevel.create({
        data: {
          inventoryItemId: item.id,
          locationId: location.id,
          stockedQuantity: 10,
          reservedQuantity: 11,
        },
      }),
    ).rejects.toThrow();
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
    await expect(
      prisma.inventoryItem.create({ data: { sku: 'REUSE-SKU' } }),
    ).rejects.toThrow();

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

    await expect(
      prisma.stockMovement.create({
        data: {
          inventoryItemId: item.id,
          locationId: location.id,
          movementType: 'receive',
          quantity: 1,
          requestId: 'req-duplicate-1',
        },
      }),
    ).rejects.toThrow();
  });
});
