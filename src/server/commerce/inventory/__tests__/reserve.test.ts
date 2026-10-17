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
//   - a duplicate-key error on an UNRELATED constraint, raised by the insert
//     inside reserve itself, propagates unchanged out of reserve AND out of
//     reserveWithRetry (no idempotent re-read, no second transaction); this
//     runs reserve end to end on a real Kysely instance whose driver answers
//     each compiled query from a script instead of a database,
//   - the input guards fire before any query (non-positive / fractional
//     quantities, an empty kit, a zero adjust delta).
//
// Everything that depends on Postgres semantics (the guarded UPDATE, the races,
// the effects, the policy branch) is proven against a live tenant schema in
// reserve.itest.ts, reserve.concurrency.itest.ts and reserve.policy.itest.ts.
// Ported in CM-13 from the retired Prisma unit suite, whose P2002 cases map to
// the postgres.js 23505 cases here.

import { describe, expect, it, vi } from 'vitest';
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely';

import type { CommerceDB } from '../../db-types';
import {
  applyInventoryEffect,
  isRequestIdUniqueViolation,
  reserve,
  reserveKit,
  reserveTransaction,
  reserveWithRetry,
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

/**
 * A real Kysely<CommerceDB> (Postgres compiler, real query builders and
 * transactions) over a scripted driver: `answer` receives each compiled SQL
 * statement and returns its result or throws. Lets reserve run its full
 * control flow without a database.
 */
function scriptedDb(answer: (sqlText: string) => QueryResult<unknown>) {
  const statements: string[] = [];
  let transactions = 0;
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      return answer(query.sql) as QueryResult<R>;
    },
    async *streamQuery() {
      throw new Error('streaming is not scripted');
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {
      transactions += 1;
    },
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<CommerceDB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, statements, transactionCount: () => transactions };
}

describe('an unrelated duplicate-key error propagates unchanged out of reserve', () => {
  // A managed variant with stock: policy lookup, location check, idempotency
  // pre-check (nothing yet), the guarded UPDATE matching one row, and then the
  // stock_movement INSERT fails on its PRIMARY KEY, not on a request_id index.
  const pkViolation = pgError('23505', 'stock_movement_pkey');
  const answer = (sqlText: string): QueryResult<unknown> => {
    if (/from "product_variant"/.test(sqlText)) {
      return { rows: [{ manage_inventory: true, allow_backorder: false }] };
    }
    if (/from "stock_location"/.test(sqlText)) return { rows: [{ id: 'loc-1' }] };
    if (/from "stock_movement"/.test(sqlText)) return { rows: [] };
    if (/^\s*UPDATE/i.test(sqlText)) return { rows: [], numAffectedRows: BigInt(1) };
    if (/insert into "stock_movement"/.test(sqlText)) throw pkViolation;
    throw new Error(`unscripted statement: ${sqlText}`);
  };
  const args = {
    inventoryItemId: 'inv-1',
    variantId: 'var-1',
    locationId: 'loc-1',
    needed: 1,
    requestId: 'req-pk',
  };

  it('reserve rethrows the very same error object (not the DuplicateRequestError sentinel)', async () => {
    const { db, statements } = scriptedDb(answer);
    const caught = await reserve(db, TG, args).catch((e: unknown) => e);
    expect(caught).toBe(pkViolation);
    expect((caught as Error).name).not.toBe('DuplicateRequestError');
    // It really reached the guarded UPDATE and the movement INSERT.
    expect(statements.some((q) => /^\s*UPDATE/i.test(q))).toBe(true);
    expect(statements.some((q) => /insert into "stock_movement"/.test(q))).toBe(true);
  });

  it('reserveWithRetry propagates it too: one transaction, no idempotent re-read', async () => {
    const { db, statements, transactionCount } = scriptedDb(answer);
    await expect(reserveWithRetry(db, TG, args)).rejects.toBe(pkViolation);
    expect(transactionCount()).toBe(1);
    expect(statements.some((q) => /from "reservation"/.test(q))).toBe(false);
  });
});
