// @vitest-environment node
//
// The fleet pass over the expired payments: what one tenant group or company does to the rest. The sweep itself
// is proven against real Postgres (payments.itest.ts, and the route's own route.itest.ts).

import { TenantSchemaError } from '@marlinjai/tenant-db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { findMany, commerceTenantDbChecked, sweepExpiredPayments } = vi.hoisted(() => ({
  findMany: vi.fn(),
  commerceTenantDbChecked: vi.fn(),
  sweepExpiredPayments: vi.fn(),
}));

vi.mock('@/server/db', () => ({ getPrismaClient: () => ({ site: { findMany } }) }));

vi.mock('../../db', () => ({
  commerceTenantDbChecked,
  isCommerceTenantNotProvisioned: (err: unknown) =>
    (err as { code?: string } | null)?.code === 'COMMERCE_TENANT_NOT_PROVISIONED',
}));

vi.mock('../deps', () => ({
  paymentDeps: (db: unknown, tgId: string, companyId: string) => ({ db, tgId, companyId }),
}));

vi.mock('../payments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../payments')>()),
  sweepExpiredPayments,
}));

import { sweepAllExpiredPayments } from '../expirySweep';
import { ExpirySweepError } from '../payments';

/** A scoped handle whose "who has anything due" read answers these companies. */
function dbWithDue(...companies: string[]) {
  const query = {
    select: () => query,
    distinct: () => query,
    where: () => query,
    execute: async () => companies.map((tenant_id) => ({ tenant_id })),
  };
  return { selectFrom: () => query };
}

function groups(...ids: string[]) {
  findMany.mockResolvedValue(ids.map((tenantGroupId) => ({ tenantGroupId })));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sweepAllExpiredPayments', () => {
  it('sweeps each company with something due, in its own tenant group, and adds up what closed', async () => {
    groups('tg-a', 'tg-b', 'tg-idle');
    const handles = { 'tg-a': dbWithDue('co-1', 'co-2'), 'tg-b': dbWithDue('co-3'), 'tg-idle': dbWithDue() };
    commerceTenantDbChecked.mockImplementation(async (tg: keyof typeof handles) => handles[tg]);
    sweepExpiredPayments.mockImplementation(async (_deps, companyId: string) =>
      companyId === 'co-1' ? ['o-1', 'o-2'] : ['o-3'],
    );

    expect(await sweepAllExpiredPayments()).toEqual({ tenantGroups: 3, skipped: 0, closed: 4, failed: 0 });
    expect(sweepExpiredPayments.mock.calls.map(([deps, company]) => [deps.tgId, deps.companyId, company])).toEqual([
      ['tg-a', 'co-1', 'co-1'],
      ['tg-a', 'co-2', 'co-2'],
      ['tg-b', 'co-3', 'co-3'],
    ]);
  });

  it('skips a tenant group without commerce, quietly: it has nothing to sweep', async () => {
    groups('tg-none', 'tg-legacy', 'tg-a');
    commerceTenantDbChecked.mockImplementation(async (tg: string) => {
      if (tg === 'tg-none') throw Object.assign(new Error('no schema'), { code: 'COMMERCE_TENANT_NOT_PROVISIONED' });
      if (tg === 'tg-legacy') throw new TenantSchemaError('not a tenant group id');
      return dbWithDue('co-1');
    });
    sweepExpiredPayments.mockResolvedValue(['o-1']);

    expect(await sweepAllExpiredPayments()).toEqual({ tenantGroups: 1, skipped: 2, closed: 1, failed: 0 });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('counts both halves of a partly failed company and goes on to the next', async () => {
    groups('tg-a');
    commerceTenantDbChecked.mockResolvedValue(dbWithDue('co-1', 'co-2'));
    sweepExpiredPayments
      .mockRejectedValueOnce(new ExpirySweepError('co-1', ['o-1'], ['o-2', 'o-3']))
      .mockResolvedValueOnce(['o-4']);

    expect(await sweepAllExpiredPayments()).toEqual({ tenantGroups: 1, skipped: 0, closed: 2, failed: 2 });
  });

  it('logs a company whose sweep broke outright, and a tenant group that broke, and goes on', async () => {
    groups('tg-broken', 'tg-a');
    const down = new Error('connection lost');
    commerceTenantDbChecked.mockImplementation(async (tg: string) => {
      if (tg === 'tg-broken') throw down;
      return dbWithDue('co-1', 'co-2');
    });
    const unreadable = new Error('could not read what is due');
    sweepExpiredPayments.mockRejectedValueOnce(unreadable).mockResolvedValueOnce(['o-1']);

    expect(await sweepAllExpiredPayments()).toEqual({ tenantGroups: 1, skipped: 0, closed: 1, failed: 2 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('tg-broken'), down);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('co-1'), unreadable);
  });

  it('lets a failure to list the tenant groups surface to the caller', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    await expect(sweepAllExpiredPayments()).rejects.toThrow('db down');
  });
});
