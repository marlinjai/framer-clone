// src/server/commerce/__tests__/dbBackstop.test.ts
//
// Unit cover for the lazily-run, cached startup backstop in db.ts
// (ensureCommerceBackstop / commerceTenantDbChecked). The postgres.js base and
// tenant-db's assertBackstop are mocked, so no database is touched:
//   - the check runs ONCE per process before the first scoped handle, and its
//     success is cached across calls,
//   - an owner-role connection (BackstopError) is re-thrown as is,
//   - any other connection failure is re-thrown with a clear, named message and
//     is NOT cached (the next commerce request checks again),
//   - the tenant schema's existence is checked once per tenant group (success
//     cached, a missing schema not), and a missing schema raises
//     CommerceTenantNotProvisionedError.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@marlinjai/tenant-db/node', () => ({
  createNodeDb: vi.fn(() => ({ __base: true })),
}));

vi.mock('@marlinjai/tenant-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@marlinjai/tenant-db')>();
  return {
    ...actual,
    assertBackstop: vi.fn(),
    tenantDb: vi.fn((_base: unknown, tg: string) => ({ __scopedHandleFor: tg })),
  };
});

vi.mock('../schemaProbe', () => ({ tenantSchemaExists: vi.fn() }));

import { assertBackstop, BackstopError, tenantSchema } from '@marlinjai/tenant-db';
import {
  CommerceTenantNotProvisionedError,
  commerceTenantDbChecked,
  ensureCommerceBackstop,
  isCommerceTenantNotProvisioned,
} from '../db';
import { tenantSchemaExists } from '../schemaProbe';

const assertMock = vi.mocked(assertBackstop);
const probeMock = vi.mocked(tenantSchemaExists);
const TG = '018f9c10-0000-7000-8000-0000000015aa';

beforeEach(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.__framerCloneCommerceBase;
  delete g.__framerCloneCommerceBackstop;
  delete g.__framerCloneCommerceSchemas;
  assertMock.mockReset();
  probeMock.mockReset();
  probeMock.mockResolvedValue(true);
  process.env.COMMERCE_APP_DATABASE_URL = 'postgresql://commerce_app@localhost:5432/unit';
});

describe('ensureCommerceBackstop', () => {
  it('runs once before the first handle and caches the success', async () => {
    assertMock.mockResolvedValue(undefined);
    expect(await commerceTenantDbChecked(TG)).toEqual({ __scopedHandleFor: TG });
    await commerceTenantDbChecked(TG);
    await ensureCommerceBackstop();
    expect(assertMock).toHaveBeenCalledTimes(1);
  });

  it('re-throws BackstopError for an owner-role connection and hands out no handle', async () => {
    assertMock.mockRejectedValue(new BackstopError('"$user", public'));
    await expect(commerceTenantDbChecked(TG)).rejects.toBeInstanceOf(BackstopError);
  });

  it('names the variable and role on any other failure, and does not cache it', async () => {
    assertMock.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND placeholder'));
    await expect(ensureCommerceBackstop()).rejects.toThrow(
      /COMMERCE_APP_DATABASE_URL must point at the low-privilege commerce_app role.*ENOTFOUND/,
    );
    // Not cached: the next request checks again (and here it passes).
    assertMock.mockResolvedValueOnce(undefined);
    await expect(ensureCommerceBackstop()).resolves.toBeUndefined();
    expect(assertMock).toHaveBeenCalledTimes(2);
  });

  it('fails with the named error when COMMERCE_APP_DATABASE_URL is unset', async () => {
    delete process.env.COMMERCE_APP_DATABASE_URL;
    await expect(ensureCommerceBackstop()).rejects.toThrow(/COMMERCE_APP_DATABASE_URL is not set/);
    expect(assertMock).not.toHaveBeenCalled();
  });
});

describe('tenant schema existence check', () => {
  it('checks the schema once per tenant group and caches the success', async () => {
    assertMock.mockResolvedValue(undefined);
    await commerceTenantDbChecked(TG);
    await commerceTenantDbChecked(TG);
    expect(probeMock).toHaveBeenCalledTimes(1);
    expect(probeMock).toHaveBeenCalledWith({ __base: true }, tenantSchema(TG));
  });

  it('raises CommerceTenantNotProvisionedError for a missing schema, and does not cache it', async () => {
    assertMock.mockResolvedValue(undefined);
    probeMock.mockResolvedValueOnce(false);
    const failure = await commerceTenantDbChecked(TG).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CommerceTenantNotProvisionedError);
    expect(isCommerceTenantNotProvisioned(failure)).toBe(true);

    // Provisioned later: the next request sees it without a restart.
    probeMock.mockResolvedValueOnce(true);
    expect(await commerceTenantDbChecked(TG)).toEqual({ __scopedHandleFor: TG });
    expect(probeMock).toHaveBeenCalledTimes(2);
  });
});

