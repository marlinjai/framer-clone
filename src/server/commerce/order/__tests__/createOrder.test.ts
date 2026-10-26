// src/server/commerce/order/__tests__/createOrder.test.ts
//
// Headless UNIT tests for the createOrder control flow. These run in the node
// project of the standard `pnpm test` gate (no Docker, no live Postgres): the
// scoped Kysely handle is a programmable fake whose transaction runs the
// callback with a fake `trx` (feeding a canned variant snapshot row), and the
// inner reserve plus the pricing and order repositories are stubbed, so what is
// exercised here is the CONTROL FLOW around the order WRITE, not Postgres
// semantics:
//   - computeLineTax across net, gross-extraction, reduced 7%, and zero,
//   - the explicit-rate / treatment consistency fix (an explicit rate derives its
//     treatment from the RESOLVED rate, not from taxClass alone),
//   - resolveLineRate's class -> default-rate mapping + the explicit override and
//     the basis-points ceiling rejection,
//   - the OrderShortageError -> { ok:false, shortages } translation,
//   - the 'no price resolved' loud throw,
//   - validateCart's guards (empty lines, missing requestId, quantity <= 0, and the
//     reverse-charge B2C precondition),
//   - both duplicate-detector predicates (the name-tagged reserve sentinel and the
//     postgres.js 23505 on order_request_id_key), and the fresh-transaction
//     re-read they trigger; an unrelated 23505 must propagate,
//   - the transaction runs at READ COMMITTED, the idempotency pre-check return,
//     and the happy-path order assembly.
//
// The REAL atomic rollback, the snapshot stability, the role REVOKE, the live
// money-math, and the order-level idempotency race are proven against Dockerized
// Postgres in createOrder.itest.ts and createOrder.isolation.itest.ts (kept out
// of this gate by the `.itest.ts` suffix).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';

// The three module seams createOrder composes. We mock them so the fake trx
// never needs a real repository or a real reserve: each test wires the canned
// behaviour.
vi.mock('../../inventory/reserve', async () => {
  const actual = await vi.importActual<typeof import('../../inventory/reserve')>(
    '../../inventory/reserve',
  );
  return { ...actual, reserve: vi.fn() };
});
vi.mock('../../repository/pricing', () => ({
  pricingRepository: { resolvePrice: vi.fn() },
}));
vi.mock('../../repository/order', () => ({
  orderRepository: {
    findByRequestId: vi.fn(),
    nextOrderNumber: vi.fn(),
    insertOrder: vi.fn(),
    insertLineItem: vi.fn(),
  },
}));

import type { CommerceDB } from '../../db-types';
import { reserve } from '../../inventory/reserve';
import { pricingRepository } from '../../repository/pricing';
import { orderRepository } from '../../repository/order';
import {
  computeLineTax,
  createOrder,
  isOrderRequestIdConflict,
  isReserveDuplicate,
  resolveLineRate,
  validateCart,
  REDUCED_RATE_BPS,
  STANDARD_RATE_BPS,
  type Cart,
} from '../createOrder';

const TG = '018f9c10-0000-7000-8000-00000000c0de';

const reserveMock = vi.mocked(reserve);
const resolvePriceMock = vi.mocked(pricingRepository.resolvePrice);
const findByRequestIdMock = vi.mocked(orderRepository.findByRequestId);
const nextOrderNumberMock = vi.mocked(orderRepository.nextOrderNumber);
const insertOrderMock = vi.mocked(orderRepository.insertOrder);
const insertLineItemMock = vi.mocked(orderRepository.insertLineItem);

afterEach(() => {
  vi.clearAllMocks();
});

/** A postgres.js-shaped unique violation (what kysely-postgres-js rethrows). */
function makePgUniqueViolation(constraintName: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint_name: constraintName,
  });
}

/**
 * A fake scoped handle. `db.transaction().setIsolationLevel(level).execute(fn)`
 * records the level and runs `fn` with a fake `trx`. The trx implements only the
 * query createOrder issues directly: the variant snapshot read
 * (selectFrom(...).leftJoin(...).select(...).where(...).executeTakeFirst()),
 * which resolves to `canned.variant`. The repository + reserve seams are mocked
 * at module level, so the trx does not need to back them.
 */
function makeFakeDb(canned: { variant?: unknown } = {}): {
  db: Kysely<CommerceDB>;
  trx: Record<string, unknown>;
  isolationLevels: string[];
  transactionCount: () => number;
} {
  const variant =
    'variant' in canned
      ? canned.variant
      : { title: 'V', sku: 'SKU', variantTaxClass: null, productTaxClass: null };
  const builder: Record<string, unknown> = {};
  for (const method of ['selectFrom', 'leftJoin', 'select', 'where']) {
    builder[method] = vi.fn(() => builder);
  }
  builder.executeTakeFirst = vi.fn(async () => variant);
  const trx = builder;
  const isolationLevels: string[] = [];
  let transactions = 0;
  const db = {
    transaction: vi.fn(() => ({
      setIsolationLevel: (level: string) => {
        isolationLevels.push(level);
        return {
          execute: async (fn: (t: typeof trx) => unknown) => {
            transactions += 1;
            return fn(trx);
          },
        };
      },
    })),
  } as unknown as Kysely<CommerceDB>;
  return { db, trx, isolationLevels, transactionCount: () => transactions };
}

/** A minimal valid one-line cart; tests override fields as needed. */
function baseCart(over: Partial<Cart> = {}): Cart {
  return {
    tenantId: '018f9c10-0000-7000-8000-0000000000dc',
    requestId: 'req-1',
    currency: 'EUR',
    taxRegion: 'DE',
    lines: [{ inventoryItemId: 'inv-1', variantId: 'var-1', quantity: 1 }],
    ...over,
  };
}

// ===========================================================================
describe('computeLineTax', () => {
  it('net: adds 19% standard VAT on top of the net base', () => {
    const t = computeLineTax(1000, {
      netOrGross: 'net',
      reverseCharge: false,
      kleinunternehmer: false,
    });
    expect(t).toEqual({ net: 1000, tax: 190, gross: 1190, rate: 1900, treatment: 'standard' });
  });

  it('gross: extracts the embedded VAT via round(base*rate/(10000+rate))', () => {
    // 1190 gross at 1900 bps -> tax = round(1190*1900/11900) = 190, net = 1000.
    const t = computeLineTax(1190, {
      netOrGross: 'gross',
      reverseCharge: false,
      kleinunternehmer: false,
    });
    expect(t).toEqual({ net: 1000, tax: 190, gross: 1190, rate: 1900, treatment: 'standard' });
  });

  it('reduced 7% (taxClass=reduced): net path, treatment reduced', () => {
    const t = computeLineTax(1000, {
      taxClass: 'reduced',
      netOrGross: 'net',
      reverseCharge: false,
      kleinunternehmer: false,
    });
    expect(t).toEqual({ net: 1000, tax: 70, gross: 1070, rate: 700, treatment: 'reduced' });
  });

  it('zero (taxClass=zero): zero tax, treatment zero', () => {
    const t = computeLineTax(1000, {
      taxClass: 'zero',
      netOrGross: 'net',
      reverseCharge: false,
      kleinunternehmer: false,
    });
    expect(t).toEqual({ net: 1000, tax: 0, gross: 1000, rate: 0, treatment: 'zero' });
  });

  it('reverse_charge suppresses VAT (treatment reverse_charge, zero tax)', () => {
    const t = computeLineTax(1000, {
      netOrGross: 'net',
      reverseCharge: true,
      kleinunternehmer: false,
    });
    expect(t).toEqual({ net: 1000, tax: 0, gross: 1000, rate: 0, treatment: 'reverse_charge' });
  });

  it('kleinunternehmer takes precedence over reverse_charge', () => {
    const t = computeLineTax(1000, {
      netOrGross: 'net',
      reverseCharge: true,
      kleinunternehmer: true,
    });
    expect(t).toEqual({ net: 1000, tax: 0, gross: 1000, rate: 0, treatment: 'kleinunternehmer' });
  });

  it('CONSISTENCY FIX: an explicit reduced rate with a null taxClass snapshots treatment=reduced', () => {
    // The bug: treatment derived from taxClass alone bucketed {explicitRate:700,
    // taxClass:null} as 'standard' while tax_rate snapshotted 700. The fix derives
    // the treatment from the RESOLVED rate, so the pair stays consistent.
    const t = computeLineTax(1000, {
      taxClass: null,
      explicitRate: REDUCED_RATE_BPS,
      netOrGross: 'net',
      reverseCharge: false,
      kleinunternehmer: false,
    });
    expect(t.rate).toBe(REDUCED_RATE_BPS);
    expect(t.treatment).toBe('reduced');
    expect(t.tax).toBe(70);
  });

  it('an explicit standard rate with a null taxClass snapshots treatment=standard', () => {
    const t = computeLineTax(1000, {
      taxClass: null,
      explicitRate: STANDARD_RATE_BPS,
      netOrGross: 'net',
      reverseCharge: false,
      kleinunternehmer: false,
    });
    expect(t.rate).toBe(STANDARD_RATE_BPS);
    expect(t.treatment).toBe('standard');
  });
});

// ===========================================================================
describe('resolveLineRate', () => {
  it('maps reduced -> 700, zero -> 0, default -> 1900', () => {
    expect(resolveLineRate('reduced')).toBe(700);
    expect(resolveLineRate('zero')).toBe(0);
    expect(resolveLineRate('standard')).toBe(1900);
    expect(resolveLineRate(null)).toBe(1900);
    expect(resolveLineRate(undefined)).toBe(1900);
  });

  it('honors an explicit rate override regardless of class', () => {
    expect(resolveLineRate('standard', 700)).toBe(700);
    expect(resolveLineRate(null, 0)).toBe(0);
  });

  it('rejects a negative explicit rate', () => {
    expect(() => resolveLineRate(null, -1)).toThrow(/non-negative integer/);
  });

  it('rejects an explicit rate above the 10000-bps ceiling', () => {
    expect(() => resolveLineRate(null, 10001)).toThrow(/<= 10000 basis points/);
  });
});

// ===========================================================================
describe('validateCart', () => {
  it('accepts a minimal valid cart', () => {
    expect(() => validateCart(baseCart())).not.toThrow();
  });

  it('rejects an empty lines array', () => {
    expect(() => validateCart(baseCart({ lines: [] }))).toThrow(/at least one line/);
  });

  it('rejects a missing requestId', () => {
    expect(() => validateCart(baseCart({ requestId: '' }))).toThrow(/requestId is required/);
  });

  it('rejects a non-positive quantity', () => {
    expect(() =>
      validateCart(baseCart({ lines: [{ inventoryItemId: 'i', variantId: 'v', quantity: 0 }] })),
    ).toThrow(/positive integer/);
  });

  it('REVERSE-CHARGE PRECONDITION: rejects reverseCharge for a B2C customer', () => {
    expect(() =>
      validateCart(baseCart({ reverseCharge: true, customerType: 'b2c', vatId: 'DE123' })),
    ).toThrow(/reverseCharge requires customerType "b2b"/);
  });

  it('REVERSE-CHARGE PRECONDITION: rejects reverseCharge when customerType is unset (defaults b2c)', () => {
    expect(() => validateCart(baseCart({ reverseCharge: true, vatId: 'DE123' }))).toThrow(
      /reverseCharge requires customerType "b2b"/,
    );
  });

  it('REVERSE-CHARGE PRECONDITION: rejects reverseCharge with an empty vatId for a B2B customer', () => {
    expect(() =>
      validateCart(baseCart({ reverseCharge: true, customerType: 'b2b', vatId: '   ' })),
    ).toThrow(/reverseCharge requires a non-empty vatId/);
  });

  it('REVERSE-CHARGE PRECONDITION: accepts reverseCharge for B2B with a non-empty vatId', () => {
    expect(() =>
      validateCart(baseCart({ reverseCharge: true, customerType: 'b2b', vatId: 'ATU12345678' })),
    ).not.toThrow();
  });
});

// ===========================================================================
describe('duplicate-detector predicates', () => {
  it('isReserveDuplicate matches the name-tagged DuplicateRequestError sentinel', () => {
    const sentinel = new Error('duplicate request_id');
    sentinel.name = 'DuplicateRequestError';
    expect(isReserveDuplicate(sentinel)).toBe(true);
    expect(isReserveDuplicate(new Error('something else'))).toBe(false);
    expect(isReserveDuplicate('not an error')).toBe(false);
  });

  it('isOrderRequestIdConflict matches a 23505 on the order request_id index, not others', () => {
    expect(isOrderRequestIdConflict(makePgUniqueViolation('order_request_id_key'))).toBe(true);
    expect(isOrderRequestIdConflict(makePgUniqueViolation('order_number_key'))).toBe(false);
    expect(isOrderRequestIdConflict(makePgUniqueViolation('order_pkey'))).toBe(false);
    expect(
      isOrderRequestIdConflict(
        Object.assign(new Error('fk'), { code: '23503', constraint_name: 'order_request_id_key' }),
      ),
    ).toBe(false);
    expect(isOrderRequestIdConflict(new Error('plain'))).toBe(false);
    expect(isOrderRequestIdConflict(null)).toBe(false);
  });
});

// ===========================================================================
describe('createOrder control flow', () => {
  it("throws loudly when no price resolves for a line (never a silent shortage)", async () => {
    const { db } = makeFakeDb();
    findByRequestIdMock.mockResolvedValue(undefined);
    resolvePriceMock.mockResolvedValue(null); // no applicable price

    await expect(createOrder(db, TG, baseCart())).rejects.toThrow(/no price resolved/);
  });

  it('translates an OrderShortageError into { ok:false, shortages }', async () => {
    const { db } = makeFakeDb();
    findByRequestIdMock.mockResolvedValue(undefined);
    resolvePriceMock.mockResolvedValue(1000);
    nextOrderNumberMock.mockResolvedValue('ORD-000001');
    insertOrderMock.mockResolvedValue({ id: 'order-1' } as never);
    insertLineItemMock.mockResolvedValue({ id: 'line-1' } as never);
    // The inner reserve short-stocks: createOrder must throw OrderShortageError
    // inside the transaction, which the outer catch translates to the contract.
    const shortages = [{ inventoryItemId: 'inv-1', locationId: 'loc-1', needed: 5, available: 1 }];
    reserveMock.mockResolvedValue({ ok: false, shortages });

    const result = await createOrder(
      db,
      TG,
      baseCart({ lines: [{ inventoryItemId: 'inv-1', variantId: 'var-1', quantity: 5 }] }),
    );
    expect(result).toEqual({ ok: false, shortages });
  });

  it('happy path: READ COMMITTED, server-computed totals, one INNER reserve per line on the same trx', async () => {
    const { db, trx, isolationLevels } = makeFakeDb({
      variant: { title: 'Tee', sku: 'TEE-1', variantTaxClass: null, productTaxClass: null },
    });
    findByRequestIdMock.mockResolvedValue(undefined);
    resolvePriceMock.mockResolvedValue(1000); // 1000 cents unit
    nextOrderNumberMock.mockResolvedValue('ORD-000001');
    insertOrderMock.mockResolvedValue({ id: 'order-1' } as never);
    insertLineItemMock.mockResolvedValue({ id: 'line-1' } as never);
    reserveMock.mockResolvedValue({ ok: true, reservationId: 'res-1' });

    const result = await createOrder(
      db,
      TG,
      baseCart({ lines: [{ inventoryItemId: 'inv-1', variantId: 'var-1', quantity: 2 }], clientTotal: 999999 }),
    );
    expect(result).toEqual({ ok: true, orderId: 'order-1' });
    expect(isolationLevels).toEqual(['read committed']);

    // Server-computed totals: 2 * 1000 = 2000 net + 19% (380) = 2380. The bogus
    // clientTotal is ignored.
    expect(insertOrderMock).toHaveBeenCalledTimes(1);
    const orderRow = insertOrderMock.mock.calls[0][1];
    expect(orderRow.subtotal).toBe(2000);
    expect(orderRow.taxAmount).toBe(380);
    expect(orderRow.total).toBe(2380);
    expect(nextOrderNumberMock).toHaveBeenCalledWith(trx, TG);

    // One reserve per line, on the same trx (the INNER reserve, not WithRetry),
    // with the tenant group threaded through for the raw guarded UPDATE.
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(reserveMock.mock.calls[0][0]).toBe(trx);
    expect(reserveMock.mock.calls[0][1]).toBe(TG);
    expect(reserveMock.mock.calls[0][2]).toMatchObject({
      inventoryItemId: 'inv-1',
      variantId: 'var-1',
      needed: 2,
      requestId: 'req-1:0',
      refType: 'order_line',
      refId: 'line-1',
    });
  });

  it('idempotency pre-check: a prior order with the request_id short-circuits to ok:true', async () => {
    const { db } = makeFakeDb();
    findByRequestIdMock.mockResolvedValue({ id: 'prior-order' } as never);

    const result = await createOrder(db, TG, baseCart());
    expect(result).toEqual({ ok: true, orderId: 'prior-order' });
    // No price resolution, no insert, no reserve: the prior order wins outright.
    expect(resolvePriceMock).not.toHaveBeenCalled();
    expect(insertOrderMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('a lost order request_id race (23505 on order_request_id_key) re-reads the winner in a FRESH transaction', async () => {
    const { db, isolationLevels, transactionCount } = makeFakeDb();
    findByRequestIdMock
      .mockResolvedValueOnce(undefined) // in-transaction pre-check: not there yet
      .mockResolvedValueOnce({ id: 'winner-order' } as never); // fresh re-read
    resolvePriceMock.mockResolvedValue(1000);
    nextOrderNumberMock.mockResolvedValue('ORD-000002');
    insertOrderMock.mockRejectedValue(makePgUniqueViolation('order_request_id_key'));

    const result = await createOrder(db, TG, baseCart());
    expect(result).toEqual({ ok: true, orderId: 'winner-order' });
    expect(transactionCount()).toBe(2);
    expect(isolationLevels).toEqual(['read committed', 'read committed']);
  });

  it('a lost per-line reservation race (the reserve sentinel) also resolves to the prior order', async () => {
    const { db, transactionCount } = makeFakeDb();
    findByRequestIdMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'winner-order' } as never);
    resolvePriceMock.mockResolvedValue(1000);
    nextOrderNumberMock.mockResolvedValue('ORD-000003');
    insertOrderMock.mockResolvedValue({ id: 'loser-order' } as never);
    insertLineItemMock.mockResolvedValue({ id: 'line-1' } as never);
    const sentinel = new Error('duplicate request_id req-1:0');
    sentinel.name = 'DuplicateRequestError';
    reserveMock.mockRejectedValue(sentinel);

    expect(await createOrder(db, TG, baseCart())).toEqual({ ok: true, orderId: 'winner-order' });
    expect(transactionCount()).toBe(2);
  });

  it('surfaces loudly when the race fired but no prior order exists (never a silent success)', async () => {
    const { db } = makeFakeDb();
    findByRequestIdMock.mockResolvedValue(undefined);
    resolvePriceMock.mockResolvedValue(1000);
    nextOrderNumberMock.mockResolvedValue('ORD-000004');
    insertOrderMock.mockRejectedValue(makePgUniqueViolation('order_request_id_key'));

    await expect(createOrder(db, TG, baseCart())).rejects.toThrow(/no prior order was found/);
  });

  it('an UNRELATED unique violation (order_number_key) propagates unchanged, with no re-read', async () => {
    const { db, transactionCount } = makeFakeDb();
    findByRequestIdMock.mockResolvedValue(undefined);
    resolvePriceMock.mockResolvedValue(1000);
    nextOrderNumberMock.mockResolvedValue('ORD-000005');
    const violation = makePgUniqueViolation('order_number_key');
    insertOrderMock.mockRejectedValue(violation);

    await expect(createOrder(db, TG, baseCart())).rejects.toBe(violation);
    expect(transactionCount()).toBe(1);
  });

  it('validateCart runs BEFORE any transaction: a B2C reverse-charge cart never opens one', async () => {
    const { db, transactionCount } = makeFakeDb();
    await expect(
      createOrder(db, TG, baseCart({ reverseCharge: true, customerType: 'b2c', vatId: 'DE1' })),
    ).rejects.toThrow(/reverseCharge requires customerType "b2b"/);
    expect(transactionCount()).toBe(0);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
