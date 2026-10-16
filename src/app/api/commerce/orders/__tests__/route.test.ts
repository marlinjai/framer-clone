// @vitest-environment node
//
// Headless UNIT tests for POST /api/commerce/orders. The host -> published-site
// resolver (resolvePublishedSite), the scoped commerce handle factory, the
// Kysely storefront reads and createOrderKysely are all mocked, so NO database
// is touched. The REAL tenancy edge (storefrontTenant.ts + tenant.ts) runs.
// These prove the route:
//   - gates on the request HOST resolving to a published site (an unresolvable
//     host is a 403, never served: the anonymous-storefront D4 contract),
//   - takes the tenant from that site (never a session) and threads the scoped
//     handle for ITS tenant group into every read and the order write,
//   - FAILS CLOSED: a published site with no valid tenant group id is a 404
//     `commerce_not_provisioned` and nothing is read or written (never a
//     shared-schema fallback, never a 409 the checkout would read as shortage),
//   - threads a CLIENT-sent idempotency key into the order request_id (so a
//     re-submit dedupes to the same order), and generates a server key otherwise,
//   - keeps the body INTENTIONS-ONLY (a client-sent price/stock/total is a 400),
//   - bounds the idempotency key (a too-short value is a 400),
//   - surfaces faults as error envelopes, never a swallowed empty 200.
//
// The Dockerized `.itest.ts` suites prove the same route against live Postgres
// (route.itest.ts) and across two tenant groups (routes.isolation.itest.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/sites/publicResolver', () => ({
  resolvePublishedSite: vi.fn(),
}));

vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: vi.fn(async (tgId: string) => ({ __scopedHandleFor: tgId })),
}));

vi.mock('@/server/commerce/repository/storefront', () => ({
  resolveOrderLines: vi.fn(),
  readOrderTotal: vi.fn(),
}));

vi.mock('@/server/commerce/order/createOrder', () => ({
  createOrderKysely: vi.fn(),
}));

import { createOrderKysely } from '@/server/commerce/order/createOrder';
import { commerceTenantDbChecked } from '@/server/commerce/db';
import { readOrderTotal, resolveOrderLines } from '@/server/commerce/repository/storefront';
import { resolvePublishedSite } from '@/server/sites/publicResolver';
import { POST } from '../route';

const createOrderMock = vi.mocked(createOrderKysely);
const resolveSiteMock = vi.mocked(resolvePublishedSite);
const tenantDbMock = vi.mocked(commerceTenantDbChecked);
const resolveLinesMock = vi.mocked(resolveOrderLines);
const readTotalMock = vi.mocked(readOrderTotal);

const TG_A = '018f9c10-0000-7000-8000-0000000013aa';
const SCOPED_A = { __scopedHandleFor: TG_A };

function postReq(body: unknown, host = 'store-a.example.com'): Request {
  return new Request('http://t/api/commerce/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify(body),
  });
}

function site(tenantGroupId: unknown) {
  return {
    siteId: 'site_a',
    workspaceId: 'ws_a',
    tenantGroupId,
  } as unknown as Awaited<ReturnType<typeof resolvePublishedSite>>;
}

beforeEach(() => {
  createOrderMock.mockReset();
  resolveSiteMock.mockReset();
  tenantDbMock.mockClear();
  resolveLinesMock.mockReset();
  readTotalMock.mockReset();
  // Default: the request host resolves to a published storefront site with a
  // valid tenant group.
  resolveSiteMock.mockResolvedValue(site(TG_A));

  // Default happy wiring: variant -> inventory item resolves, the order commits,
  // and the read-back returns the server total.
  resolveLinesMock.mockImplementation(async (_db, lines) =>
    lines.map((line) => ({ ...line, inventoryItemId: 'inv_a' })),
  );
  readTotalMock.mockResolvedValue({ totalCents: 4760, currency: 'EUR' });
  createOrderMock.mockResolvedValue({ ok: true, orderId: 'order_created' });
});

describe('POST /api/commerce/orders tenancy (D4: tenant from the HOST)', () => {
  it("threads the scoped handle for the host's tenant group into reads AND the write", async () => {
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 2 }] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      orderId: 'order_created',
      totalCents: 4760,
      currency: 'EUR',
    });

    expect(resolveSiteMock).toHaveBeenCalledWith('store-a.example.com');
    expect(tenantDbMock).toHaveBeenCalledTimes(1);
    expect(tenantDbMock).toHaveBeenCalledWith(TG_A);
    expect(resolveLinesMock).toHaveBeenCalledWith(SCOPED_A, [{ variantId: 'var_a', quantity: 2 }]);
    expect(createOrderMock).toHaveBeenCalledWith(SCOPED_A, TG_A, expect.any(Object));
    expect(readTotalMock).toHaveBeenCalledWith(SCOPED_A, 'order_created');
  });

  it('returns 403 when the host does not resolve to a published site', async () => {
    resolveSiteMock.mockResolvedValue(null);
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(tenantDbMock).not.toHaveBeenCalled();
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['a legacy non-UUID sentinel', 'test-tg'],
  ])(
    'FAILS CLOSED with 404 commerce_not_provisioned when the site tenant group is %s',
    async (_label, tenantGroupId) => {
      resolveSiteMock.mockResolvedValue(site(tenantGroupId));
      const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('commerce_not_provisioned');
      // Nothing read, nothing written, in ANY schema.
      expect(tenantDbMock).not.toHaveBeenCalled();
      expect(resolveLinesMock).not.toHaveBeenCalled();
      expect(createOrderMock).not.toHaveBeenCalled();
    },
  );

  it('surfaces a resolver failure (database down) as a 500 envelope, not a crash', async () => {
    resolveSiteMock.mockRejectedValue(new Error('db down'));
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_order_failed');
    expect(createOrderMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/commerce/orders idempotency key', () => {
  it('threads a client-sent idempotency key into the order request_id', async () => {
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }], idempotencyKey: 'order_abc12345' }));
    expect(res.status).toBe(201);
    expect(createOrderMock).toHaveBeenCalledTimes(1);
    const cart = createOrderMock.mock.calls[0][2];
    expect(cart.requestId).toBe('order_abc12345');
  });

  it('generates a server-owned request_id when no key is sent (prior behavior)', async () => {
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(201);
    const cart = createOrderMock.mock.calls[0][2];
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
  it.each([
    ['a line price', { lines: [{ variantId: 'var_a', quantity: 1, price: 999 }] }],
    ['a line stock', { lines: [{ variantId: 'var_a', quantity: 1, stock: 50 }] }],
    ['an order total', { lines: [{ variantId: 'var_a', quantity: 1 }], total: 1 }],
  ])('rejects a client-sent %s (intentions only, .strict()) as a 400', async (_label, body) => {
    const res = await POST(postReq(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_body');
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

  it('surfaces an unresolvable variant (catalog misconfiguration) as a loud 500', async () => {
    resolveLinesMock.mockRejectedValue(new Error('unknown variant var_x'));
    const res = await POST(postReq({ lines: [{ variantId: 'var_x', quantity: 1 }] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_order_failed');
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('surfaces an order that vanished on read-back as a 500, never a false 201', async () => {
    readTotalMock.mockResolvedValue(null);
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_order_failed');
  });
});
