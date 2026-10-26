'use client';

// src/app/projects/catalog/ProductTable.tsx
//
// The catalogue's product table (catalogue design, "The screens: Table"):
// photo, title, status, variants, price range, stock, type and collections;
// search and filters (status, type, collection, stock state) kept in the
// address by the parent; sorting by a column header; row selection with bulk
// status, add to collection, archive and unarchive; inline edits of price and
// stock for a product with one variant and of every product's status; the
// columns shown, hidden and ordered per person (state.ts).
//
// PAGED, NOT VIRTUALISED (decided while building slice 2): the server answers
// 50 rows a page with a keyset cursor, and the table shows one page at a time
// with Previous and Next (the cursors of the pages already seen are kept, so
// Previous is exact). A windowed list unmounts the rows scrolled away, which
// loses an inline edit in progress and the keyboard focus; one page of 50 keeps
// the document small and every row editable, and a catalogue of thousands is
// searched and filtered, not scrolled.
//
// Every failure is shown with the server's sentence: a list that cannot load
// offers a retry, an inline edit that is refused shows why under the cell and
// keeps the stored value, a bulk action that is refused changes nothing.

import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3, Search, X } from 'lucide-react';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { moneyInput, parseMoney } from '@/lib/books/units';
import { CatalogApiError, catalogApi, type BulkAction } from '@/lib/catalog/api';
import type { CollectionView, ProductListItem, ProductPage, ProductSort, ProductStatus } from '@/lib/catalog/types';
import { cn } from '@/lib/utils';

import {
  ALL_COLUMNS,
  COLUMNS,
  columnsKey,
  isFiltered,
  loadColumns,
  moveColumn,
  priceRange,
  saveColumns,
  toggleColumn,
  type ColumnId,
  type Filters,
} from './state';
import { ErrorAlert, INPUT, StatusPill, Thumb, errorText } from './ui';

export const PAGE_SIZE = 50;

/** Codes that block the whole area (the parent shows a page instead of the table). */
export const BLOCKING = new Set(['unauthorized', 'sites_not_enabled', 'no_active_company', 'forbidden', 'catalog_not_provisioned']);

const STATUS_OPTIONS: ReadonlyArray<{ value: Filters['status']; label: string }> = [
  { value: '', label: 'Active' },
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
  { value: 'all', label: 'All' },
];

const STOCK_OPTIONS: ReadonlyArray<{ value: Filters['stock']; label: string }> = [
  { value: '', label: 'Any stock' },
  { value: 'in_stock', label: 'In stock' },
  { value: 'out_of_stock', label: 'Out of stock' },
  { value: 'untracked', label: 'Not tracked' },
];

/** Why a product's stock cannot be edited in the table, or null when it can. */
export function stockLockReason(p: ProductListItem): string | null {
  if (!p.single) return 'Several variants: set the stock per variant in the panel';
  if (!p.single.manageInventory) return p.kind === 'service' ? 'A service has no stock' : 'Stock is not tracked for this product';
  if (!p.single.sku) return 'Add a SKU in the panel to track stock';
  return null;
}

/** Why a product's price cannot be edited in the table, or null when it can. */
export function priceLockReason(p: ProductListItem): string | null {
  return p.single ? null : 'Several variants: set their prices in the panel';
}

/**
 * A figure that turns into a field when pressed: Enter or leaving saves, Escape
 * cancels; a refused save shows the reason under it. A locked cell says why.
 */
function InlineEdit({
  label,
  display,
  initial,
  parse,
  onSave,
  lockReason,
  align = 'right',
}: {
  label: string;
  display: React.ReactNode;
  initial: string;
  parse: (text: string) => { ok: true; value: number | null } | { ok: false; message: string };
  onSave: (value: number | null) => Promise<void>;
  lockReason: string | null;
  align?: 'left' | 'right';
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  if (lockReason) {
    return (
      <span className={cn('block text-sm tabular-nums text-muted-foreground', align === 'right' && 'text-right')} title={lockReason}>
        {display}
        <span className="sr-only"> ({lockReason})</span>
      </span>
    );
  }

  async function commit() {
    if (text === initial) {
      setEditing(false);
      setError(null);
      return;
    }
    const parsed = parse(text);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setSaving(true);
    try {
      await onSave(parsed.value);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className={cn('flex flex-col gap-0.5', align === 'right' ? 'items-end' : 'items-start')}>
      {editing ? (
        <input
          ref={input}
          aria-label={label}
          value={text}
          disabled={saving}
          inputMode="decimal"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            } else if (e.key === 'Escape') {
              setText(initial);
              setError(null);
              setEditing(false);
            }
          }}
          className={cn(INPUT, 'h-8 w-24 text-right tabular-nums')}
        />
      ) : (
        <button
          type="button"
          aria-label={`${label}: edit`}
          onClick={() => {
            setText(initial);
            setEditing(true);
          }}
          className="rounded-md px-1.5 py-0.5 text-sm tabular-nums transition-colors duration-150 hover:bg-foreground/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {display}
        </button>
      )}
      {error ? (
        <span id={`${id}-error`} role="alert" className="max-w-48 text-right text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function parsePrice(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  if (text.trim() === '') return { ok: true, value: null };
  const cents = parseMoney(text);
  if (cents === null || cents < 0) return { ok: false, message: 'Enter an amount such as 49,00' };
  return { ok: true, value: cents };
}

function parseStock(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { ok: false, message: 'Enter whole units, 0 or more' };
  return { ok: true, value: Number(t) };
}

/** The column chooser: show or hide each column and move the shown ones. */
function ColumnMenu({ columns, onChange }: { columns: ColumnId[]; onChange: (next: ColumnId[]) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const ordered = [...columns, ...ALL_COLUMNS.filter((c) => !columns.includes(c))];
  return (
    <div ref={wrap} className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      >
        <Columns3 aria-hidden /> Columns
      </Button>
      {open ? (
        <div
          role="group"
          aria-label="Columns shown"
          onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
          className="glass absolute right-0 z-30 mt-2 w-64 rounded-xl p-2"
        >
          <ul className="flex flex-col gap-0.5">
            {ordered.map((id) => {
              const shown = columns.includes(id);
              const i = columns.indexOf(id);
              return (
                <li key={id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-foreground/[0.04]">
                  <label className="flex flex-1 items-center gap-2">
                    <input type="checkbox" checked={shown} onChange={() => onChange(toggleColumn(columns, id))} />
                    {COLUMNS[id].label}
                  </label>
                  {shown ? (
                    <span className="flex gap-0.5">
                      <button
                        type="button"
                        aria-label={`Move ${COLUMNS[id].label} left`}
                        disabled={i === 0}
                        onClick={() => onChange(moveColumn(columns, id, -1))}
                        className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowUp aria-hidden className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${COLUMNS[id].label} right`}
                        disabled={i === columns.length - 1}
                        onClick={() => onChange(moveColumn(columns, id, 1))}
                        className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowDown aria-hidden className="size-3.5" />
                      </button>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-muted-foreground">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className={cn(INPUT, 'h-8 w-auto min-w-28 pr-7')}>
        {options.map((o) => (
          <option key={o.value || 'any'} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface ProductTableProps {
  filters: Filters;
  onFilters: (next: Filters) => void;
  collections: CollectionView[];
  productTypes: string[];
  /** Who is looking (their columns are kept apart from another person's on the same browser). */
  userKey: string;
  /** Bumped by the parent after a change elsewhere (the panel) so the table reads again. */
  reloadKey: number;
  /** The product whose panel is open (its row is marked). */
  openId: string | null;
  onOpen: (id: string) => void;
  onBlocked: (err: CatalogApiError) => void;
  onAddProduct: () => void;
  /** Called after a change made here, so the parent can refresh the panel. */
  onChanged: () => void;
}

export default function ProductTable({
  filters,
  onFilters,
  collections,
  productTypes,
  userKey,
  reloadKey,
  openId,
  onOpen,
  onBlocked,
  onAddProduct,
  onChanged,
}: ProductTableProps) {
  const [page, setPage] = useState<ProductPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // The cursors of the pages seen so far: cursors[i] opens page i (page 0 has none).
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState(filters.q);
  const [columns, setColumns] = useState<ColumnId[]>(() => loadColumns(columnsKey(userKey)));
  const [ownReload, setOwnReload] = useState(0);
  const [bulkCollection, setBulkCollection] = useState('');

  const filterKey = JSON.stringify(filters);
  // New filters start again from the first page with nothing selected.
  useEffect(() => {
    setCursors([undefined]);
    setPageIndex(0);
    setSelected(new Set());
  }, [filterKey]);

  useEffect(() => {
    setSearch(filters.q);
  }, [filters.q]);
  // The typed search applies after a short pause.
  useEffect(() => {
    if (search === filters.q) return;
    const t = setTimeout(() => onFilters({ ...filters, q: search }), 300);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const cursor = cursors[pageIndex];
  useEffect(() => {
    let live = true;
    setLoading(true);
    catalogApi
      .products({
        q: filters.q || undefined,
        status: filters.status || undefined,
        type: filters.type || undefined,
        collection: filters.collection || undefined,
        stock: filters.stock || undefined,
        sort: filters.sort,
        dir: filters.dir || undefined,
        cursor,
        limit: PAGE_SIZE,
      })
      .then(
        (p) => {
          if (!live) return;
          setPage(p);
          setLoadError(null);
          setCursors((cs) => {
            const next = cs.slice(0, pageIndex + 1);
            next[pageIndex + 1] = p.nextCursor ?? undefined;
            return p.nextCursor ? next : next.slice(0, pageIndex + 1);
          });
        },
        (err) => {
          if (!live) return;
          if (err instanceof CatalogApiError && BLOCKING.has(err.code)) onBlocked(err);
          else if (err instanceof CatalogApiError && err.code === 'invalid_input' && cursor) {
            // A stale cursor (the sort changed under it): start from the first page.
            setCursors([undefined]);
            setPageIndex(0);
          } else setLoadError(errorText(err));
        },
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [filterKey, cursor, pageIndex, reloadKey, ownReload]); // eslint-disable-line react-hooks/exhaustive-deps

  const reload = useCallback(() => setOwnReload((n) => n + 1), []);

  function setCols(next: ColumnId[]) {
    setColumns(next);
    saveColumns(columnsKey(userKey), next);
  }

  function sortBy(sort: ProductSort) {
    const defaultDir = sort === 'title' || sort === 'price' || sort === 'stock' ? 'asc' : 'desc';
    const currentDir = filters.dir || (filters.sort === 'title' || filters.sort === 'price' || filters.sort === 'stock' ? 'asc' : 'desc');
    const dir = filters.sort === sort ? (currentDir === 'asc' ? 'desc' : 'asc') : defaultDir;
    onFilters({ ...filters, sort, dir: dir === defaultDir ? '' : dir });
  }

  async function runBulk(action: BulkAction, done: string) {
    setBusy(true);
    setError(null);
    try {
      await catalogApi.bulk(action);
      setSelected(new Set());
      reload();
      onChanged();
      announce(done);
    } catch (err) {
      if (err instanceof CatalogApiError && BLOCKING.has(err.code)) onBlocked(err);
      else setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const statusRef = useRef<HTMLParagraphElement>(null);
  function announce(text: string) {
    if (statusRef.current) statusRef.current.textContent = text;
  }

  const items = page?.items ?? [];
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.id));
  const ids = [...selected];
  const filtered = isFiltered(filters);
  const dirOf = (sort: ProductSort) =>
    filters.sort !== sort ? null : filters.dir || (sort === 'title' || sort === 'price' || sort === 'stock' ? 'asc' : 'desc');

  const collectionOptions = useMemo(
    () => [{ value: '', label: 'Any collection' }, ...collections.map((c) => ({ value: c.id, label: c.title }))],
    [collections],
  );
  const typeOptions = useMemo(() => [{ value: '', label: 'Any type' }, ...productTypes.map((t) => ({ value: t, label: t }))], [productTypes]);

  function sortHeader(sort: ProductSort, children: React.ReactNode, align: 'left' | 'right' = 'left', key?: string) {
    const dir = dirOf(sort);
    return (
      <th key={key} scope="col" aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'} className={cn('px-3 py-2 font-medium', align === 'right' && 'text-right')}>
        <button
          type="button"
          onClick={() => sortBy(sort)}
          className={cn('inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand', align === 'right' && 'flex-row-reverse')}
        >
          {children}
          {dir === 'asc' ? <ArrowUp aria-hidden className="size-3" /> : dir === 'desc' ? <ArrowDown aria-hidden className="size-3" /> : null}
        </button>
      </th>
    );
  }

  function cell(id: ColumnId, p: ProductListItem): React.ReactNode {
    switch (id) {
      case 'photo':
        return <Thumb image={p.image} />;
      case 'status':
        return (
          <InlineStatus
            product={p}
            onSaved={() => {
              reload();
              onChanged();
            }}
          />
        );
      case 'variants':
        return <span className="text-sm tabular-nums">{p.kind === 'service' ? 'Service' : p.variantCount}</span>;
      case 'price':
        return (
          <InlineEdit
            label={`Price of ${p.title}`}
            display={priceRange(p.priceMin, p.priceMax)}
            initial={p.single?.price != null ? moneyInput(p.single.price) : ''}
            parse={parsePrice}
            lockReason={priceLockReason(p)}
            onSave={async (value) => {
              await catalogApi.setInlinePrice(p.id, value);
              reload();
              onChanged();
            }}
          />
        );
      case 'stock':
        return (
          <InlineEdit
            label={`Stock of ${p.title}`}
            display={p.stock === null ? 'Not tracked' : p.stock}
            initial={String(p.single?.stock ?? 0)}
            parse={parseStock}
            lockReason={p.stock === null && !p.single ? 'Not tracked' : stockLockReason(p)}
            onSave={async (value) => {
              await catalogApi.setStock(p.id, p.single!.id, value ?? 0);
              reload();
              onChanged();
            }}
          />
        );
      case 'type':
        return <span className="text-sm text-muted-foreground">{p.productType ?? ''}</span>;
      case 'collections':
        return <span className="line-clamp-2 text-sm text-muted-foreground">{p.collections.map((c) => c.title).join(', ')}</span>;
      case 'updated':
        return <span className="text-sm tabular-nums text-muted-foreground">{new Date(p.updatedAt).toLocaleDateString()}</span>;
    }
  }

  const empty = page !== null && page.total === 0;

  return (
    <section aria-label="Products" className="flex flex-col gap-3">
      <p ref={statusRef} role="status" aria-live="polite" className="sr-only" />
      <div role="search" aria-label="Find products" className="glass flex flex-wrap items-end gap-3 rounded-2xl p-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
          Search
          <span className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              maxLength={100}
              placeholder="Title, type, tag, description or SKU"
              onChange={(e) => setSearch(e.target.value)}
              className={cn(INPUT, 'h-8 pl-8')}
            />
          </span>
        </label>
        <FilterSelect label="Status" value={filters.status} options={STATUS_OPTIONS} onChange={(status) => onFilters({ ...filters, status })} />
        <FilterSelect label="Type" value={filters.type} options={typeOptions} onChange={(type) => onFilters({ ...filters, type })} />
        <FilterSelect
          label="Collection"
          value={filters.collection}
          options={collectionOptions}
          onChange={(collection) => onFilters({ ...filters, collection })}
        />
        <FilterSelect label="Stock" value={filters.stock} options={STOCK_OPTIONS} onChange={(stock) => onFilters({ ...filters, stock })} />
        {filtered ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onFilters({ ...filters, q: '', status: '', type: '', collection: '', stock: '' })}>
            <X aria-hidden /> Clear
          </Button>
        ) : null}
        <span className="ml-auto">
          <ColumnMenu columns={columns} onChange={setCols} />
        </span>
      </div>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />

      {page === null && loading ? (
        <p className="glass rounded-2xl p-6 text-sm text-muted-foreground" role="status">
          Loading products…
        </p>
      ) : page === null && loadError ? (
        <ErrorAlert message={loadError} onRetry={reload} />
      ) : empty && !filtered ? (
        <div className="glass flex flex-col items-center gap-3 rounded-2xl px-6 py-14 text-center">
          <h2 className="text-base font-semibold">No products yet</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Add what you sell: products with sizes or colours, or services with one price. Or start from three sample products of a small
            jewellery shop and change them.
          </p>
          <span className="mt-2 flex flex-wrap justify-center gap-2">
            <Button type="button" onClick={onAddProduct}>
              Add product
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await catalogApi.addSamples();
                  reload();
                  onChanged();
                  announce('Three sample products added');
                } catch (err) {
                  if (err instanceof CatalogApiError && BLOCKING.has(err.code)) onBlocked(err);
                  else setError(errorText(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Adding…' : 'Add sample products'}
            </Button>
          </span>
        </div>
      ) : (
        <div className="glass overflow-hidden rounded-2xl">
          {loadError ? (
            <div className="p-3">
              <ErrorAlert message={loadError} onRetry={reload} />
            </div>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left" aria-busy={loading}>
              <thead className="border-b border-foreground/[0.08] text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="w-10 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label="Select every product on this page"
                      checked={allSelected}
                      disabled={items.length === 0}
                      onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
                    />
                  </th>
                  {columns.includes('photo') && columns.indexOf('photo') === 0 ? (
                    <th scope="col" className="w-14 px-3 py-2 font-medium">
                      <span className="sr-only">Photo</span>
                    </th>
                  ) : null}
                  {sortHeader('title', 'Title')}
                  {columns
                    .filter((c, i) => !(c === 'photo' && i === 0))
                    .map((c) => {
                      const sort = COLUMNS[c].sort;
                      const right = c === 'price' || c === 'stock' || c === 'variants';
                      return sort ? (
                        sortHeader(sort, COLUMNS[c].label, right ? 'right' : 'left', c)
                      ) : (
                        <th key={c} scope="col" className={cn('px-3 py-2 font-medium', right && 'text-right')}>
                          {COLUMNS[c].label}
                        </th>
                      );
                    })}
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr
                    key={p.id}
                    aria-selected={selected.has(p.id)}
                    className={cn(
                      'border-b border-foreground/[0.05] transition-colors duration-150 last:border-0 hover:bg-foreground/[0.025]',
                      (selected.has(p.id) || openId === p.id) && 'bg-brand/[0.06]',
                    )}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.title}`}
                        checked={selected.has(p.id)}
                        onChange={() =>
                          setSelected((s) => {
                            const next = new Set(s);
                            if (next.has(p.id)) next.delete(p.id);
                            else next.add(p.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    {columns.includes('photo') && columns.indexOf('photo') === 0 ? <td className="px-3 py-2">{cell('photo', p)}</td> : null}
                    <td className="min-w-40 px-3 py-2">
                      <button
                        type="button"
                        onClick={() => onOpen(p.id)}
                        className="rounded text-left text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                      >
                        {p.title}
                      </button>
                      <span className="block text-xs text-muted-foreground">{p.handle}</span>
                    </td>
                    {columns
                      .filter((c, i) => !(c === 'photo' && i === 0))
                      .map((c) => (
                        <td key={c} className={cn('px-3 py-2', (c === 'price' || c === 'stock' || c === 'variants') && 'text-right whitespace-nowrap')}>
                          {cell(c, p)}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {empty ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-muted-foreground">
              No product matches these filters.
              <Button type="button" variant="outline" size="sm" onClick={() => onFilters({ ...filters, q: '', status: '', type: '', collection: '', stock: '' })}>
                Clear filters
              </Button>
            </div>
          ) : null}
          {page && page.total > 0 ? (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3 border-t border-foreground/[0.06] px-3 py-2 text-xs text-muted-foreground">
              <span>
                {pageIndex * PAGE_SIZE + 1} to {pageIndex * PAGE_SIZE + items.length} of {page.total}
              </span>
              <span className="flex gap-1">
                <Button type="button" variant="ghost" size="sm" disabled={pageIndex === 0 || loading} onClick={() => setPageIndex((i) => i - 1)}>
                  <ChevronLeft aria-hidden /> Previous
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={!page.nextCursor || loading}
                  onClick={() => setPageIndex((i) => i + 1)}
                >
                  Next <ChevronRight aria-hidden />
                </Button>
              </span>
            </nav>
          ) : null}
        </div>
      )}

      {selected.size > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4">
          <div role="toolbar" aria-label="Bulk actions" className="glass pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-2xl p-1.5">
            <span className="px-2 text-sm font-medium">{selected.size} selected</span>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => runBulk({ action: 'status', ids, status: 'published' }, `${ids.length} published`)}>
              Publish
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => runBulk({ action: 'status', ids, status: 'draft' }, `${ids.length} set to draft`)}>
              Set to draft
            </Button>
            {collections.length > 0 ? (
              <label className="flex items-center gap-1 text-sm">
                <span className="sr-only">Add to collection</span>
                <select
                  value={bulkCollection}
                  disabled={busy}
                  onChange={async (e) => {
                    const collectionId = e.target.value;
                    setBulkCollection(collectionId);
                    if (!collectionId) return;
                    const title = collections.find((c) => c.id === collectionId)?.title ?? 'the collection';
                    await runBulk({ action: 'addToCollection', ids, collectionId }, `Added to ${title}`);
                    setBulkCollection('');
                  }}
                  className={cn(INPUT, 'h-8 w-auto')}
                >
                  <option value="">Add to collection…</option>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {filters.status === 'archived' ? (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => runBulk({ action: 'unarchive', ids }, `${ids.length} unarchived`)}>
                Unarchive
              </Button>
            ) : (
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => runBulk({ action: 'archive', ids }, `${ids.length} archived`)}>
                Archive
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" aria-label="Clear the selection" onClick={() => setSelected(new Set())}>
              <X aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The status cell: a small select that saves at once (archived included). */
function InlineStatus({ product, onSaved }: { product: ProductListItem; onSaved: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [value, setValue] = useState<ProductStatus>(product.status);
  useEffect(() => setValue(product.status), [product.status]);
  return (
    <span className="flex flex-col gap-0.5">
      <span className="relative inline-flex items-center">
        <StatusPill status={value} />
        <select
          aria-label={`Status of ${product.title}`}
          value={value}
          disabled={saving}
          onChange={async (e) => {
            const next = e.target.value as ProductStatus;
            const before = value;
            setValue(next);
            setSaving(true);
            setError(null);
            try {
              await catalogApi.updateProduct(product.id, { status: next });
              onSaved();
            } catch (err) {
              setValue(before);
              setError(errorText(err));
            } finally {
              setSaving(false);
            }
          }}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
      </span>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

