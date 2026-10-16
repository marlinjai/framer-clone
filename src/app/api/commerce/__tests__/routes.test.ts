// @vitest-environment node
//
// src/app/api/commerce/__tests__/routes.test.ts
//
// Headless UNIT tests for the three thin /api/commerce GET route handlers. The
// host -> published-site resolver, the scoped commerce handle factory and the
// Kysely storefront reads are all mocked, so NO database is touched. The REAL
// tenancy edge (src/server/commerce/storefrontTenant.ts + tenant.ts) runs, so
// these assert, per route:
//   - the tenant comes from the request HOST: an unpublished host is a 403 and
//     the scoped handle is derived for the resolved site's OWN tenant group,
//   - FAIL CLOSED: a published site with no valid tenant group id is a 404
//     `commerce_not_provisioned` and NO read runs (no shared-schema fallback),
//   - the typed DTO is returned and validated, every failure surfaces as a real
//     error envelope (400 bad input, 404 not-found, 500 on throw), never a
//     swallowed empty 200.
//
// The DTO projection is covered by dto.test.ts; the SQL against live Postgres
// (and the two-tenant isolation) by routes.itest.ts and
// routes.isolation.itest.ts, which run under `pnpm test:integration`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/sites/publicResolver', () => ({
  resolvePublishedSite: vi.fn(),
}));

vi.mock('@/server/commerce/db', () => ({
  commerceTenantDbChecked: vi.fn(async (tgId: string) => ({ __scopedHandleFor: tgId })),
}));

vi.mock('@/server/commerce/repository/storefront', () => ({
  listStorefrontProducts: vi.fn(),
  getStorefrontProductByHandle: vi.fn(),
  readInventoryAvailable: vi.fn(),
}));

import { resolvePublishedSite } from '@/server/sites/publicResolver';
import { commerceTenantDbChecked } from '@/server/commerce/db';
import {
  getStorefrontProductByHandle,
  listStorefrontProducts,
  readInventoryAvailable,
} from '@/server/commerce/repository/storefront';
import type { ProductDTO } from '@/lib/commerce/dto';
import { GET as productsGET } from '../products/route';
import { GET as productGET } from '../products/[handle]/route';
import { GET as inventoryGET } from '../inventory/route';

const resolveSiteMock = vi.mocked(resolvePublishedSite);
const tenantDbMock = vi.mocked(commerceTenantDbChecked);
const listMock = vi.mocked(listStorefrontProducts);
const byHandleMock = vi.mocked(getStorefrontProductByHandle);
const availableMock = vi.mocked(readInventoryAvailable);

const TG_A = '018f9c10-0000-7000-8000-0000000012aa';
const HOST_A = 'store-a.example.com';
const SCOPED_A = { __scopedHandleFor: TG_A };

function site(tenantGroupId: unknown) {
  return {
    siteId: 'site_a',
    workspaceId: 'ws_a',
    tenantGroupId,
    pages: [],
  } as unknown as Awaited<ReturnType<typeof resolvePublishedSite>>;
}

function req(path: string, host: string | null = HOST_A): Request {
  return new Request(`http://t${path}`, host ? { headers: { host } } : undefined);
}

function productDTO(over: Partial<ProductDTO> = {}): ProductDTO {
  return {
    id: 'prod-1',
    handle: 'tee',
    title: 'Tee',
    description: 'A nice tee',
    options: [{ id: 'opt-color', title: 'Color', values: [{ id: 'val-red', value: 'Red' }] }],
    variants: [
      {
        id: 'var-1',
        title: 'Red',
        sku: 'TEE-RED',
        barcode: null,
        resolvedPriceCents: 1999,
        options: [{ optionId: 'opt-color', optionValueId: 'val-red' }],
      },
    ],
    resolvedPriceCents: 1999,
    ...over,
  };
}

beforeEach(() => {
  resolveSiteMock.mockReset();
  tenantDbMock.mockClear();
  listMock.mockReset();
  byHandleMock.mockReset();
  availableMock.mockReset();
  // Default: the request host resolves to a published site with a valid group.
  resolveSiteMock.mockResolvedValue(site(TG_A));
});

/** The three routes driven through one table for the shared tenancy contract. */
const ROUTES: Array<{ name: string; call: (host: string | null) => Promise<Response> }> = [
  { name: 'products (list)', call: (host) => productsGET(req('/api/commerce/products', host)) },
  {
    name: 'products/[handle] (detail)',
    call: (host) =>
      productGET(req('/api/commerce/products/tee', host), {
        params: Promise.resolve({ handle: 'tee' }),
      }),
  },
  {
    name: 'inventory',
    call: (host) =>
      inventoryGET(req('/api/commerce/inventory?variantId=var-1&locationId=loc-1', host)),
  },
];

describe.each(ROUTES)('GET /api/commerce/$name tenancy edge', ({ call }) => {
  it('403s a host that does not resolve to a published site, and reads nothing', async () => {
    resolveSiteMock.mockResolvedValue(null);
    const res = await call('unknown.example.com');
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
    expect(tenantDbMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
    expect(byHandleMock).not.toHaveBeenCalled();
    expect(availableMock).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['a legacy non-UUID sentinel', 'demo-tenant-group'],
  ])(
    'FAILS CLOSED (404 commerce_not_provisioned, no read) when the site tenant group is %s',
    async (_label, tenantGroupId) => {
      resolveSiteMock.mockResolvedValue(site(tenantGroupId));
      const res = await call(HOST_A);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('commerce_not_provisioned');
      expect(tenantDbMock).not.toHaveBeenCalled();
      expect(listMock).not.toHaveBeenCalled();
      expect(byHandleMock).not.toHaveBeenCalled();
      expect(availableMock).not.toHaveBeenCalled();
    },
  );

  it("resolves the tenant from the HOST and scopes the handle to that site's group", async () => {
    listMock.mockResolvedValue({ products: [] });
    byHandleMock.mockResolvedValue(productDTO());
    availableMock.mockResolvedValue(3);

    const res = await call(HOST_A);
    expect(res.status).toBe(200);
    expect(resolveSiteMock).toHaveBeenCalledWith(HOST_A);
    expect(tenantDbMock).toHaveBeenCalledTimes(1);
    expect(tenantDbMock).toHaveBeenCalledWith(TG_A);
  });
});

describe('GET /api/commerce/products (list)', () => {
  it('returns the typed commerce graph read through the scoped handle', async () => {
    listMock.mockResolvedValue({ products: [productDTO()] });

    const res = await productsGET(req('/api/commerce/products'));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.nextCursor).toBeUndefined();
    expect(body.products).toHaveLength(1);
    const product = body.products[0];
    expect(product.options[0].values[0]).toEqual({ id: 'val-red', value: 'Red' });
    expect(product.variants[0].resolvedPriceCents).toBe(1999);
    expect(product).not.toHaveProperty('values.title');
    expect(listMock).toHaveBeenCalledWith(SCOPED_A, {
      limit: 50,
      cursor: undefined,
      currency: 'EUR',
    });
  });

  it('honors ?currency=, ?limit= and ?cursor=, and passes nextCursor through', async () => {
    listMock.mockResolvedValue({ products: [productDTO()], nextCursor: 'prod-1' });
    const res = await productsGET(
      req('/api/commerce/products?currency=usd&limit=1&cursor=prod-0'),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).nextCursor).toBe('prod-1');
    expect(listMock).toHaveBeenCalledWith(SCOPED_A, {
      limit: 1,
      cursor: 'prod-0',
      currency: 'USD',
    });
  });

  it('returns a 400 bad_request envelope on a malformed limit (never silently clamped)', async () => {
    const res = await productsGET(req('/api/commerce/products?limit=abc'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
    expect(listMock).not.toHaveBeenCalled();
  });

  it('surfaces a read failure as a 500 commerce_read_failed envelope (never an empty 200)', async () => {
    listMock.mockRejectedValue(new Error('db down'));
    const res = await productsGET(req('/api/commerce/products'));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_read_failed');
  });

  it('surfaces a resolver failure (database down) as a 500 envelope, not a crash', async () => {
    resolveSiteMock.mockRejectedValue(new Error('db down'));
    const res = await productsGET(req('/api/commerce/products'));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_read_failed');
  });

  it('rejects a malformed DTO from the reader as a 500 (validated before shipping)', async () => {
    listMock.mockResolvedValue({
      products: [{ ...productDTO(), resolvedPriceCents: 19.99 }],
    });
    const res = await productsGET(req('/api/commerce/products'));
    expect(res.status).toBe(500);
  });
});

describe('GET /api/commerce/products/[handle] (detail)', () => {
  it('resolves a product by handle as 200 ProductDTO through the scoped handle', async () => {
    byHandleMock.mockResolvedValue(productDTO({ handle: 'tee' }));

    const res = await productGET(req('/api/commerce/products/tee?currency=usd'), {
      params: Promise.resolve({ handle: 'tee' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handle).toBe('tee');
    expect(body.variants[0].resolvedPriceCents).toBe(1999);
    expect(byHandleMock).toHaveBeenCalledWith(SCOPED_A, 'tee', 'USD');
  });

  it('returns a 404 not_found envelope when the handle resolves to no live product', async () => {
    byHandleMock.mockResolvedValue(null);
    const res = await productGET(req('/api/commerce/products/ghost'), {
      params: Promise.resolve({ handle: 'ghost' }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('surfaces a read failure as a 500 commerce_read_failed envelope', async () => {
    byHandleMock.mockRejectedValue(new Error('boom'));
    const res = await productGET(req('/api/commerce/products/tee'), {
      params: Promise.resolve({ handle: 'tee' }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_read_failed');
  });
});

describe('GET /api/commerce/inventory (advisory availability)', () => {
  it('returns the advisory-only availability read through the scoped handle', async () => {
    availableMock.mockResolvedValue(7);
    const res = await inventoryGET(
      req('/api/commerce/inventory?variantId=var-1&locationId=loc-1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      variantId: 'var-1',
      locationId: 'loc-1',
      availableQuantity: 7,
      advisoryOnly: true,
    });
    expect(availableMock).toHaveBeenCalledWith(SCOPED_A, 'var-1', 'loc-1');
  });

  it('returns a 400 bad_request envelope when a query param is missing', async () => {
    const res = await inventoryGET(req('/api/commerce/inventory?variantId=var-1'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
    expect(availableMock).not.toHaveBeenCalled();
    expect(resolveSiteMock).not.toHaveBeenCalled();
  });

  it('returns a 404 not_found envelope for an (item, location) pair with no level row', async () => {
    availableMock.mockResolvedValue(null);
    const res = await inventoryGET(
      req('/api/commerce/inventory?variantId=var-x&locationId=loc-1'),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('surfaces a read failure as a 500 commerce_read_failed envelope', async () => {
    availableMock.mockRejectedValue(new Error('select failed'));
    const res = await inventoryGET(
      req('/api/commerce/inventory?variantId=var-1&locationId=loc-1'),
    );
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_read_failed');
  });
});

describe('D2 source contract: the storefront plane never reads a session', () => {
  it('no storefront route, nor its tenancy edge or shared read handlers, touches a session or cookie', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../../../..');
    const files = [
      'src/app/api/commerce/products/route.ts',
      'src/app/api/commerce/products/[handle]/route.ts',
      'src/app/api/commerce/inventory/route.ts',
      'src/app/api/commerce/orders/route.ts',
      'src/server/commerce/storefrontTenant.ts',
      'src/server/commerce/readHandlers.ts',
    ];
    for (const file of files) {
      // Code only: comments may name the editor plane to explain the split.
      const src = readFileSync(path.join(root, file), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(src, file).not.toMatch(/getVerifiedSession|authenticateRequest|lumitra_session|cookies\(|editorTenant/);
    }
  });
});
