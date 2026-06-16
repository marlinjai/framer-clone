// src/server/commerce/repository/__tests__/pricing.test.ts
//
// Headless UNIT tests for the b5 pricing resolution + money guard. These run in
// the node project of the standard `pnpm test` gate (no Docker, no live
// Postgres): the transaction client is a programmable fake (the same pattern
// reserve.test.ts uses), so what is exercised here is the resolvePrice CONTROL
// FLOW and the addPrice boundary guard, not Postgres semantics. This is the file
// that makes the headless verify gate actually prove b5's pricing guarantees:
// before it existed, 100% of b5's tests lived in pricing.itest.ts, which the
// `.itest.ts` suffix keeps OUT of `pnpm test`, so the gate proved nothing.
//
// What is covered here:
//   (a) addPrice's assertIntegerCents rejects a float AND a negative amount at
//       the boundary (mirrored by the price_amount_nonneg_check CHECK in the b5
//       migration, which is proven against live Postgres in pricing.itest.ts).
//   (b) resolvePrice's active-list date-window filter via an injected `now`: an
//       expired or future price_list is ignored.
//   (c) resolvePrice's quantity-band boundaries: excluded at min_quantity - 1,
//       included at min_quantity, excluded above max_quantity.
//   (d) resolvePrice's lowest-amount tie-break with two active lists: a sale of
//       1500 alongside an override of 1800 resolves to 1500. This pins the
//       current "lowest-wins, type-and-priority-ignored" behavior so a future
//       b7 precedence change (price_rule.priority / PriceListType) is a VISIBLE
//       diff in this assertion (see the B5-PRICE-02 contract doc on resolvePrice).
//
// The DB-level guarantees (the CHECK constraints biting at the database, the
// cents round-trip on a real Int column, the no-DELETE contract) are proven
// against Dockerized Postgres in pricing.itest.ts (kept out of this gate by the
// `.itest.ts` suffix).

import { describe, expect, it, vi } from 'vitest';

import { pricingRepository } from '../pricing';

// A programmable fake of Prisma.TransactionClient: only the members pricing.ts
// touches are implemented. addPrice calls tx.price.create; resolvePrice calls
// tx.priceSet.findUnique then tx.price.findMany. Each is a vi.fn() the test wires
// per-scenario, so the branching logic is tested deterministically without a DB.
function makeTx(overrides: Record<string, unknown> = {}) {
  const tx = {
    priceSet: { findUnique: vi.fn(), create: vi.fn() },
    price: {
      findMany: vi.fn(),
      // create echoes the data back as if Postgres returned the row, so the
      // boundary guard (assertIntegerCents) is what we exercise, not the insert.
      create: vi.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'price-fake', ...data }),
      ),
    },
  };
  return Object.assign(tx, overrides) as typeof tx & Record<string, unknown>;
}

// Build a PriceWithList-shaped row the way tx.price.findMany returns it (a price
// row with its optional priceList included). Only the fields resolvePrice reads
// are populated; the rest are filled with inert defaults.
function makePriceRow(over: {
  id?: string;
  priceListId?: string | null;
  amount: number;
  minQuantity?: number | null;
  maxQuantity?: number | null;
  list?: {
    status?: 'draft' | 'active';
    type?: 'override' | 'sale';
    startsAt?: Date | null;
    endsAt?: Date | null;
  } | null;
}) {
  const priceListId = over.priceListId ?? null;
  const list =
    priceListId == null
      ? null
      : {
          id: priceListId,
          title: null,
          status: over.list?.status ?? 'active',
          type: over.list?.type ?? 'override',
          startsAt: over.list?.startsAt ?? null,
          endsAt: over.list?.endsAt ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
  return {
    id: over.id ?? 'price-1',
    priceSetId: 'pset-1',
    priceListId,
    currencyCode: 'EUR',
    amount: over.amount,
    minQuantity: over.minQuantity ?? null,
    maxQuantity: over.maxQuantity ?? null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    priceList: list,
  };
}

describe('addPrice money guard (assertIntegerCents at the boundary)', () => {
  // addPrice runs assertIntegerCents synchronously before it builds the insert
  // promise, so a bad amount throws at the call site (the guard fires before any
  // I/O). Wrapping the call in `() => ...` lets toThrow capture that synchronous
  // throw; the production caller (withTenant) is async and surfaces the same
  // error as a rejection, which is what pricing.itest.ts asserts against Postgres.
  it('rejects a float amount (euros instead of cents) before any insert', () => {
    const tx = makeTx();
    expect(() =>
      pricingRepository.addPrice(tx as never, {
        priceSetId: 'pset-1',
        currency: 'EUR',
        amount: 19.99,
      }),
    ).toThrow(/integer number of minor units|cents/);
    expect(tx.price.create).not.toHaveBeenCalled();
  });

  it('rejects a NEGATIVE amount (money-losing) before any insert', () => {
    const tx = makeTx();
    expect(() =>
      pricingRepository.addPrice(tx as never, {
        priceSetId: 'pset-1',
        currency: 'EUR',
        amount: -1999,
      }),
    ).toThrow(/non-negative number of minor units|cents/);
    expect(tx.price.create).not.toHaveBeenCalled();
  });

  it('also rejects a negative minQuantity / maxQuantity (band guard at the boundary)', () => {
    const tx = makeTx();
    expect(() =>
      pricingRepository.addPrice(tx as never, {
        priceSetId: 'pset-1',
        currency: 'EUR',
        amount: 1000,
        minQuantity: -1,
      }),
    ).toThrow(/non-negative number of minor units|cents/);
    expect(tx.price.create).not.toHaveBeenCalled();
  });

  it('accepts a non-negative integer amount and forwards it to the insert', async () => {
    const tx = makeTx();
    const created = await pricingRepository.addPrice(tx as never, {
      priceSetId: 'pset-1',
      currency: 'EUR',
      amount: 1999,
    });
    expect(created.amount).toBe(1999);
    expect(tx.price.create).toHaveBeenCalledTimes(1);
  });
});

describe('resolvePrice active-list date-window (injected now)', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z');

  function txWithBaseAndListPrice(list: {
    status?: 'draft' | 'active';
    startsAt?: Date | null;
    endsAt?: Date | null;
  }) {
    const tx = makeTx();
    tx.priceSet.findUnique.mockResolvedValue({ id: 'pset-1', variantId: 'var-1' });
    tx.price.findMany.mockResolvedValue([
      makePriceRow({ id: 'base', amount: 2000 }),
      makePriceRow({ id: 'listed', priceListId: 'list-1', amount: 1500, list }),
    ]);
    return tx;
  }

  it('ignores a list whose window is in the FUTURE (starts_at after now): base price stands', async () => {
    const tx = txWithBaseAndListPrice({
      startsAt: new Date('2026-07-01T00:00:00.000Z'), // begins after NOW
    });
    const resolved = await pricingRepository.resolvePrice(tx as never, 'var-1', {
      currency: 'EUR',
      priceListIds: ['list-1'],
      now: NOW,
    });
    expect(resolved).toBe(2000);
  });

  it('ignores a list whose window has EXPIRED (ends_at before now): base price stands', async () => {
    const tx = txWithBaseAndListPrice({
      endsAt: new Date('2026-06-01T00:00:00.000Z'), // ended before NOW
    });
    const resolved = await pricingRepository.resolvePrice(tx as never, 'var-1', {
      currency: 'EUR',
      priceListIds: ['list-1'],
      now: NOW,
    });
    expect(resolved).toBe(2000);
  });

  it('applies a list whose window CONTAINS now: the 1500 list price wins', async () => {
    const tx = txWithBaseAndListPrice({
      startsAt: new Date('2026-06-01T00:00:00.000Z'),
      endsAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const resolved = await pricingRepository.resolvePrice(tx as never, 'var-1', {
      currency: 'EUR',
      priceListIds: ['list-1'],
      now: NOW,
    });
    expect(resolved).toBe(1500);
  });

  it('ignores a DRAFT list even when requested and within window: base price stands', async () => {
    const tx = txWithBaseAndListPrice({ status: 'draft' });
    const resolved = await pricingRepository.resolvePrice(tx as never, 'var-1', {
      currency: 'EUR',
      priceListIds: ['list-1'],
      now: NOW,
    });
    expect(resolved).toBe(2000);
  });
});

describe('resolvePrice quantity-band boundaries', () => {
  // A single base price scoped to the band [3, 5]. The base price always passes
  // the list filter, so this isolates the quantity-band logic.
  function when(quantity: number) {
    const tx = makeTx();
    tx.priceSet.findUnique.mockResolvedValue({ id: 'pset-1', variantId: 'var-1' });
    tx.price.findMany.mockResolvedValue([
      makePriceRow({ id: 'banded', amount: 1200, minQuantity: 3, maxQuantity: 5 }),
    ]);
    return pricingRepository.resolvePrice(tx as never, 'var-1', {
      currency: 'EUR',
      quantity,
    });
  }

  it('is EXCLUDED below the band (min_quantity - 1 = 2): no price applies -> null', async () => {
    expect(await when(2)).toBeNull();
  });

  it('is INCLUDED at the lower edge (min_quantity = 3): the banded price applies', async () => {
    expect(await when(3)).toBe(1200);
  });

  it('is INCLUDED at the upper edge (max_quantity = 5): the banded price applies', async () => {
    expect(await when(5)).toBe(1200);
  });

  it('is EXCLUDED above the band (max_quantity + 1 = 6): no price applies -> null', async () => {
    expect(await when(6)).toBeNull();
  });
});

describe('resolvePrice lowest-amount tie-break (B5-PRICE-02 pinned behavior)', () => {
  // PIN: with two active lists requested, a `sale` of 1500 and an `override` of
  // 1800, b5 takes the LOWEST amount (1500), IGNORING PriceListType precedence
  // and price_rule.priority (both land in b7). If a future change makes type or
  // rule priority decide the winner, THIS assertion must change, making the
  // behavior shift a visible diff rather than a silent one.
  it('two active lists: sale 1500 + override 1800 resolves to 1500 (lowest wins, type ignored)', async () => {
    const tx = makeTx();
    tx.priceSet.findUnique.mockResolvedValue({ id: 'pset-1', variantId: 'var-1' });
    tx.price.findMany.mockResolvedValue([
      makePriceRow({ id: 'base', amount: 2000 }),
      makePriceRow({
        id: 'sale',
        priceListId: 'sale-list',
        amount: 1500,
        list: { status: 'active', type: 'sale' },
      }),
      makePriceRow({
        id: 'override',
        priceListId: 'override-list',
        amount: 1800,
        list: { status: 'active', type: 'override' },
      }),
    ]);

    const resolved = await pricingRepository.resolvePrice(tx as never, 'var-1', {
      currency: 'EUR',
      priceListIds: ['sale-list', 'override-list'],
    });
    expect(resolved).toBe(1500);
  });

  it('a list price wins over a cheaper-looking base: list tier is preferred even if base is lower-numbered', async () => {
    // The base is 900, the only active list price is 1500. A list price wins over
    // the base regardless of amount (tier preference), so 1500 is returned, NOT
    // the cheaper 900 base. This pins the "list tier beats base tier" rule.
    const tx = makeTx();
    tx.priceSet.findUnique.mockResolvedValue({ id: 'pset-1', variantId: 'var-1' });
    tx.price.findMany.mockResolvedValue([
      makePriceRow({ id: 'base', amount: 900 }),
      makePriceRow({
        id: 'listed',
        priceListId: 'list-1',
        amount: 1500,
        list: { status: 'active', type: 'override' },
      }),
    ]);

    const resolved = await pricingRepository.resolvePrice(tx as never, 'var-1', {
      currency: 'EUR',
      priceListIds: ['list-1'],
    });
    expect(resolved).toBe(1500);
  });

  it('no price_set for the variant resolves to null (surfaced honestly, not 0)', async () => {
    const tx = makeTx();
    tx.priceSet.findUnique.mockResolvedValue(null);
    const resolved = await pricingRepository.resolvePrice(tx as never, 'orphan', {
      currency: 'EUR',
    });
    expect(resolved).toBeNull();
  });
});
