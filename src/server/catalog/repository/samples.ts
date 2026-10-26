// src/server/catalog/repository/samples.ts
//
// "Add sample products" on the empty catalogue: three invented products of a
// small jewellery shop (the design's first proof company), so a person sees
// the table and the panel with something in them. One of each shape: a ring
// with two options (six variants, prices and stock), a necklace with one
// variant, and a service. All three are drafts, so nothing appears on a shop
// until someone publishes it.
//
// Idempotent by handle: a sample whose handle the company already uses (live
// or archived) is left as it is, so a second click adds nothing; two clicks at
// once both create through the exact handle, and the one that loses the unique
// index answers the winner's product instead of failing.

import type { ProductDetail } from '@/lib/catalog/types';

import { isCatalogError } from '../errors';
import type { CatalogScope } from '../scope';
import { createProduct, getProduct, updateProduct } from './products';
import { setVariantStock } from './stock';
import { setOptions, updateVariant } from './variants';

interface Sample {
  handle: string;
  title: string;
  kind: 'physical' | 'service';
  productType: string;
  tags: string[];
  description: string;
  price: number;
  options?: Array<{ title: string; values: string[] }>;
  /** Price per variant title (when it differs from `price`), and stock per variant title or for the single variant. */
  prices?: Record<string, number>;
  stock?: number | Record<string, number>;
}

const SAMPLES: Sample[] = [
  {
    handle: 'stacking-ring',
    title: 'Stacking ring',
    kind: 'physical',
    productType: 'Ring',
    tags: ['rings', 'bestseller'],
    description: 'A slim band to wear alone or stacked. Hand polished.',
    price: 4900,
    options: [
      { title: 'Size', values: ['52', '54', '56'] },
      { title: 'Metal', values: ['Silver', 'Gold'] },
    ],
    prices: { '52 / Gold': 8900, '54 / Gold': 8900, '56 / Gold': 8900 },
    stock: { '52 / Silver': 4, '54 / Silver': 7, '56 / Silver': 2, '52 / Gold': 1, '54 / Gold': 3, '56 / Gold': 0 },
  },
  {
    handle: 'pearl-necklace',
    title: 'Pearl necklace',
    kind: 'physical',
    productType: 'Necklace',
    tags: ['necklaces'],
    description: 'Freshwater pearls on a silver chain, 45 cm.',
    price: 12900,
    stock: 5,
  },
  {
    handle: 'ring-sizing',
    title: 'Ring sizing',
    kind: 'service',
    productType: 'Service',
    tags: ['services'],
    description: 'We resize a ring you bought from us, within one week.',
    price: 2500,
  },
];

/** Add the sample products the company does not have yet; answers the three as they are now. */
export async function addSampleProducts(scope: CatalogScope): Promise<ProductDetail[]> {
  const existing = await scope.db
    .selectFrom('product')
    .select(['id', 'handle'])
    .where('tenant_id', '=', scope.tenantId)
    .where('deleted_at', 'is', null)
    .where(
      'handle',
      'in',
      SAMPLES.map((s) => s.handle),
    )
    .execute();
  const idOf = new Map(existing.map((r) => [r.handle, r.id]));
  const out: ProductDetail[] = [];
  for (const sample of SAMPLES) {
    const known = idOf.get(sample.handle);
    if (known) {
      out.push(await getProduct(scope, known));
      continue;
    }
    let product: ProductDetail;
    try {
      product = await createProduct(scope, {
        title: sample.title,
        handle: sample.handle,
        kind: sample.kind,
        productType: sample.productType,
        price: sample.price,
      });
    } catch (err) {
      if (!isCatalogError(err, 'DUPLICATE_HANDLE')) throw err;
      const winner = await scope.db
        .selectFrom('product')
        .select('id')
        .where('tenant_id', '=', scope.tenantId)
        .where('handle', '=', sample.handle)
        .where('deleted_at', 'is', null)
        .executeTakeFirstOrThrow();
      out.push(await getProduct(scope, winner.id));
      continue;
    }
    product = await updateProduct(scope, product.id, {
      tags: sample.tags,
      description: sample.description,
      taxClass: 'standard',
      seoDescription: sample.description,
    });
    if (sample.options) {
      product = await setOptions(
        scope,
        product.id,
        sample.options.map((o) => ({ title: o.title, values: o.values.map((value) => ({ value })) })),
      );
      for (const v of product.variants) {
        const price = v.title ? sample.prices?.[v.title] : undefined;
        if (price !== undefined) product = await updateVariant(scope, product.id, v.id, { price });
      }
    }
    if (sample.stock !== undefined) {
      for (const v of product.variants) {
        const units = typeof sample.stock === 'number' ? sample.stock : sample.stock[v.title ?? ''];
        if (units !== undefined && v.manageInventory && v.sku) product = await setVariantStock(scope, product.id, v.id, units);
      }
    }
    out.push(product);
  }
  return out;
}
