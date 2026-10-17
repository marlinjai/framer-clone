// src/server/commerce/inventory/__tests__/reserve.test.ts
//
// Headless UNIT tests for the reserve heart's DB-free decisions. They run in the
// node project of the standard `pnpm test` gate (no Docker):
//   - RESERVE_ISOLATION_LEVEL is READ COMMITTED, and reserveTransaction opens the
//     transaction at exactly that level (the guarded decrement is proven only
//     there; a stricter level turns a clean zero-row loss into a 40001 throw),
//   - isRequestIdUniqueViolation recognises ONLY a 23505 on the two request_id
//     indexes; any other unique violation (a primary-key duplicate, the sku
//     index) or another SQLSTATE must propagate unchanged, never be swallowed
//     as an idempotent replay,
//   - the input guards fire before any query (non-positive / fractional
//     quantities, an empty kit, a zero adjust delta).
//
// Everything that depends on Postgres semantics (the guarded UPDATE, the races,
// the effects, the policy branch) is proven against a live tenant schema in
// reserve.itest.ts, reserve.concurrency.itest.ts and reserve.policy.itest.ts.
// Ported in CM-13 from the retired Prisma unit suite, whose P2002 cases map to
// the postgres.js 23505 cases here.

import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { CommerceDB } from '../../db-types';
import {
  applyInventoryEffect,
  isRequestIdUniqueViolation,
  reserve,
  reserveKit,
  reserveTransaction,
  RESERVE_ISOLATION_LEVEL,
} from '../reserve';

const TG = '018f9c10-0000-7000-8000-00000000beef';

/** A handle that fails the test if a guard lets a query through. */
const untouchable = new Proxy(
  {},
  {
    get() {
      throw new Error('a query ran before the input guard');
    },
  },
) as unknown as Kysely<CommerceDB>;

function pgError(code: string, constraintName?: string): Error {
  return Object.assign(new Error(`pg ${code}`), { code, constraint_name: constraintName });
}

describe('isolation level', () => {
  it('RESERVE_ISOLATION_LEVEL is READ COMMITTED', () => {
    expect(RESERVE_ISOLATION_LEVEL).toBe('read committed');
  });

  it('reserveTransaction opens the transaction at RESERVE_ISOLATION_LEVEL and runs fn inside it', async () => {
    const levels: string[] = [];
    const trx = { marker: 'trx' };
    const db = {
      transaction: () => ({
        setIsolationLevel: (level: string) => {
          levels.push(level);
          return { execute: (fn: (t: unknown) => unknown) => fn(trx) };
        },
      }),
    } as unknown as Kysely<CommerceDB>;
    const fn = vi.fn(async (t: unknown) => t);

    expect(await reserveTransaction(db, fn)).toBe(trx);
    expect(levels).toEqual(['read committed']);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('isRequestIdUniqueViolation (concurrent-duplicate detection)', () => {
  it('matches a 23505 on either request_id index', () => {
    expect(isRequestIdUniqueViolation(pgError('23505', 'stock_movement_request_id_key'))).toBe(true);
    expect(isRequestIdUniqueViolation(pgError('23505', 'reservation_request_id_key'))).toBe(true);
  });

  it('does NOT match an unrelated unique violation, another SQLSTATE, or a non-error', () => {
    expect(isRequestIdUniqueViolation(pgError('23505', 'stock_movement_pkey'))).toBe(false);
    expect(isRequestIdUniqueViolation(pgError('23505', 'inventory_item_sku_active_key'))).toBe(false);
    expect(isRequestIdUniqueViolation(pgError('23505'))).toBe(false);
    expect(isRequestIdUniqueViolation(pgError('23514', 'stock_movement_request_id_key'))).toBe(false);
    expect(isRequestIdUniqueViolation(pgError('40001'))).toBe(false);
    expect(isRequestIdUniqueViolation(new Error('plain'))).toBe(false);
    expect(isRequestIdUniqueViolation(null)).toBe(false);
    expect(isRequestIdUniqueViolation('23505')).toBe(false);
  });
});

describe('input guards fire before any query', () => {
  it('reserve rejects a zero, negative or fractional quantity', async () => {
    for (const needed of [0, -3, 1.5]) {
      await expect(
        reserve(untouchable, TG, { inventoryItemId: 'i', needed, requestId: 'r' }),
      ).rejects.toThrow(/reserve\.needed must be a positive integer/);
    }
  });

  it('reserveKit rejects a bad multiplier, an empty kit and a bad component quantity', async () => {
    await expect(
      reserveKit(untouchable, TG, {
        components: [{ inventoryItemId: 'i', requiredQuantity: 1 }],
        multiplier: 0,
        requestId: 'k',
      }),
    ).rejects.toThrow(/multiplier must be a positive integer/);
    await expect(reserveKit(untouchable, TG, { components: [], requestId: 'k' })).rejects.toThrow(
      /at least one component/,
    );
    await expect(
      reserveKit(untouchable, TG, {
        components: [{ inventoryItemId: 'i', requiredQuantity: -1 }],
        requestId: 'k',
      }),
    ).rejects.toThrow(/requiredQuantity must be a positive integer/);
  });

  it('applyInventoryEffect rejects a zero adjust delta once past the idempotency check', async () => {
    // The idempotency lookup runs first (a replayed request_id is a no-op), so this
    // fake answers "not in the ledger yet"; the delta guard must then throw before
    // any location lookup or UPDATE.
    const chain: Record<string, unknown> = {};
    for (const m of ['selectFrom', 'select', 'where']) chain[m] = () => chain;
    chain.executeTakeFirst = async () => undefined;
    await expect(
      applyInventoryEffect(chain as unknown as Kysely<CommerceDB>, TG, {
        type: 'adjust',
        inventoryItemId: 'i',
        delta: 0,
        requestId: 'adj-0',
      }),
    ).rejects.toThrow(/adjust\.delta must be a non-zero integer/);
  });
});
