// HttpCommerceDataSource must pass the SAME read contract the
// InMemoryCommerceDataSource double passes (listProducts with filter/sort/limit,
// getProduct / getProductByHandle, listVariants / getVariant, getPrices,
// advisory getAvailability, polling subscribe, and the read-only seam contract),
// plus two HTTP-specific guarantees: NO write/reserve happens on any read path,
// and a failed or malformed b7 response surfaces as a well-formed error rather
// than a silent null.
//
// `fetch` is mocked with a stub that mirrors the b7 /api/commerce/* route shapes
// (src/app/api/commerce/*), backed by a b7-DTO-shaped fixture, so the provider's
// HTTP plumbing, pagination, validation, and b7 -> seam mapping all round-trip
// through the same contract the in-memory double is held to. The inventory
// aggregate (no locationId) is served with the shape REQUESTED as an additive b7
// route; see the provider header for that request.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  HttpCommerceDataSource,
  CommerceHttpError,
  getSharedHttpCommerceDataSource,
} from '../httpCommerceDataSource';
import { ALL_LOCATIONS } from '../types';

const BASE = 'http://commerce.test';

// --- b7-DTO-shaped fixture --------------------------------------------------
// Two products so pagination (cursor following) and list filtering/sorting are
// exercised: "Classic Tee" (2 options, 4 priced variants) mirrors the in-memory
// double's fixture; "Classic Mug" is a single-variant product with a null price
// and null title/sku/barcode, exercising the nullable -> optional mapping.

function buildB7Products() {
  return [
    {
      id: 'prod_tee',
      handle: 'classic-tee',
      title: 'Classic Tee',
      description: 'A soft everyday t-shirt.',
      options: [
        {
          id: 'opt_size',
          title: 'Size',
          values: [
            { id: 'ov_size_s', value: 'Small' },
            { id: 'ov_size_m', value: 'Medium' },
          ],
        },
        {
          id: 'opt_color',
          title: 'Color',
          values: [
            { id: 'ov_color_red', value: 'Red' },
            { id: 'ov_color_blue', value: 'Blue' },
          ],
        },
      ],
      variants: [
        {
          id: 'var_s_red',
          title: 'Small / Red',
          sku: 'TEE-S-RED',
          barcode: '0000000000017',
          resolvedPriceCents: 2500,
          options: [
            { optionId: 'opt_size', optionValueId: 'ov_size_s' },
            { optionId: 'opt_color', optionValueId: 'ov_color_red' },
          ],
        },
        {
          id: 'var_s_blue',
          title: 'Small / Blue',
          sku: 'TEE-S-BLUE',
          barcode: '0000000000024',
          resolvedPriceCents: 2500,
          options: [
            { optionId: 'opt_size', optionValueId: 'ov_size_s' },
            { optionId: 'opt_color', optionValueId: 'ov_color_blue' },
          ],
        },
        {
          id: 'var_m_red',
          title: 'Medium / Red',
          sku: 'TEE-M-RED',
          barcode: '0000000000031',
          resolvedPriceCents: 2700,
          options: [
            { optionId: 'opt_size', optionValueId: 'ov_size_m' },
            { optionId: 'opt_color', optionValueId: 'ov_color_red' },
          ],
        },
        {
          id: 'var_m_blue',
          title: 'Medium / Blue',
          sku: 'TEE-M-BLUE',
          barcode: '0000000000048',
          resolvedPriceCents: 2700,
          options: [
            { optionId: 'opt_size', optionValueId: 'ov_size_m' },
            { optionId: 'opt_color', optionValueId: 'ov_color_blue' },
          ],
        },
      ],
      resolvedPriceCents: 2500,
    },
    {
      id: 'prod_mug',
      handle: 'classic-mug',
      title: 'Classic Mug',
      description: 'A sturdy ceramic mug.',
      options: [],
      variants: [
        {
          id: 'var_mug',
          title: null,
          sku: null,
          barcode: null,
          resolvedPriceCents: null,
          options: [],
        },
      ],
      resolvedPriceCents: null,
    },
  ];
}

// available_quantity per variant per location; the aggregate (no location) is
// the sum across locations, mirroring the b2 generated column read.
const INVENTORY: Record<string, Record<string, number>> = {
  var_s_red: { loc_main: 10, loc_warehouse: 30 },
  var_m_red: { loc_main: 0, loc_warehouse: 16 },
  var_mug: { loc_main: 5 },
};

// --- fetch stub mirroring the b7 route shapes -------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorEnvelope(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

interface StubOverrides {
  // Force the products list route to fail with this status (error path test).
  listStatus?: number;
  // Return a structurally invalid products list payload (malformed path test).
  malformedList?: boolean;
  // Strip the advisoryOnly marker from inventory responses (advisory path test).
  dropAdvisoryMarker?: boolean;
  // Page size for the list route; defaults to 1 to exercise cursor following.
  pageSize?: number;
}

function makeFetchStub(overrides: StubOverrides = {}) {
  const products = buildB7Products();
  const pageSize = overrides.pageSize ?? 1;

  return async (input: string | URL | Request): Promise<Response> => {
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(href, BASE);
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
    // Expect ['api', 'commerce', <resource>, ...rest].
    const resource = parts[2];
    const rest = parts.slice(3);

    if (resource === 'products' && rest.length === 0) {
      if (overrides.listStatus) {
        return errorEnvelope(
          'commerce_read_failed',
          'failed to list products',
          overrides.listStatus,
        );
      }
      if (overrides.malformedList) {
        // products[].id missing -> fails productListResponseSchema.
        return json({ products: [{ handle: 'broken' }] });
      }
      const cursor = url.searchParams.get('cursor') ?? undefined;
      const startIdx = cursor
        ? products.findIndex((p) => p.id === cursor) + 1
        : 0;
      const page = products.slice(startIdx, startIdx + pageSize);
      const hasMore = startIdx + pageSize < products.length;
      const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;
      return json({ products: page, ...(nextCursor ? { nextCursor } : {}) });
    }

    if (resource === 'products' && rest.length === 1) {
      const handle = decodeURIComponent(rest[0]);
      const hit = products.find((p) => p.handle === handle);
      return hit
        ? json(hit)
        : errorEnvelope('not_found', `no product with handle ${handle}`, 404);
    }

    if (resource === 'inventory' && rest.length === 0) {
      const variantId = url.searchParams.get('variantId');
      const locationId = url.searchParams.get('locationId');
      if (!variantId) {
        return errorEnvelope('bad_request', 'variantId is required', 400);
      }
      const byLocation = INVENTORY[variantId];
      if (!byLocation) {
        return errorEnvelope(
          'not_found',
          `no inventory for variant ${variantId}`,
          404,
        );
      }
      let availableQuantity: number;
      let resolvedLocation: string;
      if (locationId === null) {
        // Aggregate mode (REQUESTED additive b7 route): sum across locations.
        availableQuantity = Object.values(byLocation).reduce((s, n) => s + n, 0);
        resolvedLocation = ALL_LOCATIONS;
      } else {
        if (!(locationId in byLocation)) {
          return errorEnvelope(
            'not_found',
            `no inventory level for variant ${variantId} at ${locationId}`,
            404,
          );
        }
        availableQuantity = byLocation[locationId];
        resolvedLocation = locationId;
      }
      return json({
        variantId,
        locationId: resolvedLocation,
        availableQuantity,
        ...(overrides.dropAdvisoryMarker ? {} : { advisoryOnly: true }),
      });
    }

    return errorEnvelope('bad_route', url.pathname, 400);
  };
}

function installFetch(overrides: StubOverrides = {}) {
  vi.stubGlobal('fetch', vi.fn(makeFetchStub(overrides)));
}

describe('HttpCommerceDataSource (contract parity over /api/commerce/*)', () => {
  let ds: HttpCommerceDataSource;

  beforeEach(() => {
    installFetch();
    ds = new HttpCommerceDataSource({ baseUrl: BASE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('listProducts', () => {
    it('pages the whole catalog and maps b7 products to seam products', async () => {
      const page = await ds.listProducts();
      expect(page.total).toBe(2);
      expect(page.products.map((p) => p.id).sort()).toEqual([
        'prod_mug',
        'prod_tee',
      ]);
      const tee = page.products.find((p) => p.id === 'prod_tee');
      expect(tee?.handle).toBe('classic-tee');
      expect(tee?.options.map((o) => o.title)).toEqual(['Size', 'Color']);
      expect(tee?.variantIds).toHaveLength(4);
    });

    it('resolves option values and stamps productId onto each option', async () => {
      const page = await ds.listProducts();
      const tee = page.products.find((p) => p.id === 'prod_tee');
      const size = tee?.options.find((o) => o.title === 'Size');
      expect(size?.productId).toBe('prod_tee');
      expect(size?.values.map((v) => v.label)).toEqual(['Small', 'Medium']);
      expect(size?.values.every((v) => v.optionId === 'opt_size')).toBe(true);
    });

    it('filters by handle (eq)', async () => {
      const hit = await ds.listProducts({
        filter: [{ field: 'handle', op: 'eq', value: 'classic-tee' }],
      });
      expect(hit.products).toHaveLength(1);
      const miss = await ds.listProducts({
        filter: [{ field: 'handle', op: 'eq', value: 'nope' }],
      });
      expect(miss.products).toHaveLength(0);
      expect(miss.total).toBe(0);
    });

    it('sorts by handle ascending', async () => {
      const page = await ds.listProducts({
        sort: [{ field: 'handle', direction: 'asc' }],
      });
      expect(page.products.map((p) => p.handle)).toEqual([
        'classic-mug',
        'classic-tee',
      ]);
    });

    it('reports total ignoring limit', async () => {
      const page = await ds.listProducts({ limit: 0 });
      expect(page.products).toHaveLength(0);
      expect(page.total).toBe(2);
    });
  });

  describe('getProduct / getProductByHandle', () => {
    it('returns the product by id', async () => {
      const product = await ds.getProduct('prod_tee');
      expect(product?.handle).toBe('classic-tee');
    });

    it('returns the product by handle (single detail fetch)', async () => {
      const product = await ds.getProductByHandle('classic-tee');
      expect(product?.id).toBe('prod_tee');
    });

    it('returns null for an unknown id (no silent success)', async () => {
      expect(await ds.getProduct('does_not_exist')).toBeNull();
    });

    it('returns null for an unknown handle (b7 404 maps to null)', async () => {
      expect(await ds.getProductByHandle('does_not_exist')).toBeNull();
    });
  });

  describe('listVariants / getVariant', () => {
    it('lists the four variants with resolved option coordinates', async () => {
      const variants = await ds.listVariants('prod_tee');
      expect(variants).toHaveLength(4);
      const sRed = variants.find((v) => v.id === 'var_s_red');
      expect(sRed?.productId).toBe('prod_tee');
      expect(sRed?.sku).toBe('TEE-S-RED');
      expect(sRed?.barcode).toBe('0000000000017');
      expect(sRed?.optionValues).toEqual([
        { optionId: 'opt_size', valueId: 'ov_size_s', label: 'Small' },
        { optionId: 'opt_color', valueId: 'ov_color_red', label: 'Red' },
      ]);
    });

    it('maps a null title and omits absent sku/barcode (nullable -> optional)', async () => {
      const mug = await ds.getVariant('var_mug');
      expect(mug?.productId).toBe('prod_mug');
      expect(mug?.title).toBeNull();
      expect('sku' in (mug ?? {})).toBe(false);
      expect('barcode' in (mug ?? {})).toBe(false);
    });

    it('returns an empty array for a product with no variants', async () => {
      expect(await ds.listVariants('no_such_product')).toEqual([]);
    });

    it('returns null for an unknown variant', async () => {
      expect(await ds.getVariant('no_such_variant')).toBeNull();
    });
  });

  describe('getPrices', () => {
    it('returns the resolved integer-cent price with the requested currency', async () => {
      const prices = await ds.getPrices('var_s_red');
      expect(prices).toEqual([
        { variantId: 'var_s_red', amountCents: 2500, currency: 'EUR' },
      ]);
    });

    it('returns an empty array when the variant has no resolved price', async () => {
      expect(await ds.getPrices('var_mug')).toEqual([]);
    });

    it('returns an empty array for an unknown variant', async () => {
      expect(await ds.getPrices('no_such_variant')).toEqual([]);
    });
  });

  describe('getAvailability (advisory only)', () => {
    it('aggregates across locations when no location is given', async () => {
      // var_s_red: loc_main 10 + loc_warehouse 30 = 40
      const a = await ds.getAvailability('var_s_red');
      expect(a.locationId).toBe(ALL_LOCATIONS);
      expect(a.availableQuantity).toBe(40);
      expect(a.stale).toBe(false);
    });

    it('reports a single location available_quantity', async () => {
      const a = await ds.getAvailability('var_s_red', 'loc_main');
      expect(a.locationId).toBe('loc_main');
      expect(a.availableQuantity).toBe(10);
      expect(a.stale).toBe(false);
    });

    it('reports zero for a real location level that holds no stock', async () => {
      const a = await ds.getAvailability('var_m_red', 'loc_main');
      expect(a.availableQuantity).toBe(0);
    });

    it('throws a well-formed error for a missing variant (never silent success)', async () => {
      await expect(ds.getAvailability('no_such_variant')).rejects.toBeInstanceOf(
        CommerceHttpError,
      );
    });

    it('rejects an availability payload missing the advisory-only marker', async () => {
      vi.unstubAllGlobals();
      installFetch({ dropAdvisoryMarker: true });
      const fresh = new HttpCommerceDataSource({ baseUrl: BASE });
      await expect(
        fresh.getAvailability('var_s_red', 'loc_main'),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    });
  });

  describe('subscribe (polling-style)', () => {
    it('fires onChange on the poll cadence and stops after unsubscribe', () => {
      vi.useFakeTimers();
      try {
        const provider = new HttpCommerceDataSource({
          baseUrl: BASE,
          pollMs: 1000,
        });
        let calls = 0;
        const unsub = provider.subscribe('prod_tee', () => {
          calls += 1;
        });
        vi.advanceTimersByTime(3000);
        expect(calls).toBe(3);
        unsub();
        vi.advanceTimersByTime(5000);
        expect(calls).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('read-only contract', () => {
    it('exposes ONLY the read methods (no write/reserve/adjust on the seam)', () => {
      const publicMethods = Object.getOwnPropertyNames(
        HttpCommerceDataSource.prototype,
      )
        .filter((name) => name !== 'constructor' && !name.startsWith('_'))
        .filter(
          (name) =>
            typeof (
              HttpCommerceDataSource.prototype as unknown as Record<
                string,
                unknown
              >
            )[name] === 'function',
        )
        .sort();

      expect(publicMethods).toEqual(
        [
          'getAvailability',
          'getPrices',
          'getProduct',
          'getProductByHandle',
          'getVariant',
          'listProducts',
          'listVariants',
          'subscribe',
        ].sort(),
      );

      const forbidden = [
        'createProduct',
        'updateProduct',
        'deleteProduct',
        'createVariant',
        'updateVariant',
        'deleteVariant',
        'setPrice',
        'reserve',
        'reserveStock',
        'adjustInventory',
        'writeInventory',
      ];
      for (const name of forbidden) {
        expect(publicMethods).not.toContain(name);
      }
    });

    it('never issues a write/reserve request on any read path', async () => {
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockClear();

      // Exercise every read method.
      await ds.listProducts();
      await ds.getProduct('prod_tee');
      await ds.getProductByHandle('classic-tee');
      await ds.listVariants('prod_tee');
      await ds.getVariant('var_s_red');
      await ds.getPrices('var_s_red');
      await ds.getAvailability('var_s_red');
      await ds.getAvailability('var_s_red', 'loc_main');

      expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
      for (const call of fetchMock.mock.calls) {
        const [input, init] = call as [
          string | URL | Request,
          RequestInit | undefined,
        ];
        // Every call is a GET (no method override means GET).
        const method = (init?.method ?? 'GET').toUpperCase();
        expect(method).toBe('GET');
        // No read path ever targets a write/reserve/checkout route.
        const href =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        expect(href).not.toMatch(/reserve|checkout|\/order/i);
      }
    });
  });

  describe('errors surface (never swallowed)', () => {
    it('throws a well-formed CommerceHttpError when the list route fails', async () => {
      vi.unstubAllGlobals();
      installFetch({ listStatus: 500 });
      const fresh = new HttpCommerceDataSource({ baseUrl: BASE });
      await expect(fresh.listProducts()).rejects.toMatchObject({
        code: 'commerce_read_failed',
        status: 500,
      });
    });

    it('throws when b7 returns a structurally invalid product list', async () => {
      vi.unstubAllGlobals();
      installFetch({ malformedList: true });
      const fresh = new HttpCommerceDataSource({ baseUrl: BASE });
      await expect(fresh.listProducts()).rejects.toMatchObject({
        code: 'invalid_response',
      });
    });
  });

  describe('getSharedHttpCommerceDataSource', () => {
    it('returns a stable singleton', () => {
      expect(getSharedHttpCommerceDataSource()).toBe(
        getSharedHttpCommerceDataSource(),
      );
    });
  });
});
