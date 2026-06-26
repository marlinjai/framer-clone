// @vitest-environment node
//
// Headless UNIT tests for POST /api/commerce/orders. The Prisma singleton, the
// withTenant seam, createOrder (Track B), and the host -> published-site resolver
// (resolvePublishedSite) are all mocked, so NO database is touched. These prove
// the route:
//   - gates on the request HOST resolving to a published site (an unresolvable
//     host is a 403, never served — the anonymous-storefront D4 contract),
//   - threads a CLIENT-sent idempotency key into the order request_id (so a
//     re-submit dedupes to the same order), and generates a server key otherwise,
//   - keeps the body INTENTIONS-ONLY (a client-sent price/stock is a 400),
//   - bounds the idempotency key (a too-short value is a 400),
//   - surfaces faults as error envelopes, never a swallowed empty 200.
//
// The Dockerized `.itest.ts` suite proves the same route against live Postgres;
// this file is what makes the headless `pnpm test` gate cover the route.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const fakeTx = {
  productVariant: { findFirst: vi.fn() },
  inventoryItem: { findFirst: vi.fn() },
  order: { findUnique: vi.fn() },
};

vi.mock('@/server/db', () => ({
  getPrismaClient: vi.fn(() => ({}) as never),
}));

vi.mock('@/server/commerce', () => ({
  withTenant: vi.fn((_prisma: unknown, a: unknown, b: unknown) => {
    const fn = (typeof a === 'function' ? a : b) as (tx: typeof fakeTx) => Promise<unknown>;
    return fn(fakeTx);
  }),
}));

vi.mock('@/server/commerce/order/createOrder', () => ({
  createOrder: vi.fn(),
}));

vi.mock('@/server/sites/publicResolver', () => ({
  resolvePublishedSite: vi.fn(),
}));

import { createOrder } from '@/server/commerce/order/createOrder';
import { resolvePublishedSite } from '@/server/sites/publicResolver';
import { POST } from '../route';

const createOrderMock = vi.mocked(createOrder);
const resolveSiteMock = vi.mocked(resolvePublishedSite);

function postReq(body: unknown): Request {
  return new Request('http://t/api/commerce/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  fakeTx.productVariant.findFirst.mockReset();
  fakeTx.inventoryItem.findFirst.mockReset();
  fakeTx.order.findUnique.mockReset();
  createOrderMock.mockReset();
  resolveSiteMock.mockReset();
  // Default: the request host resolves to a published storefront site.
  resolveSiteMock.mockResolvedValue({
    siteId: 'site_a',
    workspaceId: 'ws_a',
  } as unknown as Awaited<ReturnType<typeof resolvePublishedSite>>);

  // Default happy wiring: variant -> inventory item resolves, the order commits,
  // and the read-back returns the server total.
  fakeTx.productVariant.findFirst.mockResolvedValue({ id: 'var_a', sku: 'SKU-A' });
  fakeTx.inventoryItem.findFirst.mockResolvedValue({ id: 'inv_a' });
  fakeTx.order.findUnique.mockResolvedValue({ total: 4760, currencyCode: 'EUR' });
  createOrderMock.mockResolvedValue({ ok: true, orderId: 'order_created' });
});

describe('POST /api/commerce/orders idempotency key', () => {
  it('threads a client-sent idempotency key into the order request_id', async () => {
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }], idempotencyKey: 'order_abc12345' }));
    expect(res.status).toBe(201);
    expect(createOrderMock).toHaveBeenCalledTimes(1);
    const cart = createOrderMock.mock.calls[0][1];
    expect(cart.requestId).toBe('order_abc12345');
  });

  it('generates a server-owned request_id when no key is sent (prior behavior)', async () => {
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(201);
    const cart = createOrderMock.mock.calls[0][1];
    expect(cart.requestId).toMatch(/^order_/);
    expect(cart.requestId).not.toBe('order_abc12345');
  });

  it('rejects a too-short idempotency key as a 400 (never trusted as a request_id)', async () => {
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }], idempotencyKey: 'short' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(createOrderMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/commerce/orders body contract', () => {
  it('rejects a client-sent price (intentions only) as a 400', async () => {
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1, price: 999 }] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the host does not resolve to a published site', async () => {
    resolveSiteMock.mockResolvedValue(null);
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('maps a shortage to a 409 with variant-keyed shortages', async () => {
    createOrderMock.mockResolvedValue({
      ok: false,
      shortages: [{ inventoryItemId: 'inv_a', locationId: 'loc_a', needed: 5, available: 1 }],
    });
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 5 }] }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.shortages[0]).toEqual({ variantId: 'var_a', needed: 5, available: 1 });
  });
});
