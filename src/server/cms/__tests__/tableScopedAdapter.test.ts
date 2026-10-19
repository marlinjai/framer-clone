// src/server/cms/__tests__/tableScopedAdapter.test.ts
//
// The published plane's row-by-id read must not walk every tenant's tables:
// narrowDtTableDiscovery ANDs `{ id: tableId }` into every dtTable.findMany the
// adapter issues, and leaves the rest of the client untouched.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { narrowDtTableDiscovery } from '../tableScopedAdapter';

function fakePrisma() {
  const findMany = vi.fn(async () => []);
  const findUnique = vi.fn(async () => null);
  const queryRaw = vi.fn(async () => []);
  const prisma = {
    dtTable: { findMany, findUnique },
    $queryRawUnsafe: queryRaw,
  } as unknown as PrismaClient;
  return { prisma, findMany, findUnique, queryRaw };
}

describe('narrowDtTableDiscovery', () => {
  it('ANDs the table id into the adapter\'s own where clause', async () => {
    const { prisma, findMany } = fakePrisma();
    const narrowed = narrowDtTableDiscovery(prisma, 't_site');
    await narrowed.dtTable.findMany({ where: { migrated: true }, select: { id: true } });
    expect(findMany).toHaveBeenCalledWith({
      where: { AND: [{ migrated: true }, { id: 't_site' }] },
      select: { id: true },
    });
  });

  it('narrows a findMany that has no where at all', async () => {
    const { prisma, findMany } = fakePrisma();
    await narrowDtTableDiscovery(prisma, 't_site').dtTable.findMany();
    expect(findMany).toHaveBeenCalledWith({ where: { AND: [{}, { id: 't_site' }] } });
  });

  it('cannot be widened by a caller-supplied id', async () => {
    const { prisma, findMany } = fakePrisma();
    await narrowDtTableDiscovery(prisma, 't_site').dtTable.findMany({ where: { id: 't_other' } });
    // Both conditions must hold, so a foreign table can never match.
    expect(findMany).toHaveBeenCalledWith({ where: { AND: [{ id: 't_other' }, { id: 't_site' }] } });
  });

  it('passes every other member through unchanged', async () => {
    const { prisma, findUnique, queryRaw } = fakePrisma();
    const narrowed = narrowDtTableDiscovery(prisma, 't_site');
    await narrowed.dtTable.findUnique({ where: { id: 'x' } });
    await narrowed.$queryRawUnsafe('SELECT 1');
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'x' } });
    expect(queryRaw).toHaveBeenCalledWith('SELECT 1');
  });
});
