// @vitest-environment node
//
// Headless UNIT tests for POST /api/commerce/orders. The host -> published-site
// resolver (resolvePublishedSite), the scoped commerce handle factory, the
// Kysely storefront reads and createOrder are all mocked, so NO database
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
  isCommerceTenantNotProvisioned: (err: unknown) =>
    (err as { code?: string } | null)?.code === 'COMMERCE_TENANT_NOT_PROVISIONED',
}));

vi.mock('@/server/commerce/repository/storefront', async (importOriginal) => ({
  // Keep the real UnknownVariantError class (the route branches on it).
  ...(await importOriginal<typeof import('@/server/commerce/repository/storefront')>()),
  resolveOrderLines: vi.fn(),
  readOrderTotal: vi.fn(),
}));

vi.mock('@/server/commerce/payment/shopTax', () => ({
  shopTaxProfile: vi.fn(async () => ({ kleinunternehmer: false, booksReady: true })),
}));
vi.mock('@/server/commerce/order/createOrder', () => ({
  createOrder: vi.fn(),
}));

import { createOrder } from '@/server/commerce/order/createOrder';
import { commerceTenantDbChecked } from '@/server/commerce/db';
import {
  readOrderTotal,
  resolveOrderLines,
  UnknownVariantError,
} from '@/server/commerce/repository/storefront';
import { resolvePublishedSite } from '@/server/sites/publicResolver';
import { POST } from '../route';

const createOrderMock = vi.mocked(createOrder);
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

/** The company the storefront site belongs to (sites.company_id, 020_catalogue_company). */
const COMPANY_A = '018f9c10-0000-7000-8000-0000000000a1';

function site(tenantGroupId: unknown) {
  return {
    siteId: 'site_a',
    workspaceId: 'ws_a',
    tenantGroupId,
    companyId: COMPANY_A,
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
  resolveLinesMock.mockImplementation(async (_db, _view, lines) =>
    lines.map((line) => ({ ...line, inventoryItemId: 'inv_a', priceBasis: 'gross' as const })),
  );
  readTotalMock.mockResolvedValue({ totalCents: 4760, currency: 'EUR', orderNumber: 'ORD-000007' });
  createOrderMock.mockResolvedValue({ ok: true, orderId: 'order_created' });
});

describe('POST /api/commerce/orders tenancy (D4: tenant from the HOST)', () => {
  it("threads the scoped handle for the host's tenant group into reads AND the write", async () => {
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 2 }] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      orderId: 'order_created',
      orderNumber: 'ORD-000007',
      totalCents: 4760,
      currency: 'EUR',
      // Stripe is not configured in tests: the demo provider takes the payment.
      provider: 'demo',
    });

    expect(resolveSiteMock).toHaveBeenCalledWith('store-a.example.com');
    expect(tenantDbMock).toHaveBeenCalledTimes(1);
    expect(tenantDbMock).toHaveBeenCalledWith(TG_A);
    expect(resolveLinesMock).toHaveBeenCalledWith(SCOPED_A, { companyId: COMPANY_A, siteId: 'site_a' }, [
      { variantId: 'var_a', quantity: 2 },
    ]);
    expect(createOrderMock).toHaveBeenCalledWith(
      SCOPED_A,
      TG_A,
      expect.objectContaining({ tenantId: COMPANY_A, siteId: 'site_a' }),
    );
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

  it('answers an unknown (or other-shop) variant with a typed 422 unknown_variant, never a 409 or 500', async () => {
    resolveLinesMock.mockRejectedValue(new UnknownVariantError('var_x'));
    const res = await POST(postReq({ lines: [{ variantId: 'var_x', quantity: 1 }] }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: { code: 'unknown_variant', message: 'an item in the cart is not available', variantId: 'var_x' },
    });
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('keeps a real catalog misconfiguration (no SKU) a 500, with a GENERIC message and the detail only in the log', async () => {
    resolveLinesMock.mockRejectedValue(new Error('variant var_a has no sku; cannot resolve inventory'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('commerce_order_failed');
    expect(text).not.toContain('no sku');
    expect(text).not.toContain('var_a');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  it('never leaks a backstop / connection failure message to the anonymous buyer', async () => {
    const secretish =
      'Commerce backstop: could not verify the commerce connection (COMMERCE_APP_DATABASE_URL must point at the low-privilege commerce_app role, search_path = ext): getaddrinfo ENOTFOUND db.internal.example';
    tenantDbMock.mockRejectedValueOnce(new Error(secretish));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('commerce_order_failed');
    for (const fragment of ['COMMERCE_APP_DATABASE_URL', 'commerce_app', 'search_path', 'ENOTFOUND', 'db.internal']) {
      expect(text).not.toContain(fragment);
    }
    // The full error IS logged server-side.
    expect(errorSpy.mock.calls.flat().some((a) => a instanceof Error && a.message === secretish)).toBe(true);
    errorSpy.mockRestore();
  });

  it('surfaces an order that vanished on read-back as a 500, never a false 201', async () => {
    readTotalMock.mockResolvedValue(null);
    const res = await POST(postReq({ lines: [{ variantId: 'var_a', quantity: 1 }] }));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_order_failed');
  });
});
