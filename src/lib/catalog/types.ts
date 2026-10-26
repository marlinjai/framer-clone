// src/lib/catalog/types.ts
//
// The shapes the catalogue area's API answers (docs/plans/2026-10-25-catalogue-design.md,
// slice 2): what the server repository (src/server/catalog) returns, the
// routes (src/app/api/catalog) send as JSON, and the client (./api.ts) reads.
// Client-safe: types and constants only. Money is integer cents in EUR,
// dates are ISO strings on the wire.

import type { RichText } from '@/server/books/render/richText';

export type ProductKind = 'physical' | 'service';
/** What the table shows: `archived` when archived_at is set, else the stored status. */
export type ProductStatus = 'draft' | 'published' | 'archived';
export type TaxClass = 'standard' | 'reduced' | 'zero';
export type PriceBasis = 'net' | 'gross';
export type StockState = 'in_stock' | 'out_of_stock' | 'untracked';
export type ProductSort = 'updated' | 'title' | 'created' | 'price' | 'stock';
export type SortDirection = 'asc' | 'desc';

/** The one currency the catalogue prices in for now (the Books invoice in euros). */
export const CATALOG_CURRENCY = 'EUR';

/** The most options a product has (020's shape guard, BK017). */
export const MAX_OPTIONS = 3;
/** The most values one option has (bounds the matrix: 3 options of 20 values are 8000 variants at most). */
export const MAX_OPTION_VALUES = 20;
/** The most variants a product's option matrix may produce. */
export const MAX_VARIANTS = 100;

export interface ImageRef {
  sha256: string;
  width: number;
  height: number;
}

export interface CollectionRef {
  id: string;
  title: string;
}

/** The single variant of a product that has one: what the table edits inline. */
export interface InlineVariant {
  id: string;
  sku: string | null;
  /** Cents, or null when no price is set. */
  price: number | null;
  manageInventory: boolean;
  /** Available units, or null when the stock is not tracked. */
  stock: number | null;
}

export interface ProductListItem {
  id: string;
  title: string;
  handle: string;
  kind: ProductKind;
  status: ProductStatus;
  productType: string | null;
  variantCount: number;
  /** The lowest and highest variant price, in cents; null when no variant has a price. */
  priceMin: number | null;
  priceMax: number | null;
  /** Available units summed over the tracked variants; null when no variant is tracked. */
  stock: number | null;
  image: ImageRef | null;
  collections: CollectionRef[];
  /** Set when the product has exactly one live variant. */
  single: InlineVariant | null;
  updatedAt: string;
}

export interface ProductPage {
  items: ProductListItem[];
  nextCursor: string | null;
  total: number;
}

export interface ProductListQuery {
  q?: string;
  status?: ProductStatus | 'all';
  type?: string;
  collection?: string;
  stock?: StockState;
  sort?: ProductSort;
  dir?: SortDirection;
  cursor?: string;
  limit?: number;
}

export interface OptionView {
  id: string;
  title: string;
  values: Array<{ id: string; value: string }>;
}

export interface VariantView {
  id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  compareAt: number | null;
  manageInventory: boolean;
  allowBackorder: boolean;
  /** Available units, or null when not tracked. */
  stock: number | null;
  /** The product image tied to this variant (its link id), or null. */
  imageId: string | null;
  /** The variant's value per option, in the product's option order. */
  values: Array<{ optionId: string; valueId: string }>;
}

export interface ProductImageView extends ImageRef {
  /** The link's id (product_image.id). */
  id: string;
  contentType: string;
  position: number;
  alt: string | null;
  variantId: string | null;
}

export interface ProductDetail {
  id: string;
  title: string;
  handle: string;
  kind: ProductKind;
  status: ProductStatus;
  /** The stored status (draft or published) an unarchive returns to. */
  publishStatus: 'draft' | 'published';
  productType: string | null;
  tags: string[];
  description: string | null;
  descriptionFormat: RichText | null;
  taxClass: TaxClass;
  priceBasis: PriceBasis;
  unitLabel: string;
  discountBp: number;
  seoTitle: string | null;
  seoDescription: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  options: OptionView[];
  variants: VariantView[];
  images: ProductImageView[];
  collections: CollectionRef[];
  hiddenSiteIds: string[];
}

/** One option as the options editor sends it: ids for what exists (a rename keeps its variants), none for new. */
export interface OptionInput {
  id?: string;
  title: string;
  values: Array<{ id?: string; value: string }>;
}

export interface CollectionView {
  id: string;
  title: string;
  handle: string;
  description: string | null;
  descriptionFormat: RichText | null;
  image: ImageRef | null;
  archivedAt: string | null;
  productCount: number;
  updatedAt: string;
}

export interface CollectionDetail extends CollectionView {
  products: Array<{ id: string; title: string; status: ProductStatus; image: ImageRef | null }>;
}

export interface SiteView {
  id: string;
  name: string;
}

export const STATUS_LABELS: Record<ProductStatus, string> = {
  draft: 'Draft',
  published: 'Published',
  archived: 'Archived',
};

export const TAX_CLASS_LABELS: Record<TaxClass, string> = {
  standard: 'Standard rate',
  reduced: 'Reduced rate',
  zero: 'Zero rate',
};
