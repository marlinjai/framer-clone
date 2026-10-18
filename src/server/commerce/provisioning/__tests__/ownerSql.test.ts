// Unit test for the start-time migration budget (ownerSql.ts migrationTimeouts).

import { describe, expect, it } from 'vitest';

import { MIGRATION_LOCK_TIMEOUT_MS, migrationTimeouts } from '../ownerSql';

describe('migrationTimeouts', () => {
  it('defaults to a 5 s lock wait and no statement limit', () => {
    expect(MIGRATION_LOCK_TIMEOUT_MS).toBe(5_000);
    expect(migrationTimeouts({})).toEqual({ lockTimeoutMs: 5_000, statementTimeoutMs: 0 });
    expect(migrationTimeouts({ COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS: '  ' })).toEqual({
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 0,
    });
  });

  it('takes a statement bound from COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS', () => {
    expect(migrationTimeouts({ COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS: '600000' }).statementTimeoutMs).toBe(600_000);
    expect(migrationTimeouts({ COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS: '0' }).statementTimeoutMs).toBe(0);
  });

  it('refuses a value that is not a whole, non-negative number of milliseconds', () => {
    for (const bad of ['10m', '-1', '1.5', 'abc']) {
      expect(() => migrationTimeouts({ COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS: bad })).toThrow(
        /COMMERCE_MIGRATE_STATEMENT_TIMEOUT_MS must be a whole number/,
      );
    }
  });
});
