// @vitest-environment node
//
// src/app/api/commerce/__tests__/routes.test.ts
//
// Headless UNIT tests for the three thin /api/commerce GET route handlers. The
// Prisma singleton, the `withTenant` seam, and the b5 pricing repo are all mocked,
// so NO database is touched: we assert the routes run the typed graph -> DTO
// projection (NOT a flat CMS Row), resolve `resolvedPriceCents` via b5, carry the
// advisory-only marker on availability, page with a nextCursor, and SURFACE every
// failure as a real error envelope (400 bad input, 404 not-found, 5xx on throw),
// never a swallowed empty 200.
//
// These run under `pnpm test`; the Dockerized `.itest.ts` suite (which proves the
// reads against live Postgres + the b2 generated column) is EXCLUDED from this gate
// by its suffix, so this file is what makes the gate prove the route behavior.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the server collaborators BEFORE importing the route modules (vi.mock is
// hoisted). getPrismaClient returns an inert object (withTenant is mocked too, so
// the client is never really used); withTenant invokes its callback with a fake tx
// the test wires per-scenario; pricingRepository.resolvePrice is a vi.fn().
const fakeTx = {
  product: { findMany: vi.fn(), findFirst: vi.fn() },
  $queryRaw: vi.fn(),
};

vi.mock('@/server/db', () => ({
  getPrismaClient: vi.fn(() => ({}) as never),
}));

vi.mock('@/server/commerce', () => ({
  COMMERCE_SCHEMA: 'commerce',
  // Mirror the real two-overload signature: withTenant(prisma, fn) or
  // withTenant(prisma, schema, fn). Either way, call the callback with the fake tx.
  withTenant: vi.fn((_prisma: unknown, a: unknown, b: unknown) => {
    const fn = (typeof a === 'function' ? a : b) as (tx: typeof fakeTx) => Promise<unknown>;
    return fn(fakeTx);
  }),
}));

vi.mock('@/server/commerce/repository/pricing', () => ({
  pricingRepository: { resolvePrice: vi.fn() },
}));

import { pricingRepository } from '@/server/commerce/repository/pricing';
import { GET as productsGET } from '../products/route';
import { GET as productGET } from '../products/[handle]/route';
import { GET as inventoryGET } from '../inventory/route';

const resolvePriceMock = vi.mocked(pricingRepository.resolvePrice);

// A product graph row in the shape Prisma returns with productGraphInclude.
function graphRow(over: Partial<{ id: string; handle: string; variants: unknown[] }> = {}) {
  return {
    id: over.id ?? 'prod-1',
    handle: over.handle ?? 'tee',
    title: 'Tee',
    description: 'A nice tee',
    options: [{ id: 'opt-color', title: 'Color', values: [{ id: 'val-red', value: 'Red' }] }],
    variants: over.variants ?? [
      { id: 'var-1', title: 'Red', sku: 'TEE-RED', barcode: null, options: [{ optionId: 'opt-color', optionValueId: 'val-red' }] },
    ],
  };
}

beforeEach(() => {
  fakeTx.product.findMany.mockReset();
  fakeTx.product.findFirst.mockReset();
  fakeTx.$queryRaw.mockReset();
  resolvePriceMock.mockReset();
});

describe('GET /api/commerce/products (list)', () => {
  it('returns the typed commerce graph with resolvedPriceCents (NOT a flat CMS Row)', async () => {
    fakeTx.product.findMany.mockResolvedValue([graphRow()]);
    resolvePriceMock.mockResolvedValue(1999);

    const res = await productsGET(new Request('http://t/api/commerce/products'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.nextCursor).toBeUndefined();
    expect(body.products).toHaveLength(1);
    const product = body.products[0];
    // Typed graph: nested options/values + variant matrix + integer-cents price.
    expect(product.options[0].values[0]).toEqual({ id: 'val-red', value: 'Red' });
    expect(product.variants[0].resolvedPriceCents).toBe(1999);
    expect(product.variants[0].options[0]).toEqual({ optionId: 'opt-color', optionValueId: 'val-red' });
    expect(product.resolvedPriceCents).toBe(1999);
    // It is emphatically not the flat CMS Row shape.
    expect(product).not.toHaveProperty('values.title');
    // The b5 resolver was consulted per variant with the (defaulted) currency.
    expect(resolvePriceMock).toHaveBeenCalledWith(fakeTx, 'var-1', { currency: 'EUR' });
  });

  it('honors ?currency= when resolving prices', async () => {
    fakeTx.product.findMany.mockResolvedValue([graphRow()]);
    resolvePriceMock.mockResolvedValue(1500);
    await productsGET(new Request('http://t/api/commerce/products?currency=usd'));
    expect(resolvePriceMock).toHaveBeenCalledWith(fakeTx, 'var-1', { currency: 'USD' });
  });

  it('sets nextCursor when another page exists (take limit+1)', async () => {
    // limit=1 -> the route takes 2 rows; the extra row signals a next page and its
    // predecessor's id becomes the cursor.
    fakeTx.product.findMany.mockResolvedValue([graphRow({ id: 'prod-1' }), graphRow({ id: 'prod-2' })]);
    resolvePriceMock.mockResolvedValue(1000);

    const res = await productsGET(new Request('http://t/api/commerce/products?limit=1'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.products).toHaveLength(1);
    expect(body.products[0].id).toBe('prod-1');
    expect(body.nextCursor).toBe('prod-1');
  });

  it('returns a 400 bad_request envelope on a malformed limit (never silently clamped)', async () => {
    const res = await productsGET(new Request('http://t/api/commerce/products?limit=abc'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
    expect(fakeTx.product.findMany).not.toHaveBeenCalled();
  });

  it('surfaces a read failure as a 500 commerce_read_failed envelope (never an empty 200)', async () => {
    fakeTx.product.findMany.mockRejectedValue(new Error('db down'));
    const res = await productsGET(new Request('http://t/api/commerce/products'));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_read_failed');
  });
});

describe('GET /api/commerce/products/[handle] (detail)', () => {
  it('resolves a product by handle as 200 ProductDTO', async () => {
    fakeTx.product.findFirst.mockResolvedValue(graphRow({ handle: 'tee' }));
    resolvePriceMock.mockResolvedValue(1999);

    const res = await productGET(new Request('http://t/api/commerce/products/tee'), {
      params: Promise.resolve({ handle: 'tee' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handle).toBe('tee');
    expect(body.variants[0].resolvedPriceCents).toBe(1999);
    // The lookup filtered to LIVE rows by handle.
    expect(fakeTx.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { handle: 'tee', deletedAt: null } }),
    );
  });

  it('returns a 404 not_found envelope when the handle resolves to no live product', async () => {
    fakeTx.product.findFirst.mockResolvedValue(null);
    const res = await productGET(new Request('http://t/api/commerce/products/ghost'), {
      params: Promise.resolve({ handle: 'ghost' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('surfaces a read failure as a 500 commerce_read_failed envelope', async () => {
    fakeTx.product.findFirst.mockRejectedValue(new Error('boom'));
    const res = await productGET(new Request('http://t/api/commerce/products/tee'), {
      params: Promise.resolve({ handle: 'tee' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_read_failed');
  });
});

describe('GET /api/commerce/inventory (advisory availability)', () => {
  it('returns the advisory-only availability matching the generated column', async () => {
    fakeTx.$queryRaw.mockResolvedValue([{ available_quantity: 7 }]);
    const res = await inventoryGET(
      new Request('http://t/api/commerce/inventory?variantId=var-1&locationId=loc-1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      variantId: 'var-1',
      locationId: 'loc-1',
      availableQuantity: 7,
      advisoryOnly: true,
    });
    // The advisory-only marker is present and true (no client may treat it as a sale guarantee).
    expect(body.advisoryOnly).toBe(true);
  });

  it('returns a 400 bad_request envelope when a query param is missing', async () => {
    const res = await inventoryGET(new Request('http://t/api/commerce/inventory?variantId=var-1'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
    expect(fakeTx.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns a 404 not_found envelope for an (item, location) pair with no level row', async () => {
    fakeTx.$queryRaw.mockResolvedValue([]);
    const res = await inventoryGET(
      new Request('http://t/api/commerce/inventory?variantId=var-x&locationId=loc-1'),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('surfaces a read failure as a 500 commerce_read_failed envelope', async () => {
    fakeTx.$queryRaw.mockRejectedValue(new Error('select failed'));
    const res = await inventoryGET(
      new Request('http://t/api/commerce/inventory?variantId=var-1&locationId=loc-1'),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_read_failed');
  });
});
