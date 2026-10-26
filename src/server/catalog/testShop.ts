// src/server/catalog/testShop.ts
//
// The catalogue of the owner's test jewellery shop, "Schmuck Testshop" (docs/plans/2026-10-25-catalogue-
// design.md, "The test jewellery company"; slice 6): rings with size and metal options, necklaces,
// earrings, a service, one archived product, and two collections. Everything is invented and marked as
// test data in its description. Published, so the shop's site shows it at once (the archived one never).
//
// Idempotent by handle: a product or collection the company already has (live or archived) is left as it
// is, so the seed can run again after a partial run or after the owner changed something by hand.

import type { ProductDetail } from '@/lib/catalog/types';

import { createCollection, listCollections, setCollectionProducts, updateCollection } from './repository/collections';
import { createProduct, getProduct, setArchived, updateProduct } from './repository/products';
import { setVariantStock } from './repository/stock';
import { setOptions, updateVariant } from './repository/variants';
import type { CatalogScope } from './scope';

const TEST_NOTE = 'Testdaten des Schmuck Testshops, kein echtes Angebot.';

interface ShopProduct {
  handle: string;
  title: string;
  kind: 'physical' | 'service';
  productType: string;
  tags: string[];
  description: string;
  /** Gross price in cents (a shop shows consumer prices). */
  price: number;
  options?: Array<{ title: string; values: string[] }>;
  /** Price per variant title where it differs from `price`. */
  prices?: Record<string, number>;
  /** Stock for the single variant, or per variant title. */
  stock?: number | Record<string, number>;
  archived?: boolean;
}

export const TEST_SHOP_PRODUCTS: readonly ShopProduct[] = [
  {
    handle: 'stapelring',
    title: 'Stapelring',
    kind: 'physical',
    productType: 'Ring',
    tags: ['ringe'],
    description: 'Ein schmaler Ring zum Kombinieren, handpoliert.',
    price: 4900,
    options: [
      { title: 'Größe', values: ['52', '54', '56', '58'] },
      { title: 'Metall', values: ['Silber', 'Gold'] },
    ],
    prices: { '52 / Gold': 8900, '54 / Gold': 8900, '56 / Gold': 8900, '58 / Gold': 8900 },
    stock: { '52 / Silber': 4, '54 / Silber': 6, '56 / Silber': 3, '58 / Silber': 1, '52 / Gold': 2, '54 / Gold': 2, '56 / Gold': 1, '58 / Gold': 0 },
  },
  {
    handle: 'siegelring',
    title: 'Siegelring',
    kind: 'physical',
    productType: 'Ring',
    tags: ['ringe'],
    description: 'Ein klassischer Siegelring mit glatter Platte für eine Gravur.',
    price: 15900,
    options: [
      { title: 'Größe', values: ['56', '60', '64'] },
      { title: 'Metall', values: ['Silber', 'Gold'] },
    ],
    prices: { '56 / Gold': 34900, '60 / Gold': 34900, '64 / Gold': 34900 },
    stock: { '56 / Silber': 2, '60 / Silber': 2, '64 / Silber': 1, '56 / Gold': 1, '60 / Gold': 1, '64 / Gold': 1 },
  },
  {
    handle: 'perlenkette',
    title: 'Perlenkette',
    kind: 'physical',
    productType: 'Kette',
    tags: ['ketten'],
    description: 'Süßwasserperlen an einer Silberkette, 45 cm.',
    price: 12900,
    stock: 5,
  },
  {
    handle: 'gliederkette',
    title: 'Gliederkette',
    kind: 'physical',
    productType: 'Kette',
    tags: ['ketten'],
    description: 'Eine feine Gliederkette aus Silber.',
    price: 5900,
    options: [{ title: 'Länge', values: ['40 cm', '45 cm', '50 cm'] }],
    stock: { '40 cm': 3, '45 cm': 5, '50 cm': 2 },
  },
  {
    handle: 'creolen',
    title: 'Creolen',
    kind: 'physical',
    productType: 'Ohrringe',
    tags: ['ohrringe'],
    description: 'Leichte Creolen, 20 mm.',
    price: 3900,
    options: [{ title: 'Metall', values: ['Silber', 'Gold'] }],
    prices: { Gold: 6900 },
    stock: { Silber: 8, Gold: 4 },
  },
  {
    handle: 'ohrstecker-perle',
    title: 'Ohrstecker Perle',
    kind: 'physical',
    productType: 'Ohrringe',
    tags: ['ohrringe'],
    description: 'Kleine Perlen auf Silberstiften.',
    price: 2900,
    stock: 10,
  },
  {
    handle: 'ringgroesse-anpassen',
    title: 'Ringgröße anpassen',
    kind: 'service',
    productType: 'Service',
    tags: ['service'],
    description: 'Wir passen einen bei uns gekauften Ring innerhalb einer Woche an.',
    price: 2500,
  },
  {
    handle: 'brosche-vintage',
    title: 'Brosche Vintage',
    kind: 'physical',
    productType: 'Brosche',
    tags: ['broschen'],
    description: 'Eine Einzelstück-Brosche, nicht mehr im Angebot.',
    price: 7900,
    stock: 0,
    archived: true,
  },
];

export const TEST_SHOP_COLLECTIONS: ReadonlyArray<{ handle: string; title: string; products: string[] }> = [
  { handle: 'ringe', title: 'Ringe', products: ['stapelring', 'siegelring'] },
  { handle: 'geschenke-unter-100', title: 'Geschenke unter 100 Euro', products: ['stapelring', 'gliederkette', 'creolen', 'ohrstecker-perle'] },
];

async function existingByHandle(scope: CatalogScope, handle: string): Promise<string | null> {
  const row = await scope.db
    .selectFrom('product')
    .select('id')
    .where('tenant_id', '=', scope.tenantId)
    .where('handle', '=', handle)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row?.id ?? null;
}

async function seedProduct(scope: CatalogScope, spec: ShopProduct): Promise<{ product: ProductDetail; created: boolean }> {
  const known = await existingByHandle(scope, spec.handle);
  if (known) return { product: await getProduct(scope, known), created: false };

  let product = await createProduct(scope, {
    title: spec.title,
    handle: spec.handle,
    kind: spec.kind,
    productType: spec.productType,
    price: spec.price,
  });
  product = await updateProduct(scope, product.id, {
    tags: spec.tags,
    description: `${spec.description} ${TEST_NOTE}`,
    taxClass: 'standard',
    priceBasis: 'gross',
    seoDescription: spec.description,
    status: spec.archived ? 'draft' : 'published',
  });
  if (spec.options) {
    product = await setOptions(
      scope,
      product.id,
      spec.options.map((o) => ({ title: o.title, values: o.values.map((value) => ({ value })) })),
    );
    for (const v of product.variants) {
      const price = v.title ? spec.prices?.[v.title] : undefined;
      if (price !== undefined) product = await updateVariant(scope, product.id, v.id, { price });
    }
  }
  if (spec.stock !== undefined) {
    for (const v of product.variants) {
      const units = typeof spec.stock === 'number' ? spec.stock : spec.stock[v.title ?? ''];
      if (units !== undefined && v.manageInventory && v.sku) product = await setVariantStock(scope, product.id, v.id, units);
    }
  }
  if (spec.archived) product = await setArchived(scope, product.id, true);
  return { product, created: true };
}

export interface TestShopResult {
  productsCreated: number;
  productsKept: number;
  collectionsCreated: number;
}

/** Seed the test shop's catalogue for the scope's company (idempotent by handle). */
export async function seedTestShop(scope: CatalogScope): Promise<TestShopResult> {
  const result: TestShopResult = { productsCreated: 0, productsKept: 0, collectionsCreated: 0 };
  const idByHandle = new Map<string, string>();
  for (const spec of TEST_SHOP_PRODUCTS) {
    const { product, created } = await seedProduct(scope, spec);
    idByHandle.set(spec.handle, product.id);
    if (created) result.productsCreated += 1;
    else result.productsKept += 1;
  }
  const collections = await listCollections(scope, { includeArchived: true });
  for (const spec of TEST_SHOP_COLLECTIONS) {
    if (collections.some((c) => c.handle === spec.handle)) continue;
    const collection = await createCollection(scope, { title: spec.title });
    if (collection.handle !== spec.handle) await updateCollection(scope, collection.id, { handle: spec.handle });
    await setCollectionProducts(
      scope,
      collection.id,
      spec.products.map((handle) => idByHandle.get(handle)).filter((id): id is string => Boolean(id)),
    );
    result.collectionsCreated += 1;
  }
  return result;
}
