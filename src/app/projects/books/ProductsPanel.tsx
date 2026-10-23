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
// next control, the "New item" button or the search field, once the reloaded
// rows are on screen. For a small business the VAT class reads "no VAT
// charged". Prices are shown in
// German format (1.234,50 €).

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { booksApi, type ProductView } from '@/lib/books/api';
import { money, rate } from '@/lib/books/units';

import { FirstPage, MoreRows } from './ListStatus';
import ProductForm, { DISCARD_QUESTION } from './ProductForm';
import { useCursorList } from './useCursorList';
import { ErrorAlert, errorText } from './ui';

const TAX_LABELS: Record<ProductView['taxClass'], string> = {
  standard: '19 % VAT',
  reduced: '7 % VAT',
  zero: '0 % VAT',
};

type Editing = { mode: 'new' } | { mode: 'change'; product: ProductView } | null;
type FocusTarget = { id: string; action: 'change' | 'archive' | 'restore' } | 'new' | null;

/**
 * `smallBusiness`: the company charges no VAT (§ 19 UStG), so an item's VAT
 * class is shown as not charged rather than as a rate it never invoices.
 */
export default function ProductsPanel({
  onBlocked,
  smallBusiness = false,
}: {
  onBlocked: (err: unknown) => void;
  smallBusiness?: boolean;
}) {
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  // Where the focus goes once a change is shown: set only AFTER the list was
  // reloaded (or at once when nothing is reloaded), so it lands on the rows
  // of the same render, never on rows a slower answer replaces afterwards.
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null);

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
    if (focusTarget === null) return;
    setFocusTarget(null);
    const fallback = () => (newButton.current ?? searchField.current)?.focus();
    if (focusTarget === 'new') fallback();
    else {
      const el =
        document.getElementById(`product-row-${focusTarget.id}-${focusTarget.action}`) ??
        document.getElementById(`product-row-${focusTarget.id}-change`);
      if (el) el.focus();
      else fallback();
    }
  }, [focusTarget]);

  // Whether the open form holds typed values: another form never replaces it without asking.
  const formDirty = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => {
    formDirty.current = dirty;
  }, []);
  function openForm(next: Exclude<Editing, null>) {
    if (editing && formDirty.current && !window.confirm(DISCARD_QUESTION)) return;
    formDirty.current = false;
    setEditing(next);
  }

  const closeForm = useCallback((back: { id: string } | null) => {
    formDirty.current = false;
    setEditing(null);
    setFocusTarget(back ? { id: back.id, action: 'change' } : 'new');
  }, []);

  async function saved(product: ProductView, created: boolean) {
    setAnnouncement(created ? `“${product.name}” was added to the list.` : `“${product.name}” was saved.`);
    formDirty.current = false;
    setEditing(null);
    await list.reload({ keepShown: true });
    setFocusTarget({ id: product.id, action: 'change' });
  }

  async function archive(p: ProductView) {
    setError(null);
    setBusyId(p.id);
    try {
      await booksApi.archiveProduct(p.id);
      setAnnouncement(`“${p.name}” was archived. Drafts that used it keep their lines.`);
      if (editing?.mode === 'change' && editing.product.id === p.id) {
        // The form showed the item now archived: it closes (archiving was asked for this very item).
        formDirty.current = false;
        setEditing(null);
      }
      await list.reload({ keepShown: true });
      // Shown with archived items, the row stays and offers Restore; otherwise it is gone (the fallback).
      setFocusTarget({ id: p.id, action: 'restore' });
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
      await list.reload({ keepShown: true });
      setFocusTarget({ id: p.id, action: 'archive' });
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
            onDirtyChange={onDirtyChange}
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
          <Button ref={newButton} variant="outline" onClick={() => openForm({ mode: 'new' })}>
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
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {p.kind === 'service' ? 'Service' : 'Product'} · {money(p.unitPrice)} per {p.unitLabel}{' '}
                    {p.priceBasis === 'net' ? 'net' : 'gross'} ·{' '}
                    {smallBusiness ? 'no VAT charged (small business)' : TAX_LABELS[p.taxClass]}
                    {p.discountBp > 0 ? ` · ${rate(p.discountBp)} discount` : ''}
                  </span>
                  {p.description ? (
                    <span className="mt-0.5 block whitespace-pre-line break-words text-xs text-muted-foreground">
                      {p.description}
                    </span>
                  ) : null}
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    id={`product-row-${p.id}-change`}
                    size="sm"
                    variant="ghost"
                    aria-label={`Change ${p.name}`}
                    onClick={() => openForm({ mode: 'change', product: p })}
                  >
                    Change
                  </Button>
                  {archived ? (
                    <Button
                      id={`product-row-${p.id}-restore`}
                      size="sm"
                      variant="ghost"
                      aria-label={`Restore ${p.name}`}
                      aria-disabled={busyId !== null}
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
                      aria-disabled={busyId !== null}
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
