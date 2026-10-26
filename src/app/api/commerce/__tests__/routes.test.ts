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
  isCommerceTenantNotProvisioned: (err: unknown) =>
    (err as { code?: string } | null)?.code === 'COMMERCE_TENANT_NOT_PROVISIONED',
}));

vi.mock('@/server/commerce/repository/storefront', () => ({
  listStorefrontProducts: vi.fn(),
  getStorefrontProductByHandle: vi.fn(),
}));

vi.mock('@/server/commerce/repository/read', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/commerce/repository/read')>()),
  commerceReadRepository: { getAvailability: vi.fn() },
}));

import { resolvePublishedSite } from '@/server/sites/publicResolver';
import { commerceTenantDbChecked } from '@/server/commerce/db';
import { getStorefrontProductByHandle, listStorefrontProducts } from '@/server/commerce/repository/storefront';
import { commerceReadRepository } from '@/server/commerce/repository/read';
import { UnknownVariantError } from '@/server/commerce/repository/errors';
import type { ProductDTO } from '@/lib/commerce/dto';
import { GET as productsGET } from '../products/route';
import { GET as productGET } from '../products/[handle]/route';
import { GET as inventoryGET } from '../inventory/route';

const resolveSiteMock = vi.mocked(resolvePublishedSite);
const tenantDbMock = vi.mocked(commerceTenantDbChecked);
const listMock = vi.mocked(listStorefrontProducts);
const byHandleMock = vi.mocked(getStorefrontProductByHandle);
const availableMock = vi.mocked(commerceReadRepository.getAvailability);

const TG_A = '018f9c10-0000-7000-8000-0000000012aa';
const HOST_A = 'store-a.example.com';
const SCOPED_A = { __scopedHandleFor: TG_A };

/** The catalogue view of the storefront site: its company and the site (020_catalogue_company). */
const VIEW_A = { companyId: '018f9c10-0000-7000-8000-0000000000a1', siteId: 'site_a' };

function site(tenantGroupId: unknown) {
  return {
    siteId: 'site_a',
    workspaceId: 'ws_a',
    tenantGroupId,
    companyId: '018f9c10-0000-7000-8000-0000000000a1',
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
      inventoryGET(req('/api/commerce/inventory?variantId=018f9c10-0000-7000-8000-0000000000a1&locationId=018f9c10-0000-7000-8000-0000000000b1', host)),
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
    availableMock.mockResolvedValue(availability({ availableQuantity: 3 }));

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
    expect(listMock).toHaveBeenCalledWith(SCOPED_A, VIEW_A, {
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
    expect(listMock).toHaveBeenCalledWith(SCOPED_A, VIEW_A, {
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

describe('500s never leak internals to the anonymous buyer', () => {
  const secretish =
    'Commerce backstop: could not verify the commerce connection (COMMERCE_APP_DATABASE_URL must point at the low-privilege commerce_app role, search_path = ext): connect ECONNREFUSED 10.0.0.5:5432';

  it.each(ROUTES)('$name: a backstop failure answers a generic 500, the detail only in the log', async ({ call }) => {
    tenantDbMock.mockRejectedValueOnce(new Error(secretish));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(HOST_A);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error.code).toBe('commerce_read_failed');
    for (const fragment of ['COMMERCE_APP_DATABASE_URL', 'commerce_app', 'search_path', 'ECONNREFUSED', '10.0.0.5']) {
      expect(text).not.toContain(fragment);
    }
    expect(errorSpy.mock.calls.flat().some((a) => a instanceof Error && a.message === secretish)).toBe(true);
    errorSpy.mockRestore();
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
    expect(byHandleMock).toHaveBeenCalledWith(SCOPED_A, VIEW_A, 'tee', 'USD');
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
  it('sums every location when no location is named (what the cart and add to cart ask)', async () => {
    availableMock.mockResolvedValue(availability({ locationId: 'all', availableQuantity: 7 }));
    const res = await inventoryGET(req('/api/commerce/inventory?variantId=018f9c10-0000-7000-8000-0000000000a1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      variantId: '018f9c10-0000-7000-8000-0000000000a1',
      locationId: 'all',
      availableQuantity: 7,
      limited: true,
      advisoryOnly: true,
    });
    expect(availableMock).toHaveBeenCalledWith(SCOPED_A, expect.objectContaining({ companyId: expect.any(String) }), '018f9c10-0000-7000-8000-0000000000a1', undefined);
  });

  it('reads one location when it is named', async () => {
    availableMock.mockResolvedValue(availability({ locationId: '018f9c10-0000-7000-8000-0000000000b1', availableQuantity: 2 }));
    const res = await inventoryGET(req('/api/commerce/inventory?variantId=018f9c10-0000-7000-8000-0000000000a1&locationId=018f9c10-0000-7000-8000-0000000000b1'));
    expect(res.status).toBe(200);
    expect((await res.json()).locationId).toBe('018f9c10-0000-7000-8000-0000000000b1');
    expect(availableMock).toHaveBeenCalledWith(SCOPED_A, expect.anything(), '018f9c10-0000-7000-8000-0000000000a1', '018f9c10-0000-7000-8000-0000000000b1');
  });

  it('says when the quantity is no limit (stock not tracked, or back-orders allowed)', async () => {
    availableMock.mockResolvedValue(availability({ availableQuantity: 0, limited: false }));
    const res = await inventoryGET(req('/api/commerce/inventory?variantId=018f9c10-0000-7000-8000-0000000000a1'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ availableQuantity: 0, limited: false });
  });

  it('returns a 400 bad_request envelope for a malformed id, before any read', async () => {
    for (const qs of ['variantId=var-1', 'variantId=018f9c10-0000-7000-8000-0000000000a1&locationId=loc-1']) {
      const res = await inventoryGET(req(`/api/commerce/inventory?${qs}`));
      expect(res.status).toBe(400);
    }
    expect(availableMock).not.toHaveBeenCalled();
  });

  it('returns a 400 bad_request envelope when the variant is missing', async () => {
    const res = await inventoryGET(req('/api/commerce/inventory?locationId=018f9c10-0000-7000-8000-0000000000b1'));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('bad_request');
    expect(availableMock).not.toHaveBeenCalled();
    expect(resolveSiteMock).not.toHaveBeenCalled();
  });

  it('returns a 404 not_found envelope for a variant this company does not have', async () => {
    availableMock.mockRejectedValue(new UnknownVariantError('018f9c10-0000-7000-8000-0000000000a9'));
    const res = await inventoryGET(req('/api/commerce/inventory?variantId=018f9c10-0000-7000-8000-0000000000a9'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('surfaces a read failure as a 500 commerce_read_failed envelope', async () => {
    availableMock.mockRejectedValue(new Error('select failed'));
    const res = await inventoryGET(req('/api/commerce/inventory?variantId=018f9c10-0000-7000-8000-0000000000a1'));
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('commerce_read_failed');
  });
});

/** An availability as the shared reader returns it. */
function availability(over: Partial<{ locationId: string; availableQuantity: number; limited: boolean }> = {}) {
  return { variantId: '018f9c10-0000-7000-8000-0000000000a1', locationId: 'all', availableQuantity: 0, limited: true, stale: false, ...over };
}

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
