// src/server/commerce/repository/__tests__/pricing.test.ts
//
// Headless UNIT tests for the pricing resolution rules and the money guard. They
// run in the node project of the standard `pnpm test` gate (no Docker, no live
// Postgres). The resolution rules live in the pure `selectPrice` (which
// `pricingRepository.resolvePrice` feeds with the price rows it reads), so they
// are pinned here directly; the repository itself is driven with a small fake
// Kysely query chain only to prove its wiring (no price_set -> null, rows ->
// selectPrice, the guard firing before any insert).
//
// What is covered here:
//   (a) addPrice's assertIntegerCents rejects a float AND a negative amount (and a
//       negative band edge) at the boundary, before any insert (mirrored by the
//       price_amount_nonneg_check CHECK, proven live in pricing.itest.ts).
//   (b) the active-list date window via an injected `now`: an expired, future or
//       draft price_list is ignored; a list whose window contains now applies.
//   (c) the quantity-band boundaries: excluded at min_quantity - 1, included at
//       both edges, excluded above max_quantity.
//   (d) the lowest-amount tie-break with two active lists: a sale of 1500
//       alongside an override of 1800 resolves to 1500. This pins the current
//       "lowest wins, type and priority ignored" behaviour so a future b7
//       precedence change (price_rule.priority / PriceListType) is a VISIBLE diff
//       in this assertion (see the contract doc on selectPrice).
//
// Ported in CM-13 from the retired Prisma version of this suite; every case is
// kept.

import { describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

import type { CommerceDB } from '../../db-types';
import { pricingRepository, selectPrice, type PriceCandidate } from '../pricing';
import { DEMO_COMPANY_ID } from '@/lib/renderer/server/demoTenant';

/** A db that fails the test if anything touches it (the guard must fire first). */
const untouchableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('the database was touched before the money guard ran');
    },
  },
) as unknown as Kysely<CommerceDB>;

/**
 * A fake Kysely handle for resolvePrice / addPrice wiring: every builder method
 * returns the chain, the price_set lookup resolves to `priceSet`, the price
 * SELECT resolves to `prices`, and an insert echoes the values it was given.
 */
function fakeDb(opts: { priceSet?: { id: string } | undefined; prices?: PriceCandidate[] } = {}) {
  const inserted: Array<Record<string, unknown>> = [];
  let pendingValues: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  for (const method of ['selectFrom', 'select', 'where', 'leftJoin', 'insertInto', 'returningAll']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.values = vi.fn((values: Record<string, unknown>) => {
    pendingValues = values;
    return chain;
  });
  chain.executeTakeFirst = vi.fn(async () => opts.priceSet);
  chain.execute = vi.fn(async () => opts.prices ?? []);
  chain.executeTakeFirstOrThrow = vi.fn(async () => {
    inserted.push(pendingValues);
    return pendingValues;
  });
  return { db: chain as unknown as Kysely<CommerceDB>, inserted, chain };
}

/** A candidate row as resolvePrice reads it (price LEFT JOIN price_list). */
function candidate(over: {
  amount: number;
  priceListId?: string | null;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  status?: 'draft' | 'active';
  startsAt?: Date | null;
  endsAt?: Date | null;
}): PriceCandidate {
  const listed = over.priceListId != null;
  return {
    price_list_id: over.priceListId ?? null,
    amount: over.amount,
    min_quantity: over.minQuantity ?? null,
    max_quantity: over.maxQuantity ?? null,
    list_status: listed ? (over.status ?? 'active') : null,
    list_starts_at: listed ? (over.startsAt ?? null) : null,
    list_ends_at: listed ? (over.endsAt ?? null) : null,
  };
}

describe('addPrice money guard (assertIntegerCents at the boundary)', () => {
  // addPrice runs assertIntegerCents synchronously before it builds the insert,
  // so a bad amount throws at the call site, before any I/O.
  it('rejects a float amount (euros instead of cents) before any insert', () => {
    expect(() =>
      pricingRepository.addPrice(untouchableDb, { tenantId: DEMO_COMPANY_ID, priceSetId: 'pset-1', currency: 'EUR', amount: 19.99 }),
    ).toThrow(/integer number of minor units/);
  });

  it('rejects a NEGATIVE amount (money-losing) before any insert', () => {
    expect(() =>
      pricingRepository.addPrice(untouchableDb, { tenantId: DEMO_COMPANY_ID, priceSetId: 'pset-1', currency: 'EUR', amount: -1999 }),
    ).toThrow(/non-negative number of minor units/);
  });

  it('also rejects a negative or fractional minQuantity / maxQuantity (band guard at the boundary)', () => {
    expect(() =>
      pricingRepository.addPrice(untouchableDb, { tenantId: DEMO_COMPANY_ID,
        priceSetId: 'pset-1',
        currency: 'EUR',
        amount: 1000,
        minQuantity: -1,
      }),
    ).toThrow(/non-negative number of minor units/);
    expect(() =>
      pricingRepository.addPrice(untouchableDb, { tenantId: DEMO_COMPANY_ID,
        priceSetId: 'pset-1',
        currency: 'EUR',
        amount: 1000,
        maxQuantity: 2.5,
      }),
    ).toThrow(/integer number of minor units/);
  });

  it('accepts a non-negative integer amount and forwards it, unchanged, to the insert', async () => {
    const { db, inserted } = fakeDb();
    const created = await pricingRepository.addPrice(db, { tenantId: DEMO_COMPANY_ID,
      priceSetId: 'pset-1',
      currency: 'EUR',
      amount: 1999,
    });
    expect(created.amount).toBe(1999);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ price_set_id: 'pset-1', currency_code: 'EUR', amount: 1999 });
  });
});

describe('selectPrice: active-list date window (injected now)', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z');
  const resolveWith = (list: { status?: 'draft' | 'active'; startsAt?: Date | null; endsAt?: Date | null }) =>
    selectPrice(
      [candidate({ amount: 2000 }), candidate({ amount: 1500, priceListId: 'list-1', ...list })],
      { priceListIds: ['list-1'], now: NOW },
    );

  it('ignores a list whose window is in the FUTURE (starts_at after now): base price stands', () => {
    expect(resolveWith({ startsAt: new Date('2026-07-01T00:00:00.000Z') })).toBe(2000);
  });

  it('ignores a list whose window has EXPIRED (ends_at before now): base price stands', () => {
    expect(resolveWith({ endsAt: new Date('2026-06-01T00:00:00.000Z') })).toBe(2000);
  });

  it('applies a list whose window CONTAINS now: the 1500 list price wins', () => {
    expect(
      resolveWith({
        startsAt: new Date('2026-06-01T00:00:00.000Z'),
        endsAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
    ).toBe(1500);
  });

  it('accepts the window bounds as ISO strings too (the driver may return either)', () => {
    expect(
      selectPrice(
        [
          candidate({ amount: 2000 }),
          {
            ...candidate({ amount: 1500, priceListId: 'list-1' }),
            list_starts_at: '2026-06-01T00:00:00.000Z',
            list_ends_at: '2026-06-10T00:00:00.000Z',
          },
        ],
        { priceListIds: ['list-1'], now: NOW },
      ),
    ).toBe(2000);
  });

  it('ignores a DRAFT list even when requested and within window: base price stands', () => {
    expect(resolveWith({ status: 'draft' })).toBe(2000);
  });

  it('ignores an active list that was NOT requested in priceListIds', () => {
    expect(
      selectPrice([candidate({ amount: 2000 }), candidate({ amount: 1500, priceListId: 'list-1' })], {
        priceListIds: [],
        now: NOW,
      }),
    ).toBe(2000);
  });
});

describe('selectPrice: quantity-band boundaries', () => {
  // A single base price scoped to the band [3, 5]; the base price always passes
  // the list filter, so this isolates the quantity-band logic.
  const when = (quantity: number) =>
    selectPrice([candidate({ amount: 1200, minQuantity: 3, maxQuantity: 5 })], { quantity });

  it('is EXCLUDED below the band (min_quantity - 1 = 2): no price applies -> null', () => {
    expect(when(2)).toBeNull();
  });

  it('is INCLUDED at the lower edge (min_quantity = 3): the banded price applies', () => {
    expect(when(3)).toBe(1200);
  });

  it('is INCLUDED at the upper edge (max_quantity = 5): the banded price applies', () => {
    expect(when(5)).toBe(1200);
  });

  it('is EXCLUDED above the band (max_quantity + 1 = 6): no price applies -> null', () => {
    expect(when(6)).toBeNull();
  });

  it('defaults the quantity to 1', () => {
    expect(selectPrice([candidate({ amount: 700, minQuantity: 2 })], {})).toBeNull();
    expect(selectPrice([candidate({ amount: 700, maxQuantity: 1 })], {})).toBe(700);
  });
});

describe('selectPrice: lowest-amount tie-break (B5-PRICE-02 pinned behaviour)', () => {
  // PIN: with two active lists requested, a `sale` of 1500 and an `override` of
  // 1800, the LOWEST amount (1500) wins, IGNORING PriceListType precedence and
  // price_rule.priority (both land in b7). If a future change makes type or rule
  // priority decide the winner, THIS assertion must change.
  it('two active lists: sale 1500 + override 1800 resolves to 1500 (lowest wins, type ignored)', () => {
    expect(
      selectPrice(
        [
          candidate({ amount: 2000 }),
          candidate({ amount: 1500, priceListId: 'sale-list' }),
          candidate({ amount: 1800, priceListId: 'override-list' }),
        ],
        { priceListIds: ['sale-list', 'override-list'] },
      ),
    ).toBe(1500);
  });

  it('a list price wins over a cheaper-looking base: the list tier is preferred', () => {
    expect(
      selectPrice([candidate({ amount: 900 }), candidate({ amount: 1500, priceListId: 'list-1' })], {
        priceListIds: ['list-1'],
      }),
    ).toBe(1500);
  });

  it('among base prices only, the lowest amount wins', () => {
    expect(selectPrice([candidate({ amount: 1300 }), candidate({ amount: 1100 })], {})).toBe(1100);
  });

  it('no candidate rows resolves to null (surfaced honestly, not 0)', () => {
    expect(selectPrice([], {})).toBeNull();
  });
});

describe('pricingRepository.resolvePrice wiring', () => {
  it('no price_set for the variant resolves to null without reading prices', async () => {
    const { db, chain } = fakeDb({ priceSet: undefined });
    expect(await pricingRepository.resolvePrice(db, 'orphan', { currency: 'EUR' })).toBeNull();
    expect(chain.execute).not.toHaveBeenCalled();
  });

  it('feeds the read rows through selectPrice with the caller options', async () => {
    const { db } = fakeDb({
      priceSet: { id: 'pset-1' },
      prices: [candidate({ amount: 2000 }), candidate({ amount: 1500, priceListId: 'list-1' })],
    });
    expect(
      await pricingRepository.resolvePrice(db, 'var-1', { currency: 'EUR', priceListIds: ['list-1'] }),
    ).toBe(1500);
    expect(await pricingRepository.resolvePrice(db, 'var-1', { currency: 'EUR' })).toBe(2000);
  });
});
