// src/server/commerce/repository/__tests__/read.test.ts
//
// Headless UNIT tests for the READ-ONLY commerce repository (read.ts). These run
// in the node project of the standard `pnpm test` gate (no Docker, no live
// Postgres): the transaction client is a programmable fake (the same pattern
// pricing.test.ts / reserve.test.ts use), so what is exercised is each read
// method's QUERY SHAPE and its row->DTO mapping, not Postgres semantics.
//
// Each of the five CommerceServerRepository methods is covered against the
// tx-first `commerceReadRepository` (the public getCommerceServerRepository()
// just wraps these in withTenant). The DB-booting proof (a real Prisma read
// against Dockerized Postgres) belongs in a `.itest.ts` and is out of scope for
// this headless gate by design.

import { describe, expect, it, vi } from 'vitest';

import { ALL_LOCATIONS } from '@/lib/commerce/types';
import { commerceReadRepository } from '../read';

// A programmable fake of Prisma.TransactionClient: only the members read.ts
// touches are implemented, each a vi.fn() the test wires per-scenario.
function makeTx(overrides: Record<string, unknown> = {}) {
  const tx = {
    product: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    productVariant: { findMany: vi.fn(), findUnique: vi.fn() },
    price: { findMany: vi.fn() },
    inventoryItem: { findFirst: vi.fn() },
    inventoryLevel: { findMany: vi.fn() },
  };
  return Object.assign(tx, overrides) as typeof tx & Record<string, unknown>;
}

// A product row in the include-graph shape product.findMany / findFirst return.
function makeProductRow(over: Partial<{
  id: string;
  handle: string;
  title: string;
  description: string | null;
  taxClass: string | null;
  options: Array<{ id: string; productId: string; title: string; values: Array<{ id: string; optionId: string; value: string }> }>;
  variants: Array<{ id: string }>;
}> = {}) {
  return {
    id: over.id ?? 'prod_tee',
    handle: over.handle ?? 'classic-tee',
    title: over.title ?? 'Classic Tee',
    description: 'description' in over ? (over.description ?? null) : 'A soft everyday t-shirt.',
    taxClass: 'taxClass' in over ? (over.taxClass ?? null) : 'standard',
    options: over.options ?? [
      {
        id: 'opt_size',
        productId: 'prod_tee',
        title: 'Size',
        values: [
          { id: 'ov_size_s', optionId: 'opt_size', value: 'Small' },
          { id: 'ov_size_m', optionId: 'opt_size', value: 'Medium' },
        ],
      },
    ],
    variants: over.variants ?? [{ id: 'var_s' }, { id: 'var_m' }],
  };
}

describe('listProducts', () => {
  it('maps rows to ProductDTOs and returns the unfiltered total', async () => {
    const tx = makeTx();
    tx.product.count.mockResolvedValue(1);
    tx.product.findMany.mockResolvedValue([makeProductRow()]);

    const page = await commerceReadRepository.listProducts(tx as never);

    expect(page.total).toBe(1);
    expect(page.products).toHaveLength(1);
    const product = page.products[0];
    expect(product.id).toBe('prod_tee');
    expect(product.handle).toBe('classic-tee');
    expect(product.taxClass).toBe('standard');
    expect(product.variantIds).toEqual(['var_s', 'var_m']);
    expect(product.options[0].values.map((v) => v.label)).toEqual(['Small', 'Medium']);
  });

  it('omits taxClass from the DTO when the product row has none (null)', async () => {
    const tx = makeTx();
    tx.product.count.mockResolvedValue(1);
    tx.product.findMany.mockResolvedValue([makeProductRow({ taxClass: null })]);

    const page = await commerceReadRepository.listProducts(tx as never);
    expect('taxClass' in page.products[0]).toBe(false);
  });

  it('filters on `deletedAt: null` and counts with the SAME where it lists with', async () => {
    const tx = makeTx();
    tx.product.count.mockResolvedValue(0);
    tx.product.findMany.mockResolvedValue([]);

    await commerceReadRepository.listProducts(tx as never);

    expect(tx.product.count).toHaveBeenCalledWith({ where: { deletedAt: null } });
    expect(tx.product.findMany.mock.calls[0][0].where).toEqual({ deletedAt: null });
  });

  it('translates a CommerceQuery filter/sort/limit into where (ANDed, insensitive) + orderBy + take', async () => {
    const tx = makeTx();
    tx.product.count.mockResolvedValue(3);
    tx.product.findMany.mockResolvedValue([]);

    await commerceReadRepository.listProducts(tx as never, {
      filter: [
        { field: 'title', op: 'contains', value: 'tee' },
        { field: 'handle', op: 'ne', value: 'hidden' },
      ],
      sort: [{ field: 'title', direction: 'desc' }],
      limit: 2,
    });

    const where = tx.product.count.mock.calls[0][0].where;
    expect(where).toEqual({
      deletedAt: null,
      AND: [
        { title: { contains: 'tee', mode: 'insensitive' } },
        { handle: { not: 'hidden', mode: 'insensitive' } },
      ],
    });

    const listArgs = tx.product.findMany.mock.calls[0][0];
    expect(listArgs.orderBy).toEqual([{ title: 'desc' }]);
    expect(listArgs.take).toBe(2);
  });

  it('total ignores the limit (it is the full filtered count)', async () => {
    const tx = makeTx();
    tx.product.count.mockResolvedValue(42);
    tx.product.findMany.mockResolvedValue([makeProductRow()]);

    const page = await commerceReadRepository.listProducts(tx as never, { limit: 1 });
    expect(page.total).toBe(42);
    expect(page.products).toHaveLength(1);
  });
});

describe('getProductByHandle', () => {
  it('returns the mapped ProductDTO when a live product matches the handle', async () => {
    const tx = makeTx();
    tx.product.findFirst.mockResolvedValue(makeProductRow());

    const product = await commerceReadRepository.getProductByHandle(tx as never, 'classic-tee');

    expect(product?.handle).toBe('classic-tee');
    expect(tx.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { handle: 'classic-tee', deletedAt: null } }),
    );
  });

  it('returns null when no such product exists', async () => {
    const tx = makeTx();
    tx.product.findFirst.mockResolvedValue(null);
    expect(await commerceReadRepository.getProductByHandle(tx as never, 'nope')).toBeNull();
  });
});

describe('listVariants', () => {
  it('maps every variant of the product, with option coordinates and labels', async () => {
    const tx = makeTx();
    tx.productVariant.findMany.mockResolvedValue([
      {
        id: 'var_s_red',
        productId: 'prod_tee',
        title: 'Small / Red',
        sku: 'TEE-S-RED',
        barcode: '0000000000017',
        taxClass: null,
        product: { taxClass: 'standard' },
        options: [
          { optionId: 'opt_size', optionValueId: 'ov_size_s', optionValue: { id: 'ov_size_s', value: 'Small' } },
          { optionId: 'opt_color', optionValueId: 'ov_color_red', optionValue: { id: 'ov_color_red', value: 'Red' } },
        ],
      },
    ]);

    const variants = await commerceReadRepository.listVariants(tx as never, 'prod_tee');

    expect(variants).toHaveLength(1);
    const variant = variants[0];
    expect(variant.id).toBe('var_s_red');
    expect(variant.sku).toBe('TEE-S-RED');
    // taxClass falls back to the product's class when the variant leaves it unset.
    expect(variant.taxClass).toBe('standard');
    expect(variant.optionValues).toEqual([
      { optionId: 'opt_size', valueId: 'ov_size_s', label: 'Small' },
      { optionId: 'opt_color', valueId: 'ov_color_red', label: 'Red' },
    ]);
    expect(tx.productVariant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 'prod_tee', deletedAt: null } }),
    );
  });

  it('prefers the variant taxClass over the product taxClass when set', async () => {
    const tx = makeTx();
    tx.productVariant.findMany.mockResolvedValue([
      {
        id: 'var_m_blue',
        productId: 'prod_tee',
        title: 'Medium / Blue',
        sku: null,
        barcode: null,
        taxClass: 'reduced',
        product: { taxClass: 'standard' },
        options: [],
      },
    ]);

    const [variant] = await commerceReadRepository.listVariants(tx as never, 'prod_tee');
    expect(variant.taxClass).toBe('reduced');
    // null sku/barcode are omitted from the DTO (conditional spreads).
    expect('sku' in variant).toBe(false);
    expect('barcode' in variant).toBe(false);
  });

  it('returns an empty array when the product has no variants', async () => {
    const tx = makeTx();
    tx.productVariant.findMany.mockResolvedValue([]);
    expect(await commerceReadRepository.listVariants(tx as never, 'prod_tee')).toEqual([]);
  });
});

describe('getPrices', () => {
  function makePriceRow(over: Partial<{
    amount: number;
    currencyCode: string;
    minQuantity: number | null;
    maxQuantity: number | null;
  }> = {}) {
    return {
      id: 'price_1',
      priceSetId: 'pset_1',
      priceListId: null,
      currencyCode: over.currencyCode ?? 'usd',
      amount: over.amount ?? 2700,
      minQuantity: over.minQuantity ?? null,
      maxQuantity: over.maxQuantity ?? null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  it('maps price rows to PriceDTOs with amountCents as the integer minor units', async () => {
    const tx = makeTx();
    tx.productVariant.findUnique.mockResolvedValue({ taxClass: null, product: { taxClass: 'standard' } });
    tx.price.findMany.mockResolvedValue([
      makePriceRow({ amount: 2700 }),
      makePriceRow({ amount: 2400, minQuantity: 10 }),
    ]);

    const prices = await commerceReadRepository.getPrices(tx as never, 'var_m_blue');

    expect(prices).toHaveLength(2);
    expect(prices[0].amountCents).toBe(2700);
    expect(Number.isInteger(prices[0].amountCents)).toBe(true);
    expect(prices[0].currency).toBe('usd');
    // resolved tax class folded onto every price row.
    expect(prices[0].taxClass).toBe('standard');
    // quantity-band field mapped when present, omitted when absent.
    expect(prices[1].minQuantity).toBe(10);
    expect('minQuantity' in prices[0]).toBe(false);
    expect(tx.price.findMany).toHaveBeenCalledWith({ where: { priceSet: { variantId: 'var_m_blue' } } });
  });

  it('returns an empty array when the variant has no prices', async () => {
    const tx = makeTx();
    tx.productVariant.findUnique.mockResolvedValue(null);
    tx.price.findMany.mockResolvedValue([]);
    expect(await commerceReadRepository.getPrices(tx as never, 'orphan')).toEqual([]);
  });
});

describe('getAvailability (ADVISORY, never permission to sell)', () => {
  it('aggregates available (stocked - reserved) across ALL locations when no locationId is given', async () => {
    const tx = makeTx();
    tx.productVariant.findUnique.mockResolvedValue({ id: 'var_s_red', sku: 'TEE-S-RED', deletedAt: null });
    tx.inventoryItem.findFirst.mockResolvedValue({ id: 'invitem_s_red' });
    tx.inventoryLevel.findMany.mockResolvedValue([
      { stockedQuantity: 12, reservedQuantity: 2 }, // 10
      { stockedQuantity: 30, reservedQuantity: 0 }, // 30
    ]);

    const availability = await commerceReadRepository.getAvailability(tx as never, 'var_s_red');

    expect(availability).toEqual({
      variantId: 'var_s_red',
      locationId: ALL_LOCATIONS,
      availableQuantity: 40,
      stale: false,
    });
    // No locationId -> the level query is NOT scoped to a location.
    expect(tx.inventoryLevel.findMany.mock.calls[0][0].where).toEqual({
      inventoryItemId: 'invitem_s_red',
    });
  });

  it('reports a specific location and scopes the level query to it', async () => {
    const tx = makeTx();
    tx.productVariant.findUnique.mockResolvedValue({ id: 'var_s_red', sku: 'TEE-S-RED', deletedAt: null });
    tx.inventoryItem.findFirst.mockResolvedValue({ id: 'invitem_s_red' });
    tx.inventoryLevel.findMany.mockResolvedValue([{ stockedQuantity: 12, reservedQuantity: 2 }]);

    const availability = await commerceReadRepository.getAvailability(tx as never, 'var_s_red', 'loc_main');

    expect(availability.locationId).toBe('loc_main');
    expect(availability.availableQuantity).toBe(10);
    expect(tx.inventoryLevel.findMany.mock.calls[0][0].where).toEqual({
      inventoryItemId: 'invitem_s_red',
      locationId: 'loc_main',
    });
  });

  it('throws when the variant does not exist', async () => {
    const tx = makeTx();
    tx.productVariant.findUnique.mockResolvedValue(null);
    await expect(commerceReadRepository.getAvailability(tx as never, 'ghost')).rejects.toThrow(
      /no variant with id "ghost"/,
    );
  });

  it('throws when the variant is soft-deleted', async () => {
    const tx = makeTx();
    tx.productVariant.findUnique.mockResolvedValue({ id: 'var_x', sku: 'X', deletedAt: new Date(0) });
    await expect(commerceReadRepository.getAvailability(tx as never, 'var_x')).rejects.toThrow();
  });

  it('reports zero (not an error) when the variant has no SKU', async () => {
    const tx = makeTx();
    tx.productVariant.findUnique.mockResolvedValue({ id: 'var_s', sku: null, deletedAt: null });

    const availability = await commerceReadRepository.getAvailability(tx as never, 'var_s');
    expect(availability.availableQuantity).toBe(0);
    expect(availability.locationId).toBe(ALL_LOCATIONS);
    expect(tx.inventoryItem.findFirst).not.toHaveBeenCalled();
  });

  it('reports zero when the SKU has no live inventory_item', async () => {
    const tx = makeTx();
    tx.productVariant.findUnique.mockResolvedValue({ id: 'var_s', sku: 'TEE-S-RED', deletedAt: null });
    tx.inventoryItem.findFirst.mockResolvedValue(null);

    const availability = await commerceReadRepository.getAvailability(tx as never, 'var_s');
    expect(availability.availableQuantity).toBe(0);
    expect(tx.inventoryLevel.findMany).not.toHaveBeenCalled();
  });
});
