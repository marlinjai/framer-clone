import { describe, it, expect } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

import { COMMERCE_SCHEMA, withTenant } from '../withTenant';

// The seam is verified WITHOUT a real database or generated query engine.
// `withTenant` only imports `@prisma/client` for types (erased at runtime), so
// a hand-rolled fake PrismaClient whose `$transaction` runs the interactive
// callback is enough to assert the contract: SET LOCAL is issued on the tx
// connection, inside the transaction, BEFORE `fn` runs, on EVERY call.

type RawCall = { sql: string };

/**
 * A fake PrismaClient that records, in order, every `$executeRawUnsafe` issued
 * on the tx client and every time `fn` runs. `$transaction(cb)` mirrors
 * Prisma's interactive-transaction form: it builds a tx client and awaits cb.
 */
function makeFakePrisma() {
  const order: string[] = [];
  const rawCalls: RawCall[] = [];

  const tx = {
    $executeRawUnsafe: (sql: string) => {
      rawCalls.push({ sql });
      order.push(`raw:${sql}`);
      return Promise.resolve(1);
    },
  } as unknown as Prisma.TransactionClient;

  const prisma = {
    $transaction: <T>(cb: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
      // Real Prisma runs the callback against a tx-bound client; so do we.
      return cb(tx);
    },
  } as unknown as PrismaClient;

  return { prisma, order, rawCalls, markFnRan: () => order.push('fn') };
}

describe('withTenant', () => {
  it('issues SET LOCAL search_path inside the tx BEFORE fn runs', async () => {
    const { prisma, order, rawCalls, markFnRan } = makeFakePrisma();

    const result = await withTenant(prisma, COMMERCE_SCHEMA, async () => {
      markFnRan();
      return 'ok';
    });

    expect(result).toBe('ok');
    // Exactly one SET LOCAL, and it ran before fn.
    expect(order).toEqual([`raw:SET LOCAL search_path TO "${COMMERCE_SCHEMA}"`, 'fn']);
    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0].sql).toContain('SET LOCAL search_path');
    expect(rawCalls[0].sql).toContain(COMMERCE_SCHEMA);
  });

  it('defaults to COMMERCE_SCHEMA when no schema is passed (constant-schema seam)', async () => {
    const { prisma, rawCalls } = makeFakePrisma();

    await withTenant(prisma, async () => 'ok');

    expect(rawCalls).toHaveLength(1);
    expect(rawCalls[0].sql).toBe(`SET LOCAL search_path TO "${COMMERCE_SCHEMA}"`);
  });

  it('does not leak across two sequential calls: each call re-pins the path', async () => {
    const { prisma, rawCalls } = makeFakePrisma();

    await withTenant(prisma, COMMERCE_SCHEMA, async () => 'first');
    await withTenant(prisma, COMMERCE_SCHEMA, async () => 'second');

    // Two calls => two independent SET LOCAL statements. Nothing is carried
    // over from the first tx; the seam pins the schema fresh every time.
    expect(rawCalls).toHaveLength(2);
    expect(rawCalls[0].sql).toBe(`SET LOCAL search_path TO "${COMMERCE_SCHEMA}"`);
    expect(rawCalls[1].sql).toBe(`SET LOCAL search_path TO "${COMMERCE_SCHEMA}"`);
  });

  it('propagates errors from fn (the transaction is not swallowed)', async () => {
    const { prisma } = makeFakePrisma();

    await expect(
      withTenant(prisma, COMMERCE_SCHEMA, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('refuses an unsafe schema identifier before opening a transaction', () => {
    const { prisma, rawCalls } = makeFakePrisma();

    // The guard fails fast: it throws synchronously, before `$transaction` is
    // ever called, so no SET LOCAL is issued.
    expect(() =>
      withTenant(prisma, 'public"; DROP SCHEMA commerce; --', async () => 'nope'),
    ).toThrow(/unsafe schema identifier/);
    expect(rawCalls).toHaveLength(0);
  });
});
