// src/server/commerce/order/__tests__/createOrder.test.ts
//
// Headless UNIT tests for the b6 createOrder control flow. These run in the node
// project of the standard `pnpm test` gate (no Docker, no live Postgres): the
// transaction client is a programmable fake feeding canned resolvePrice / variant
// rows, and the inner b3 reserve is stubbed, so what is exercised here is the
// CONTROL FLOW around the order WRITE, not Postgres semantics:
//   - computeLineTax across net, gross-extraction, reduced 7%, and zero,
//   - the explicit-rate / treatment consistency fix (an explicit rate derives its
//     treatment from the RESOLVED rate, not from taxClass alone),
//   - resolveLineRate's class -> default-rate mapping + the explicit override and
//     the basis-points ceiling rejection,
//   - the OrderShortageError -> { ok:false, shortages } translation,
//   - the 'no price resolved' loud throw,
//   - validateCart's guards (empty lines, missing requestId, quantity <= 0, and the
//     new reverse-charge B2C precondition),
//   - both duplicate-detector predicates fed synthetic P2002 / name-tagged errors,
//   - the idempotency pre-check return + the happy-path order assembly.
//
// The REAL atomic rollback, the snapshot stability, the FK RESTRICT, the role
// REVOKE, the live money-math, and the order-level idempotency race are proven
// against Dockerized Postgres in createOrder.itest.ts (kept out of this gate by the
// `.itest.ts` suffix). This file puts the b6 control flow into the CI gate, which
// the integration-only suite could not (it is Docker-gated).

import { Prisma } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The three module seams createOrder composes. We mock them so the fake tx never
// needs a real repository or a real reserve: each test wires the canned behaviour.
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

const reserveMock = vi.mocked(reserve);
const resolvePriceMock = vi.mocked(pricingRepository.resolvePrice);
const findByRequestIdMock = vi.mocked(orderRepository.findByRequestId);
const nextOrderNumberMock = vi.mocked(orderRepository.nextOrderNumber);
const insertOrderMock = vi.mocked(orderRepository.insertOrder);
const insertLineItemMock = vi.mocked(orderRepository.insertLineItem);

afterEach(() => {
  vi.clearAllMocks();
});

/** Build a Prisma P2002 unique-violation error targeting the given constraint. */
function makeP2002(target: string | string[]): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

/**
 * A fake PrismaClient whose $transaction simply runs the callback with a fake tx.
 * The tx implements only the members createOrder touches directly:
 *   - $executeRawUnsafe (the SET LOCAL search_path),
 *   - productVariant.findUnique (the snapshot read).
 * The repository + reserve seams are mocked at module level, so the tx does not
 * need to back them. canned.variant is what every variant lookup returns.
 */
function makeFakePrisma(canned: { variant?: unknown } = {}): {
  prisma: import('@prisma/client').PrismaClient;
  tx: Record<string, unknown>;
} {
  const tx = {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    productVariant: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          'variant' in canned
            ? canned.variant
            : { title: 'V', sku: 'SKU', taxClass: null, product: { taxClass: null } },
        ),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as import('@prisma/client').PrismaClient;
  return { prisma, tx };
}

/** A minimal valid one-line cart; tests override fields as needed. */
function baseCart(over: Partial<Cart> = {}): Cart {
  return {
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

  it('isOrderRequestIdConflict matches a P2002 on request_id (string + array target), not others', () => {
    expect(isOrderRequestIdConflict(makeP2002('order_request_id_key'))).toBe(true);
    expect(isOrderRequestIdConflict(makeP2002(['request_id']))).toBe(true);
    expect(isOrderRequestIdConflict(makeP2002(['requestId']))).toBe(true);
    expect(isOrderRequestIdConflict(makeP2002('order_number_key'))).toBe(false);
    expect(isOrderRequestIdConflict(makeP2002(['some_other_col']))).toBe(false);
    expect(isOrderRequestIdConflict(new Error('plain'))).toBe(false);
  });
});

// ===========================================================================
describe('createOrder control flow', () => {
  it("throws loudly when no price resolves for a line (never a silent shortage)", async () => {
    const { prisma } = makeFakePrisma();
    findByRequestIdMock.mockResolvedValue(null);
    resolvePriceMock.mockResolvedValue(null); // no applicable price

    await expect(createOrder(prisma, baseCart())).rejects.toThrow(/no price resolved/);
  });

  it('translates an OrderShortageError into { ok:false, shortages }', async () => {
    const { prisma } = makeFakePrisma();
    findByRequestIdMock.mockResolvedValue(null);
    resolvePriceMock.mockResolvedValue(1000);
    nextOrderNumberMock.mockResolvedValue('ORD-000001');
    insertOrderMock.mockResolvedValue({ id: 'order-1' } as never);
    insertLineItemMock.mockResolvedValue({ id: 'line-1' } as never);
    // The inner reserve short-stocks: createOrder must throw OrderShortageError
    // inside the tx, which the outer catch translates to the explicit contract.
    const shortages = [{ inventoryItemId: 'inv-1', locationId: 'loc-1', needed: 5, available: 1 }];
    reserveMock.mockResolvedValue({ ok: false, shortages });

    const result = await createOrder(prisma, baseCart({ lines: [{ inventoryItemId: 'inv-1', variantId: 'var-1', quantity: 5 }] }));
    expect(result).toEqual({ ok: false, shortages });
  });

  it('happy path: assembles the order with server-computed totals and one reserve per line', async () => {
    const { prisma, tx } = makeFakePrisma({
      variant: { title: 'Tee', sku: 'TEE-1', taxClass: null, product: { taxClass: null } },
    });
    findByRequestIdMock.mockResolvedValue(null);
    resolvePriceMock.mockResolvedValue(1000); // 1000 cents unit
    nextOrderNumberMock.mockResolvedValue('ORD-000001');
    insertOrderMock.mockResolvedValue({ id: 'order-1' } as never);
    insertLineItemMock.mockResolvedValue({ id: 'line-1' } as never);
    reserveMock.mockResolvedValue({ ok: true, reservationId: 'res-1' });

    const result = await createOrder(
      prisma,
      baseCart({ lines: [{ inventoryItemId: 'inv-1', variantId: 'var-1', quantity: 2 }], clientTotal: 999999 }),
    );
    expect(result).toEqual({ ok: true, orderId: 'order-1' });

    // Server-computed totals: 2 * 1000 = 2000 net + 19% (380) = 2380. The bogus
    // clientTotal is ignored.
    expect(insertOrderMock).toHaveBeenCalledTimes(1);
    const orderRow = insertOrderMock.mock.calls[0][1];
    expect(orderRow.subtotal).toBe(2000);
    expect(orderRow.taxAmount).toBe(380);
    expect(orderRow.total).toBe(2380);

    // One reserve per line, on the same tx (the INNER reserve, not WithRetry).
    expect(reserveMock).toHaveBeenCalledTimes(1);
    expect(reserveMock.mock.calls[0][0]).toBe(tx);
    expect(reserveMock.mock.calls[0][1]).toMatchObject({
      inventoryItemId: 'inv-1',
      needed: 2,
      requestId: 'req-1:0',
    });
  });

  it('idempotency pre-check: a prior order with the request_id short-circuits to ok:true', async () => {
    const { prisma } = makeFakePrisma();
    findByRequestIdMock.mockResolvedValue({ id: 'prior-order' } as never);

    const result = await createOrder(prisma, baseCart());
    expect(result).toEqual({ ok: true, orderId: 'prior-order' });
    // No price resolution, no insert, no reserve: the prior order wins outright.
    expect(resolvePriceMock).not.toHaveBeenCalled();
    expect(insertOrderMock).not.toHaveBeenCalled();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it('validateCart runs BEFORE any transaction: a B2C reverse-charge cart never opens a tx', async () => {
    const { prisma } = makeFakePrisma();
    await expect(
      createOrder(prisma, baseCart({ reverseCharge: true, customerType: 'b2c', vatId: 'DE1' })),
    ).rejects.toThrow(/reverseCharge requires customerType "b2b"/);
    expect((prisma.$transaction as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
