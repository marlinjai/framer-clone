import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import {
  InMemoryCommerceDataSource,
  getSharedInMemoryCommerceDataSource,
} from '../inMemoryCommerceDataSource';
import {
  CommerceDataSourceContext,
  useCommerceDataSource,
} from '../context';
import { ALL_LOCATIONS } from '../types';

describe('InMemoryCommerceDataSource', () => {
  let ds: InMemoryCommerceDataSource;

  beforeEach(() => {
    ds = new InMemoryCommerceDataSource();
  });

  describe('listProducts', () => {
    it('returns the seeded product with its options and variant ids', async () => {
      const page = await ds.listProducts();
      expect(page.total).toBe(1);
      expect(page.products).toHaveLength(1);
      const product = page.products[0];
      expect(product.id).toBe('prod_tee');
      expect(product.handle).toBe('classic-tee');
      expect(product.options.map((o) => o.title)).toEqual(['Size', 'Color']);
      expect(product.variantIds).toHaveLength(4);
    });

    it('resolves option values onto each option', async () => {
      const page = await ds.listProducts();
      const size = page.products[0].options.find((o) => o.title === 'Size');
      expect(size?.values.map((v) => v.label)).toEqual(['Small', 'Medium']);
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

    it('reports total ignoring limit', async () => {
      const page = await ds.listProducts({ limit: 0 });
      expect(page.products).toHaveLength(0);
      expect(page.total).toBe(1);
    });
  });

  describe('getProduct / getProductByHandle', () => {
    it('returns the product by id', async () => {
      const product = await ds.getProduct('prod_tee');
      expect(product?.handle).toBe('classic-tee');
    });

    it('returns the product by handle', async () => {
      const product = await ds.getProductByHandle('classic-tee');
      expect(product?.id).toBe('prod_tee');
    });

    it('returns null for an unknown id (no silent success)', async () => {
      expect(await ds.getProduct('does_not_exist')).toBeNull();
    });

    it('returns null for an unknown handle', async () => {
      expect(await ds.getProductByHandle('does_not_exist')).toBeNull();
    });
  });

  describe('listVariants / getVariant', () => {
    it('lists the four variants with resolved option coordinates', async () => {
      const variants = await ds.listVariants('prod_tee');
      expect(variants).toHaveLength(4);
      const sRed = variants.find((v) => v.id === 'var_s_red');
      expect(sRed?.sku).toBe('TEE-S-RED');
      expect(sRed?.barcode).toBe('0000000000017');
      expect(sRed?.optionValues).toEqual([
        { optionId: 'opt_size', valueId: 'ov_size_s', label: 'Small' },
        { optionId: 'opt_color', valueId: 'ov_color_red', label: 'Red' },
      ]);
    });

    it('falls back to the product tax class when the variant leaves it unset', async () => {
      const sRed = await ds.getVariant('var_s_red');
      expect(sRed?.taxClass).toBe('standard');
      const mBlue = await ds.getVariant('var_m_blue');
      expect(mBlue?.taxClass).toBe('reduced');
    });

    it('returns an empty array for a product with no variants', async () => {
      expect(await ds.listVariants('no_such_product')).toEqual([]);
    });

    it('returns null for an unknown variant', async () => {
      expect(await ds.getVariant('no_such_variant')).toBeNull();
    });
  });

  describe('getPrices', () => {
    it('returns integer-cent prices with currency', async () => {
      const prices = await ds.getPrices('var_s_red');
      expect(prices).toEqual([
        {
          variantId: 'var_s_red',
          amountCents: 2500,
          currency: 'usd',
          taxClass: 'standard',
        },
      ]);
    });

    it('returns quantity-band prices when present', async () => {
      const prices = await ds.getPrices('var_m_blue');
      expect(prices).toHaveLength(2);
      const bulk = prices.find((p) => p.minQuantity === 10);
      expect(bulk?.amountCents).toBe(2400);
    });

    it('returns an empty array for a variant with no prices', async () => {
      expect(await ds.getPrices('no_such_variant')).toEqual([]);
    });
  });

  describe('getAvailability (advisory only)', () => {
    it('aggregates across locations when no location is given', async () => {
      // var_s_red: main (12-2=10) + warehouse (30-0=30) = 40
      const a = await ds.getAvailability('var_s_red');
      expect(a.locationId).toBe(ALL_LOCATIONS);
      expect(a.availableQuantity).toBe(40);
      expect(a.stale).toBe(false);
    });

    it('reports a single location available_quantity (stocked - reserved)', async () => {
      const a = await ds.getAvailability('var_s_red', 'loc_main');
      expect(a.locationId).toBe('loc_main');
      expect(a.availableQuantity).toBe(10);
    });

    it('reports zero for a valid location with no stock', async () => {
      const a = await ds.getAvailability('var_m_red', 'loc_main');
      expect(a.availableQuantity).toBe(0);
    });

    it('throws for a missing variant (never silent success)', async () => {
      await expect(ds.getAvailability('no_such_variant')).rejects.toThrow(
        /no variant/,
      );
    });
  });

  describe('subscribe (polling-style)', () => {
    it('fires matching subscribers on mutate and stops after unsubscribe', () => {
      let calls = 0;
      const unsub = ds.subscribe('prod_tee', () => {
        calls += 1;
      });
      ds._mutate('prod_tee', (seed) => {
        seed.products[0].title = 'Classic Tee v2';
      });
      expect(calls).toBe(1);
      ds._mutate('prod_tee', () => {});
      expect(calls).toBe(2);
      unsub();
      ds._mutate('prod_tee', () => {});
      expect(calls).toBe(2);
    });

    it('a null-scope subscriber fires for any product', () => {
      let calls = 0;
      const unsub = ds.subscribe(null, () => {
        calls += 1;
      });
      ds._mutate('prod_tee', () => {});
      expect(calls).toBe(1);
      unsub();
    });

    it('does not fire a subscriber scoped to a different product', () => {
      let calls = 0;
      const unsub = ds.subscribe('other_product', () => {
        calls += 1;
      });
      ds._mutate('prod_tee', () => {});
      expect(calls).toBe(0);
      unsub();
    });

    it('safely unsubscribes synchronously inside the callback', () => {
      let calls = 0;
      let unsub: (() => void) | null = null;
      unsub = ds.subscribe('prod_tee', () => {
        calls += 1;
        unsub?.();
      });
      ds._mutate('prod_tee', () => {});
      ds._mutate('prod_tee', () => {});
      expect(calls).toBe(1);
    });
  });

  describe('isolation', () => {
    it('does not leak mutations to a freshly constructed double', async () => {
      ds._mutate('prod_tee', (seed) => {
        seed.products = [];
      });
      const fresh = new InMemoryCommerceDataSource();
      const page = await fresh.listProducts();
      expect(page.products).toHaveLength(1);
    });
  });

  describe('read-only contract', () => {
    it('exposes ONLY the read methods (no write/reserve/adjust on the seam)', () => {
      const publicMethods = Object.getOwnPropertyNames(
        InMemoryCommerceDataSource.prototype,
      )
        .filter((name) => name !== 'constructor' && !name.startsWith('_'))
        .filter(
          (name) =>
            typeof (
              InMemoryCommerceDataSource.prototype as unknown as Record<
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
  });

  describe('getSharedInMemoryCommerceDataSource', () => {
    it('returns a stable singleton', () => {
      expect(getSharedInMemoryCommerceDataSource()).toBe(
        getSharedInMemoryCommerceDataSource(),
      );
    });
  });
});

describe('useCommerceDataSource', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('throws loudly when used outside a provider', () => {
    expect(() => renderHook(() => useCommerceDataSource())).toThrow(
      /CommerceDataSourceContext/,
    );
  });

  it('returns the provider when wrapped', () => {
    const provider = new InMemoryCommerceDataSource();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(
        CommerceDataSourceContext.Provider,
        { value: provider },
        children,
      );
    const { result } = renderHook(() => useCommerceDataSource(), { wrapper });
    expect(result.current).toBe(provider);
  });
});
