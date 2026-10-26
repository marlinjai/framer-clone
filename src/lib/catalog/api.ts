// src/lib/catalog/api.ts
//
// The catalogue area's client for /api/catalog/* (catalogue design, slice 2).
// Client-safe: plain fetch, no server imports. Every call answers the parsed
// body or a CatalogApiError carrying the server's code and a sentence a person
// can act on, so no screen ever shows a bare status number or swallows a
// failure.

import type { RichText } from '@/server/books/render/richText';

import type {
  CollectionDetail,
  CollectionView,
  OptionInput,
  ProductDetail,
  ProductListQuery,
  ProductPage,
  SiteView,
} from './types';

export class CatalogApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CatalogApiError';
  }
}

/** What the screens say for the codes whose server sentence is written for developers. */
const MESSAGES: Record<string, string> = {
  unauthorized: 'Your session has ended. Sign in again to keep working.',
  sites_not_enabled: 'Lumitra Sites is not enabled for this company, and the catalogue comes with it.',
  no_active_company: 'Choose a company on the projects page first.',
  forbidden: 'You can look at this catalogue but not change it. Ask an administrator of the company for edit rights.',
  catalog_not_provisioned: 'The shop database of this company is not set up yet. Open a site of the company once, then come back.',
  auth_unavailable: 'The sign-in service is not answering. Try again in a moment.',
  authz_unavailable: 'The permission service is not answering. Try again in a moment.',
  catalog_failed: 'The request failed on the server; nothing was changed. Try again.',
};

/** Where an image of the company is served (its hash is the ETag). */
export function imageUrl(sha256: string): string {
  return `/api/catalog/images/${sha256}`;
}

async function send<T>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: raw ? { 'content-type': raw.type || 'application/octet-stream' } : body === undefined ? undefined : { 'content-type': 'application/json' },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
      cache: 'no-store',
    });
  } catch {
    throw new CatalogApiError(0, 'network', 'The server could not be reached. Check your connection and try again.');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // a non-JSON answer is reported by its status below
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; [k: string]: unknown } } | null)?.error;
    const code = err?.code ?? `http_${res.status}`;
    throw new CatalogApiError(res.status, code, MESSAGES[code] ?? err?.message ?? `The request failed (${res.status}).`, err ?? {});
  }
  return json as T;
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** The product fields the panel saves one at a time. */
export interface ProductPatch {
  title?: string;
  handle?: string;
  kind?: 'physical' | 'service';
  status?: 'draft' | 'published' | 'archived';
  productType?: string | null;
  tags?: string[];
  description?: string | null;
  descriptionFormat?: RichText | null;
  taxClass?: 'standard' | 'reduced' | 'zero';
  priceBasis?: 'net' | 'gross';
  unitLabel?: string;
  discountBp?: number;
  seoTitle?: string | null;
  seoDescription?: string | null;
}

export interface VariantPatch {
  sku?: string | null;
  barcode?: string | null;
  price?: number | null;
  compareAt?: number | null;
  manageInventory?: boolean;
  allowBackorder?: boolean;
  imageId?: string | null;
}

export type BulkAction =
  | { action: 'status'; ids: string[]; status: 'draft' | 'published' }
  | { action: 'archive' | 'unarchive'; ids: string[] }
  | { action: 'addToCollection'; ids: string[]; collectionId: string };

const p = (id: string) => `/api/catalog/products/${encodeURIComponent(id)}`;
const c = (id: string) => `/api/catalog/collections/${encodeURIComponent(id)}`;

export const catalogApi = {
  products: (q: ProductListQuery = {}) => send<ProductPage>('GET', `/api/catalog/products${query({ ...q })}`),
  meta: () => send<{ sites: SiteView[]; productTypes: string[] }>('GET', '/api/catalog/meta'),
  createProduct: (input: { title: string; kind?: 'physical' | 'service'; price?: number | null }) =>
    send<ProductDetail>('POST', '/api/catalog/products', input),
  addSamples: () => send<{ items: ProductDetail[] }>('POST', '/api/catalog/products/samples'),
  bulk: (action: BulkAction) => send<{ changed: number }>('POST', '/api/catalog/products/bulk', action),
  product: (id: string) => send<ProductDetail>('GET', p(id)),
  updateProduct: (id: string, patch: ProductPatch) => send<ProductDetail>('PATCH', p(id), patch),
  setArchived: (id: string, archived: boolean) => send<ProductDetail>('PATCH', p(id), { archived }),
  setInlinePrice: (id: string, price: number | null) => send<ProductDetail>('PATCH', p(id), { price }),
  setOptions: (id: string, options: OptionInput[]) => send<ProductDetail>('PUT', `${p(id)}/options`, { options }),
  updateVariant: (id: string, variantId: string, patch: VariantPatch) =>
    send<ProductDetail>('PATCH', `${p(id)}/variants/${encodeURIComponent(variantId)}`, patch),
  setStock: (id: string, variantId: string, available: number) =>
    send<ProductDetail>('PUT', `${p(id)}/variants/${encodeURIComponent(variantId)}/stock`, { available }),
  addImage: (id: string, file: Blob) => send<ProductDetail>('POST', `${p(id)}/images`, undefined, file),
  reorderImages: (id: string, imageIds: string[]) => send<ProductDetail>('PUT', `${p(id)}/images`, { imageIds }),
  setImageAlt: (id: string, imageId: string, alt: string | null) =>
    send<ProductDetail>('PATCH', `${p(id)}/images/${encodeURIComponent(imageId)}`, { alt }),
  removeImage: (id: string, imageId: string) => send<ProductDetail>('DELETE', `${p(id)}/images/${encodeURIComponent(imageId)}`),
  setProductCollections: (id: string, collectionIds: string[]) => send<ProductDetail>('PUT', `${p(id)}/collections`, { collectionIds }),
  setHiddenSites: (id: string, hiddenSiteIds: string[]) => send<ProductDetail>('PUT', `${p(id)}/sites`, { hiddenSiteIds }),
  storeImage: (file: Blob) => send<{ sha256: string; width: number; height: number; contentType: string }>('POST', '/api/catalog/images', undefined, file),
  collections: (includeArchived = false) =>
    send<{ items: CollectionView[] }>('GET', `/api/catalog/collections${includeArchived ? '?includeArchived=1' : ''}`),
  collection: (id: string) => send<CollectionDetail>('GET', c(id)),
  createCollection: (title: string) => send<CollectionDetail>('POST', '/api/catalog/collections', { title }),
  updateCollection: (
    id: string,
    patch: { title?: string; handle?: string; description?: string | null; descriptionFormat?: RichText | null; imageSha256?: string | null; archived?: boolean },
  ) => send<CollectionDetail>('PATCH', c(id), patch),
  setCollectionProducts: (id: string, productIds: string[]) => send<CollectionDetail>('PUT', `${c(id)}/products`, { productIds }),
};
