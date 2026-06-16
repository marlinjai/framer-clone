import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

// Integration test (Dockerized Postgres, booted by vitest.integration.setup.ts).
// Asserts that `prisma migrate deploy` created the dt_* tables and that a
// trivial query against one of them resolves. DATABASE_URL is provided by the
// globalSetup, which migrated the schema before this file runs.
describe('dt_* schema integration', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('migrated the dt_tables table and dtTable.findMany() resolves', async () => {
    const rows = await prisma.dtTable.findMany();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('can round-trip a DtTable row', async () => {
    const created = await prisma.dtTable.create({
      data: { workspaceId: 'ws_test', name: 'Integration table' },
    });
    expect(created.id).toBeTruthy();

    const found = await prisma.dtTable.findUnique({ where: { id: created.id } });
    expect(found?.name).toBe('Integration table');
  });
});
