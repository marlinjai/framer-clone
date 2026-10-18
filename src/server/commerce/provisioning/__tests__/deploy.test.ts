// Unit test for the wiring checks of the container start step (deploy.ts). The
// database half (current_user, the migrations) is proven in roles.itest.ts.

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

// bootstrapAppRole is the only database call assertAppRoleSearchPath makes;
// replaced here so the unit test stays database-free. AppRoleSearchPathError
// stays the real class, so the message under test is tenant-db's own.
vi.mock('@marlinjai/tenant-db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@marlinjai/tenant-db')>();
  return { ...actual, bootstrapAppRole: vi.fn() };
});

import { AppRoleSearchPathError, bootstrapAppRole } from '@marlinjai/tenant-db';
import { assertAppRoleSearchPath, assertOwnerUrlShape } from '../deploy';

const bootstrap = vi.mocked(bootstrapAppRole);
const fakeSql = {} as postgres.Sql;

describe('assertOwnerUrlShape', () => {
  it('refuses an unset owner URL, naming the variable', () => {
    expect(() => assertOwnerUrlShape({ ownerUrl: undefined, appUrl: 'postgresql://a@h/db' })).toThrow(
      /COMMERCE_OWNER_DATABASE_URL is not set/,
    );
    expect(() => assertOwnerUrlShape({ ownerUrl: '', appUrl: undefined })).toThrow(/is not set/);
  });

  it('refuses a placeholder', () => {
    expect(() => assertOwnerUrlShape({ ownerUrl: 'PLACEHOLDER_REPLACE_ME', appUrl: undefined })).toThrow(
      /placeholder/,
    );
  });

  it('refuses the app URL as the owner URL', () => {
    const same = 'postgresql://commerce_app@h:5432/db';
    expect(() => assertOwnerUrlShape({ ownerUrl: same, appUrl: same })).toThrow(/never as the app role/);
  });

  it('returns a distinct, real owner URL', () => {
    const owner = 'postgresql://commerce_ddl@h:5432/db';
    expect(assertOwnerUrlShape({ ownerUrl: owner, appUrl: 'postgresql://commerce_app@h:5432/db' })).toBe(owner);
    expect(assertOwnerUrlShape({ ownerUrl: owner, appUrl: undefined })).toBe(owner);
  });
});

describe('assertAppRoleSearchPath', () => {
  it('only reads: calls bootstrapAppRole for commerce_app in verify mode', async () => {
    bootstrap.mockReset().mockResolvedValue('unchanged');
    await expect(assertAppRoleSearchPath(fakeSql)).resolves.toBeUndefined();
    expect(bootstrap).toHaveBeenCalledWith(fakeSql, 'commerce_app', { mode: 'verify' });
  });

  it('turns a role-wide mismatch into a start failure carrying the repair command and the roles file', async () => {
    const cause = new AppRoleSearchPathError('commerce_app', 'mismatch', '"$user", public');
    bootstrap.mockReset().mockRejectedValue(cause);
    const err = await assertAppRoleSearchPath(fakeSql).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).cause).toBe(cause);
    expect((err as Error).message).toMatch(/commerce_app is not ready \(mismatch\)/);
    expect((err as Error).message).toContain('ALTER ROLE "commerce_app" SET search_path = ext');
    expect((err as Error).message).toContain('Re-applying prisma/sql/commerce-roles.sql');
  });

  it('names the per-database command, not the roles file, for a per-database override', async () => {
    bootstrap
      .mockReset()
      .mockRejectedValue(new AppRoleSearchPathError('commerce_app', 'database_override', 'public', { database: 'shop' }));
    const err = (await assertAppRoleSearchPath(fakeSql).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('IN DATABASE "shop"');
    expect(err.message).not.toContain('commerce-roles.sql');
  });

  it('passes any other error through unchanged', async () => {
    const other = new Error('connection refused');
    bootstrap.mockReset().mockRejectedValue(other);
    await expect(assertAppRoleSearchPath(fakeSql)).rejects.toBe(other);
  });
});
