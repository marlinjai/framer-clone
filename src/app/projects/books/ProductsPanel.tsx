'use client';

// src/app/projects/books/ProductsPanel.tsx
//
// The "Products and services" tab of the Books (invoice editor plan, phase 4):
// the company's list of items a draft line can be filled from. Search by name
// and description (case and accents ignored, applied after a short pause),
// live items first, 100 at a time with "Load more"; "Show archived" adds the
// archived ones with "Restore". "New item" and "Change" open the form above the
// list (ProductForm); "Archive" takes an item out of the search and frees its
// name. Drafts never change through this page: a line copies an item's values
// when it is picked and keeps no reference to it, which the page says.
//
// Every change reloads the rows already shown (the user keeps their place) and
// is announced in a status line; when the control that had the focus goes away
// (an archived row, a closed form), the focus moves to a stable place: the row's
// next control, the "New item" button or the status line. Prices are shown in
// German format (1.234,50 €).

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { booksApi, type ProductView } from '@/lib/books/api';
import { money, rate } from '@/lib/books/units';

import { FirstPage, MoreRows } from './ListStatus';
import ProductForm from './ProductForm';
import { useCursorList } from './useCursorList';
import { ErrorAlert, errorText } from './ui';

const TAX_LABELS: Record<ProductView['taxClass'], string> = {
  standard: '19 % VAT',
  reduced: '7 % VAT',
  zero: '0 % VAT',
};

type Editing = { mode: 'new' } | { mode: 'change'; product: ProductView } | null;

export default function ProductsPanel({ onBlocked }: { onBlocked: (err: unknown) => void }) {
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  // Where the focus goes once the list shows the result of a change (a row id and which button).
  const focusAfter = useRef<{ id: string; action: 'change' | 'archive' | 'restore' } | 'new' | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const list = useCursorList<ProductView>(
    `${q}|${showArchived ? 1 : 0}`,
    (cursor) => booksApi.products({ q: q || undefined, includeArchived: showArchived, cursor }),
    { onFirstPageError: onBlocked, errorText },
  );

  // Move the focus once the rows it should land on are rendered. A row that is
  // gone (archived while archived items are hidden, or filtered out by the
  // search) hands the focus to "New item", else to the search field.
  useEffect(() => {
    const target = focusAfter.current;
    if (target === null || list.items === null) return;
    focusAfter.current = null;
    const fallback = () => (newButton.current ?? searchField.current)?.focus();
    if (target === 'new') fallback();
    else {
      const el =
        document.getElementById(`product-row-${target.id}-${target.action}`) ??
        document.getElementById(`product-row-${target.id}-change`);
      if (el) el.focus();
      else fallback();
    }
  }, [list.items, editing]);

  const closeForm = useCallback((back: { id: string } | null) => {
    focusAfter.current = back ? { id: back.id, action: 'change' } : 'new';
    setEditing(null);
  }, []);

  async function saved(product: ProductView, created: boolean) {
    setAnnouncement(created ? `“${product.name}” was added to the list.` : `“${product.name}” was saved.`);
    focusAfter.current = { id: product.id, action: 'change' };
    setEditing(null);
    await list.reload({ keepShown: true });
  }

  async function archive(p: ProductView) {
    setError(null);
    setBusyId(p.id);
    try {
      await booksApi.archiveProduct(p.id);
      setAnnouncement(`“${p.name}” was archived. Drafts that used it keep their lines.`);
      // Shown with archived items, the row stays and offers Restore; otherwise it goes.
      focusAfter.current = { id: p.id, action: 'restore' };
      if (editing?.mode === 'change' && editing.product.id === p.id) setEditing(null);
      await list.reload({ keepShown: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  async function restore(p: ProductView) {
    setError(null);
    setBusyId(p.id);
    try {
      await booksApi.restoreProduct(p.id);
      setAnnouncement(`“${p.name}” was restored.`);
      focusAfter.current = { id: p.id, action: 'archive' };
      await list.reload({ keepShown: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }

  const searching = q !== '';
  return (
    <section aria-labelledby="products-heading">
      <h2 id="products-heading" className="sr-only">
        Products and services
      </h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Items a line of an invoice can be filled from. A line copies the item when it is picked, so changing or
        archiving an item never changes a draft or an issued invoice.
      </p>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {editing ? (
        <div className="mb-6">
          <ProductForm
            key={editing.mode === 'change' ? editing.product.id : 'new'}
            product={editing.mode === 'change' ? editing.product : undefined}
            onCancel={() => closeForm(editing.mode === 'change' ? editing.product : null)}
            onSaved={(p) => void saved(p, editing.mode === 'new')}
          />
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Find products and services">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Search
            <Input
              ref={searchField}
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Name or description"
              maxLength={100}
              className="h-9 w-64"
            />
          </label>
          <label className="flex h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
        {editing?.mode !== 'new' ? (
          <Button ref={newButton} variant="outline" onClick={() => setEditing({ mode: 'new' })}>
            New item
          </Button>
        ) : null}
      </div>

      {list.items === null ? (
        <FirstPage list={list} noun="products and services" />
      ) : list.items.length === 0 ? (
        searching ? null : (
          <p className="text-sm text-muted-foreground">
            {showArchived ? 'No items yet.' : 'No items yet. Add the services and products you invoice often.'}
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Products and services" aria-busy={list.loadingMore}>
          {list.items.map((p) => {
            const archived = p.archivedAt !== null;
            return (
              <li key={p.id} className={`flex items-center justify-between gap-4 rounded-lg border p-4 ${archived ? 'border-dashed' : ''}`}>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    {archived ? (
                      <span className="shrink-0 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground">
                        Archived
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {p.kind === 'service' ? 'Service' : 'Product'} · {money(p.unitPrice)} per {p.unitLabel}{' '}
                    {p.priceBasis === 'net' ? 'net' : 'gross'} · {TAX_LABELS[p.taxClass]}
                    {p.discountBp > 0 ? ` · ${rate(p.discountBp)} discount` : ''}
                    {p.description ? ` · ${p.description}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    id={`product-row-${p.id}-change`}
                    size="sm"
                    variant="ghost"
                    aria-label={`Change ${p.name}`}
                    onClick={() => setEditing({ mode: 'change', product: p })}
                  >
                    Change
                  </Button>
                  {archived ? (
                    <Button
                      id={`product-row-${p.id}-restore`}
                      size="sm"
                      variant="ghost"
                      aria-label={`Restore ${p.name}`}
                      aria-disabled={busyId === p.id}
                      onClick={() => {
                        if (busyId === null) void restore(p);
                      }}
                    >
                      Restore
                    </Button>
                  ) : (
                    <Button
                      id={`product-row-${p.id}-archive`}
                      size="sm"
                      variant="ghost"
                      aria-label={`Archive ${p.name}`}
                      aria-disabled={busyId === p.id}
                      onClick={() => {
                        if (busyId === null) void archive(p);
                      }}
                    >
                      Archive
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <MoreRows
        list={list}
        noun={['item', 'items']}
        emptyText={searching ? 'No item matches this search.' : ''}
      />
    </section>
  );
}
