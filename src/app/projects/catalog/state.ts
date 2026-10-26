// src/app/projects/catalog/state.ts
//
// The catalogue table's state that outlives one render: the search and the
// filters kept in the address (so a reload, a shared link or the browser's
// back button shows the same list), and the columns a person shows, hides and
// orders, kept per browser in localStorage. Storage can be missing or refuse
// (a private window, blocked site data, a sandboxed frame): every read and
// write is wrapped, and the table then simply uses the default columns.
// Client-safe and pure apart from the storage access, so it is unit-tested.

import { money } from '@/lib/books/units';
import type { ProductSort, ProductStatus, SortDirection, StockState } from '@/lib/catalog/types';

export interface Filters {
  q: string;
  status: ProductStatus | 'all' | '';
  type: string;
  collection: string;
  stock: StockState | '';
  sort: ProductSort;
  dir: SortDirection | '';
}

export const EMPTY_FILTERS: Filters = { q: '', status: '', type: '', collection: '', stock: '', sort: 'updated', dir: '' };

const STATUSES = new Set(['draft', 'published', 'archived', 'all']);
const STOCKS = new Set(['in_stock', 'out_of_stock', 'untracked']);
const SORTS = new Set(['updated', 'title', 'created', 'price', 'stock']);

/** The filters an address names; anything unknown falls back to the default. */
export function filtersFrom(params: URLSearchParams): Filters {
  const pick = (key: string, allowed: Set<string>) => {
    const v = params.get(key) ?? '';
    return allowed.has(v) ? v : '';
  };
  return {
    q: (params.get('q') ?? '').slice(0, 100),
    status: pick('status', STATUSES) as Filters['status'],
    type: (params.get('type') ?? '').slice(0, 100),
    collection: (params.get('collection') ?? '').slice(0, 100),
    stock: pick('stock', STOCKS) as Filters['stock'],
    sort: (pick('sort', SORTS) || 'updated') as ProductSort,
    dir: (params.get('dir') === 'asc' || params.get('dir') === 'desc' ? params.get('dir') : '') as Filters['dir'],
  };
}

/** The address query of these filters (defaults left out), keeping the other parameters (the tab, the open product). */
export function queryWith(base: URLSearchParams, filters: Filters): string {
  const params = new URLSearchParams(base);
  for (const key of ['q', 'status', 'type', 'collection', 'stock', 'sort', 'dir'] as const) params.delete(key);
  if (filters.q.trim()) params.set('q', filters.q.trim());
  if (filters.status) params.set('status', filters.status);
  if (filters.type) params.set('type', filters.type);
  if (filters.collection) params.set('collection', filters.collection);
  if (filters.stock) params.set('stock', filters.stock);
  if (filters.sort !== 'updated') params.set('sort', filters.sort);
  if (filters.dir) params.set('dir', filters.dir);
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** True when anything narrows the list (the empty state then says "nothing matches" instead of "no products yet"). */
export function isFiltered(f: Filters): boolean {
  return f.q.trim() !== '' || f.status !== '' || f.type !== '' || f.collection !== '' || f.stock !== '';
}

// --- columns ------------------------------------------------------------------

export type ColumnId = 'photo' | 'status' | 'variants' | 'price' | 'stock' | 'type' | 'collections' | 'updated';

export const COLUMNS: Record<ColumnId, { label: string; sort?: ProductSort }> = {
  photo: { label: 'Photo' },
  status: { label: 'Status' },
  variants: { label: 'Variants' },
  price: { label: 'Price', sort: 'price' },
  stock: { label: 'Stock', sort: 'stock' },
  type: { label: 'Type' },
  collections: { label: 'Collections' },
  updated: { label: 'Updated', sort: 'updated' },
};

export const DEFAULT_COLUMNS: ColumnId[] = ['photo', 'status', 'variants', 'price', 'stock', 'type', 'collections'];
export const ALL_COLUMNS = Object.keys(COLUMNS) as ColumnId[];

/** The localStorage key of a person's columns (per user, so two people on one browser keep their own). */
export function columnsKey(userKey: string): string {
  return `catalog.columns.v1.${userKey}`;
}

/** The shown columns in order, from storage; the defaults when there is nothing usable. */
export function loadColumns(key: string, storage: () => Storage | null = () => window.localStorage): ColumnId[] {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return DEFAULT_COLUMNS;
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return DEFAULT_COLUMNS;
    const known = value.filter((v): v is ColumnId => typeof v === 'string' && v in COLUMNS);
    return [...new Set(known)];
  } catch {
    return DEFAULT_COLUMNS;
  }
}

/** Keep the shown columns; a storage that refuses is not an error the person can act on, so it is ignored. */
export function saveColumns(key: string, columns: ColumnId[], storage: () => Storage | null = () => window.localStorage): void {
  try {
    storage()?.setItem(key, JSON.stringify(columns));
  } catch {
    // Remembering the columns is a convenience; the table works with them for this visit.
  }
}

/** Move a shown column one place left (-1) or right (+1). */
export function moveColumn(columns: ColumnId[], id: ColumnId, by: -1 | 1): ColumnId[] {
  const i = columns.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= columns.length) return columns;
  const next = [...columns];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Show or hide a column (a shown column is appended at the end). */
export function toggleColumn(columns: ColumnId[], id: ColumnId): ColumnId[] {
  return columns.includes(id) ? columns.filter((c) => c !== id) : [...columns, id];
}

// --- figures --------------------------------------------------------------------

/** "49,00 €", "49,00 € to 89,00 €", or "No price" when no variant has one. */
export function priceRange(min: number | null, max: number | null): string {
  if (min === null) return 'No price';
  if (max === null || max === min) return money(min);
  return `${money(min)} to ${money(max)}`;
}
