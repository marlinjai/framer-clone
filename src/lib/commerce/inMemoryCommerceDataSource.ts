// InMemoryCommerceDataSource: fixture-backed implementation of
// CommerceDataSource. TEST DOUBLE ONLY. Lives in-process, seeded with a
// Medusa-shape catalog (1 product, 2 options, 4 variants, prices, inventory
// levels per location). It is the contract reference the live HTTP provider
// (next spec) must match.
//
// The fixture deliberately stores Track-B-ROW-shaped records (mirroring the
// commerce.* Prisma models) and maps them INTO the client DTOs inside each
// method, so this double exercises the same mapping boundary the real provider
// will: no row shape leaks past a method return. This file is React-free and
// Node-evaluable.

import type { CommerceDataSource } from './provider';
import {
  ALL_LOCATIONS,
  type AvailabilityDTO,
  type CommerceFilterClause,
  type CommerceQuery,
  type PriceDTO,
  type ProductDTO,
  type ProductOptionDTO,
  type ProductPage,
  type ProductVariantDTO,
  type VariantOptionCoordinate,
} from './types';

// --- Internal row shapes (mirror the commerce.* Prisma models) -------------
// These are NEVER exported and NEVER returned directly; methods map them to
// DTOs. They keep the double honest about the row-to-DTO boundary.

interface ProductRow {
  id: string;
  handle: string;
  title: string;
  description: string | null;
  taxClass: string | null;
}

interface OptionRow {
  id: string;
  productId: string;
  title: string;
}

interface OptionValueRow {
  id: string;
  optionId: string;
  value: string;
}

interface VariantRow {
  id: string;
  productId: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  taxClass: string | null;
}

interface VariantOptionRow {
  variantId: string;
  optionId: string;
  optionValueId: string;
}

interface PriceRow {
  id: string;
  variantId: string;
  currencyCode: string;
  amount: number; // integer minor units (cents)
  minQuantity: number | null;
  maxQuantity: number | null;
}

interface InventoryItemRow {
  id: string;
  variantId: string;
}

interface InventoryLevelRow {
  inventoryItemId: string;
  locationId: string;
  stockedQuantity: number;
  reservedQuantity: number;
}

interface Seed {
  products: ProductRow[];
  options: OptionRow[];
  optionValues: OptionValueRow[];
  variants: VariantRow[];
  variantOptions: VariantOptionRow[];
  prices: PriceRow[];
  inventoryItems: InventoryItemRow[];
  inventoryLevels: InventoryLevelRow[];
}

// --- Medusa-shape fixture --------------------------------------------------
// One product "Classic Tee" with two options (Size: S/M, Color: Red/Blue) and
// the four variant combinations, each priced in USD with stock split across
// two locations. Edit freely: this is fixture data, not a contract.

function buildSeed(): Seed {
  return {
    products: [
      {
        id: 'prod_tee',
        handle: 'classic-tee',
        title: 'Classic Tee',
        description: 'A soft everyday t-shirt.',
        taxClass: 'standard',
      },
    ],
    options: [
      { id: 'opt_size', productId: 'prod_tee', title: 'Size' },
      { id: 'opt_color', productId: 'prod_tee', title: 'Color' },
    ],
    optionValues: [
      { id: 'ov_size_s', optionId: 'opt_size', value: 'Small' },
      { id: 'ov_size_m', optionId: 'opt_size', value: 'Medium' },
      { id: 'ov_color_red', optionId: 'opt_color', value: 'Red' },
      { id: 'ov_color_blue', optionId: 'opt_color', value: 'Blue' },
    ],
    variants: [
      {
        id: 'var_s_red',
        productId: 'prod_tee',
        title: 'Small / Red',
        sku: 'TEE-S-RED',
        barcode: '0000000000017',
        taxClass: null,
      },
      {
        id: 'var_s_blue',
        productId: 'prod_tee',
        title: 'Small / Blue',
        sku: 'TEE-S-BLUE',
        barcode: '0000000000024',
        taxClass: null,
      },
      {
        id: 'var_m_red',
        productId: 'prod_tee',
        title: 'Medium / Red',
        sku: 'TEE-M-RED',
        barcode: '0000000000031',
        taxClass: null,
      },
      {
        id: 'var_m_blue',
        productId: 'prod_tee',
        title: 'Medium / Blue',
        sku: 'TEE-M-BLUE',
        barcode: '0000000000048',
        taxClass: 'reduced',
      },
    ],
    variantOptions: [
      { variantId: 'var_s_red', optionId: 'opt_size', optionValueId: 'ov_size_s' },
      { variantId: 'var_s_red', optionId: 'opt_color', optionValueId: 'ov_color_red' },
      { variantId: 'var_s_blue', optionId: 'opt_size', optionValueId: 'ov_size_s' },
      { variantId: 'var_s_blue', optionId: 'opt_color', optionValueId: 'ov_color_blue' },
      { variantId: 'var_m_red', optionId: 'opt_size', optionValueId: 'ov_size_m' },
      { variantId: 'var_m_red', optionId: 'opt_color', optionValueId: 'ov_color_red' },
      { variantId: 'var_m_blue', optionId: 'opt_size', optionValueId: 'ov_size_m' },
      { variantId: 'var_m_blue', optionId: 'opt_color', optionValueId: 'ov_color_blue' },
    ],
    prices: [
      { id: 'price_s_red', variantId: 'var_s_red', currencyCode: 'usd', amount: 2500, minQuantity: null, maxQuantity: null },
      { id: 'price_s_blue', variantId: 'var_s_blue', currencyCode: 'usd', amount: 2500, minQuantity: null, maxQuantity: null },
      { id: 'price_m_red', variantId: 'var_m_red', currencyCode: 'usd', amount: 2700, minQuantity: null, maxQuantity: null },
      { id: 'price_m_blue', variantId: 'var_m_blue', currencyCode: 'usd', amount: 2700, minQuantity: null, maxQuantity: null },
      // quantity-break price on one variant so getPrices returns >1 row
      { id: 'price_m_blue_bulk', variantId: 'var_m_blue', currencyCode: 'usd', amount: 2400, minQuantity: 10, maxQuantity: null },
    ],
    inventoryItems: [
      { id: 'invitem_s_red', variantId: 'var_s_red' },
      { id: 'invitem_s_blue', variantId: 'var_s_blue' },
      { id: 'invitem_m_red', variantId: 'var_m_red' },
      { id: 'invitem_m_blue', variantId: 'var_m_blue' },
    ],
    inventoryLevels: [
      { inventoryItemId: 'invitem_s_red', locationId: 'loc_main', stockedQuantity: 12, reservedQuantity: 2 },
      { inventoryItemId: 'invitem_s_red', locationId: 'loc_warehouse', stockedQuantity: 30, reservedQuantity: 0 },
      { inventoryItemId: 'invitem_s_blue', locationId: 'loc_main', stockedQuantity: 5, reservedQuantity: 5 },
      { inventoryItemId: 'invitem_s_blue', locationId: 'loc_warehouse', stockedQuantity: 8, reservedQuantity: 1 },
      { inventoryItemId: 'invitem_m_red', locationId: 'loc_main', stockedQuantity: 0, reservedQuantity: 0 },
      { inventoryItemId: 'invitem_m_red', locationId: 'loc_warehouse', stockedQuantity: 20, reservedQuantity: 4 },
      { inventoryItemId: 'invitem_m_blue', locationId: 'loc_main', stockedQuantity: 7, reservedQuantity: 0 },
      { inventoryItemId: 'invitem_m_blue', locationId: 'loc_warehouse', stockedQuantity: 7, reservedQuantity: 3 },
    ],
  };
}

function applyProductFilter(rows: ProductRow[], clause: CommerceFilterClause): ProductRow[] {
  const needle = clause.value.toLowerCase();
  return rows.filter((row) => {
    const haystack = (clause.field === 'handle' ? row.handle : row.title).toLowerCase();
    switch (clause.op) {
      case 'eq':
        return haystack === needle;
      case 'ne':
        return haystack !== needle;
      case 'contains':
        return haystack.includes(needle);
      default:
        return true;
    }
  });
}

export class InMemoryCommerceDataSource implements CommerceDataSource {
  private seed: Seed;
  private listeners = new Set<{ productId: string | null; onChange: () => void }>();

  constructor(seed: Seed = buildSeed()) {
    this.seed = seed;
  }

  // --- mapping helpers (Track B row -> DTO) --------------------------------

  private _mapOption(option: OptionRow): ProductOptionDTO {
    return {
      id: option.id,
      productId: option.productId,
      title: option.title,
      values: this.seed.optionValues
        .filter((v) => v.optionId === option.id)
        .map((v) => ({ id: v.id, optionId: v.optionId, label: v.value })),
    };
  }

  private _mapProduct(product: ProductRow): ProductDTO {
    return {
      id: product.id,
      handle: product.handle,
      title: product.title,
      description: product.description,
      ...(product.taxClass !== null ? { taxClass: product.taxClass } : {}),
      options: this.seed.options
        .filter((o) => o.productId === product.id)
        .map((o) => this._mapOption(o)),
      variantIds: this.seed.variants
        .filter((v) => v.productId === product.id)
        .map((v) => v.id),
    };
  }

  private _mapVariant(variant: VariantRow): ProductVariantDTO {
    const product = this.seed.products.find((p) => p.id === variant.productId) ?? null;
    const resolvedTaxClass = variant.taxClass ?? product?.taxClass ?? null;
    const optionValues: VariantOptionCoordinate[] = this.seed.variantOptions
      .filter((vo) => vo.variantId === variant.id)
      .map((vo) => {
        const value = this.seed.optionValues.find((ov) => ov.id === vo.optionValueId);
        return {
          optionId: vo.optionId,
          valueId: vo.optionValueId,
          label: value?.value ?? '',
        };
      });
    return {
      id: variant.id,
      productId: variant.productId,
      title: variant.title,
      ...(variant.sku !== null ? { sku: variant.sku } : {}),
      ...(variant.barcode !== null ? { barcode: variant.barcode } : {}),
      ...(resolvedTaxClass !== null ? { taxClass: resolvedTaxClass } : {}),
      optionValues,
    };
  }

  // --- reads ---------------------------------------------------------------

  async listProducts(query?: CommerceQuery): Promise<ProductPage> {
    let rows = [...this.seed.products];

    for (const clause of query?.filter ?? []) {
      rows = applyProductFilter(rows, clause);
    }

    for (const sort of query?.sort ?? []) {
      const dir = sort.direction === 'desc' ? -1 : 1;
      rows.sort((a, b) => {
        const av = sort.field === 'handle' ? a.handle : a.title;
        const bv = sort.field === 'handle' ? b.handle : b.title;
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }

    const total = rows.length;
    if (typeof query?.limit === 'number') {
      rows = rows.slice(0, Math.max(0, query.limit));
    }

    return { products: rows.map((p) => this._mapProduct(p)), total };
  }

  async getProduct(productId: string): Promise<ProductDTO | null> {
    const row = this.seed.products.find((p) => p.id === productId);
    return row ? this._mapProduct(row) : null;
  }

  async getProductByHandle(handle: string): Promise<ProductDTO | null> {
    const row = this.seed.products.find((p) => p.handle === handle);
    return row ? this._mapProduct(row) : null;
  }

  async listVariants(productId: string): Promise<ProductVariantDTO[]> {
    return this.seed.variants
      .filter((v) => v.productId === productId)
      .map((v) => this._mapVariant(v));
  }

  async getVariant(variantId: string): Promise<ProductVariantDTO | null> {
    const row = this.seed.variants.find((v) => v.id === variantId);
    return row ? this._mapVariant(row) : null;
  }

  async getPrices(variantId: string): Promise<PriceDTO[]> {
    const variant = this.seed.variants.find((v) => v.id === variantId) ?? null;
    const product = variant
      ? this.seed.products.find((p) => p.id === variant.productId) ?? null
      : null;
    const resolvedTaxClass = variant?.taxClass ?? product?.taxClass ?? null;
    return this.seed.prices
      .filter((price) => price.variantId === variantId)
      .map((price) => ({
        variantId: price.variantId,
        amountCents: price.amount,
        currency: price.currencyCode,
        ...(resolvedTaxClass !== null ? { taxClass: resolvedTaxClass } : {}),
        ...(price.minQuantity !== null ? { minQuantity: price.minQuantity } : {}),
        ...(price.maxQuantity !== null ? { maxQuantity: price.maxQuantity } : {}),
      }));
  }

  async getAvailability(
    variantId: string,
    locationId?: string,
  ): Promise<AvailabilityDTO> {
    // A missing variant is an error, never a silent zero-stock success.
    const variant = this.seed.variants.find((v) => v.id === variantId);
    if (!variant) {
      throw new Error(`getAvailability: no variant with id "${variantId}"`);
    }

    const item = this.seed.inventoryItems.find((i) => i.variantId === variantId);
    const levels = item
      ? this.seed.inventoryLevels.filter((l) => l.inventoryItemId === item.id)
      : [];

    // available_quantity is the GENERATED stocked - reserved column in Track B.
    const availableOf = (l: InventoryLevelRow): number =>
      l.stockedQuantity - l.reservedQuantity;

    if (locationId === undefined) {
      const availableQuantity = levels.reduce((sum, l) => sum + availableOf(l), 0);
      return {
        variantId,
        locationId: ALL_LOCATIONS,
        availableQuantity,
        stale: false,
      };
    }

    const level = levels.find((l) => l.locationId === locationId);
    return {
      variantId,
      locationId,
      // A valid location with no level row legitimately holds zero stock.
      availableQuantity: level ? availableOf(level) : 0,
      stale: false,
    };
  }

  subscribe(productId: string | null, onChange: () => void): () => void {
    const entry = { productId, onChange };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /**
   * Test helper: apply a mutation to the seed and notify every subscriber
   * whose scope (a specific productId, or null for "any product") matches.
   * The live provider replaces this with real polling against Track B.
   */
  _mutate(productId: string | null, fn: (seed: Seed) => void): void {
    fn(this.seed);
    // Snapshot first: a callback may unsubscribe itself mid-iteration.
    for (const entry of [...this.listeners]) {
      if (!this.listeners.has(entry)) continue;
      if (entry.productId === null || productId === null || entry.productId === productId) {
        entry.onChange();
      }
    }
  }
}

// Shared singleton so the storefront and its tests resolve the SAME fixture
// instance across calls (mirrors the "shared" naming in the spec). Tests that
// need isolation construct `new InMemoryCommerceDataSource()` directly.
let shared: InMemoryCommerceDataSource | null = null;

export function getSharedInMemoryCommerceDataSource(): InMemoryCommerceDataSource {
  if (!shared) {
    shared = new InMemoryCommerceDataSource();
  }
  return shared;
}
