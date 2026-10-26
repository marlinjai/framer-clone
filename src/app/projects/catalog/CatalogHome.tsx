'use client';

// src/app/projects/catalog/CatalogHome.tsx
//
// The catalogue area of the editor (/projects/catalog, catalogue design slice
// 2): the active company's products in a glass table with a side panel, and
// its collections in a second tab. The search, the filters, the tab and the
// open product are kept in the address (replaced, not pushed, so the back
// button leaves the area instead of stepping through every keystroke), so a
// reload shows the same screen with what the server stored.
//
// A refusal that concerns the whole area (signed out, Lumitra Sites not
// enabled for the company, no edit or view right, the shop database not set
// up) replaces the screen with a page that says so and what to do.

import Link from 'next/link';
import { Plus } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { SegmentedSwitch } from '@/app/projects/books/invoice/chrome';
import { CatalogApiError, catalogApi } from '@/lib/catalog/api';
import type { CollectionView, SiteView } from '@/lib/catalog/types';
import { cn } from '@/lib/utils';

import CollectionsTab from './CollectionsTab';
import ProductPanel from './ProductPanel';
import ProductTable, { BLOCKING } from './ProductTable';
import { filtersFrom, queryWith, type Filters } from './state';
import { ErrorAlert, INPUT, errorText } from './ui';

type Tab = 'products' | 'collections';

/** The columns are remembered per browser profile (the person using it); the key leaves room for a user id. */
const USER_KEY = 'me';

export default function CatalogHome({ initialQuery = '' }: { initialQuery?: string }) {
  const [params, setParams] = useState(() => new URLSearchParams(initialQuery));
  const tab: Tab = params.get('tab') === 'collections' ? 'collections' : 'products';
  const openId = params.get('product');
  const openCollection = params.get('collection');
  const filters = filtersFrom(params);
  const [blocked, setBlocked] = useState<CatalogApiError | null>(null);
  const [collections, setCollections] = useState<CollectionView[] | null>(null);
  const [sites, setSites] = useState<SiteView[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newKind, setNewKind] = useState<'physical' | 'service'>('physical');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const onBlocked = useCallback((err: CatalogApiError) => setBlocked(err), []);
  const fail = useCallback((err: unknown) => {
    if (err instanceof CatalogApiError && BLOCKING.has(err.code)) setBlocked(err);
    else setError(errorText(err));
  }, []);

  /** Change the address without a navigation (the tab, the filters, the open product). */
  const navigate = useCallback((next: URLSearchParams) => {
    setParams(next);
    try {
      const q = next.toString();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${q ? `?${q}` : ''}`);
    } catch {
      // A sandboxed frame may refuse; the screen still follows the state.
    }
  }, []);

  const loadMeta = useCallback(() => {
    catalogApi.collections().then((r) => setCollections(r.items), fail);
    catalogApi.meta().then((m) => {
      setSites(m.sites);
      setTypes(m.productTypes);
    }, fail);
  }, [fail]);
  useEffect(loadMeta, [loadMeta]);

  const changed = useCallback(() => {
    setReloadKey((n) => n + 1);
    catalogApi.meta().then((m) => setTypes(m.productTypes), () => undefined);
  }, []);

  function setFilters(next: Filters) {
    navigate(new URLSearchParams(queryWith(params, next).slice(1)));
  }
  function setTab(next: Tab) {
    const p = new URLSearchParams(params);
    if (next === 'products') p.delete('tab');
    else p.set('tab', next);
    p.delete('product');
    p.delete('collection');
    navigate(p);
  }
  const open = useCallback(
    (id: string | null) => {
      const p = new URLSearchParams(params);
      if (id) p.set('product', id);
      else p.delete('product');
      navigate(p);
    },
    [params, navigate],
  );

  const openCollectionPanel = useCallback(
    (id: string | null) => {
      const p = new URLSearchParams(params);
      if (id) p.set('collection', id);
      else p.delete('collection');
      navigate(p);
    },
    [params, navigate],
  );

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (newTitle.trim() === '') {
      setError('Enter a title for the new product.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const product = await catalogApi.createProduct({ title: newTitle.trim(), kind: newKind });
      setAdding(false);
      setNewTitle('');
      changed();
      open(product.id);
    } catch (err) {
      fail(err);
    } finally {
      setCreating(false);
    }
  }

  if (blocked) {
    return (
      <main className="glass-ground min-h-dvh px-4 py-12">
        <div className="glass mx-auto max-w-xl rounded-3xl p-6">
          <h1 className="text-xl font-semibold tracking-tight">Catalog</h1>
          <p className="mt-3 text-sm">{blocked.message}</p>
          <Link href="/projects" className="mt-6 inline-block text-sm underline underline-offset-4">
            Back to projects
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className={cn('glass-ground min-h-dvh px-4 pt-6 pb-28 sm:px-6', (openId || openCollection) && 'lg:pr-[calc(min(860px,100vw-26rem)+1.5rem)]')}>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link href="/projects" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Projects
            </Link>
            <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
            <p className="mt-0.5 text-sm text-muted-foreground">Products and services of this company, for its sites and its invoices.</p>
          </div>
          <div className="flex items-center gap-2">
            <SegmentedSwitch
              label="Catalog sections"
              value={tab}
              options={[
                { value: 'products', label: 'Products' },
                { value: 'collections', label: 'Collections' },
              ]}
              onChange={setTab}
            />
            {tab === 'products' ? (
              <Button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
                <Plus aria-hidden /> Add product
              </Button>
            ) : null}
          </div>
        </header>

        {adding && tab === 'products' ? (
          <form onSubmit={create} aria-label="Add a product" className="glass flex flex-wrap items-end gap-3 rounded-2xl p-3">
            <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
              Title
              <input
                autoFocus
                value={newTitle}
                maxLength={300}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Silver ring"
                className={cn(INPUT, 'h-8')}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
              Kind
              <select value={newKind} onChange={(e) => setNewKind(e.target.value as 'physical' | 'service')} className={cn(INPUT, 'h-8 w-auto')}>
                <option value="physical">Product (with stock)</option>
                <option value="service">Service (one price)</option>
              </select>
            </label>
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? 'Creating…' : 'Create and open'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </form>
        ) : null}

        <ErrorAlert message={error} onDismiss={() => setError(null)} />

        {tab === 'products' ? (
          <ProductTable
            filters={filters}
            onFilters={setFilters}
            collections={collections ?? []}
            productTypes={types}
            userKey={USER_KEY}
            reloadKey={reloadKey}
            openId={openId}
            onOpen={(id) => open(id)}
            onBlocked={onBlocked}
            onAddProduct={() => setAdding(true)}
            onChanged={changed}
          />
        ) : (
          <CollectionsTab
            collections={collections}
            open={openCollection}
            setOpen={openCollectionPanel}
            onReload={() => catalogApi.collections().then((r) => setCollections(r.items), fail)} onBlocked={onBlocked} />
        )}
      </div>

      {tab === 'products' && openId ? (
        <ProductPanel
          key={openId}
          productId={openId}
          collections={collections ?? []}
          sites={sites}
          productTypes={types}
          onClose={() => open(null)}
          onChanged={changed}
          onBlocked={onBlocked}
        />
      ) : null}
    </main>
  );
}
