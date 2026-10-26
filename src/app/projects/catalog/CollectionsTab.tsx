'use client';

// src/app/projects/catalog/CollectionsTab.tsx
//
// The catalogue's Collections tab (catalogue design, "Collections: a second
// tab with a list and a panel"): the company's collections with their product
// counts, a new collection by its title, and a side panel per collection with
// its title, URL handle, description, image and its products in order (moved
// with buttons, removed, added from a search of the company's products).
// Archived collections are listed on request and can be restored. Every
// change saves at once and shows the server's answer; a refusal shows its
// sentence where it happened.

import { ArrowDown, ArrowUp, ImagePlus, Plus, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { CatalogApiError, catalogApi } from '@/lib/catalog/api';
import type { CollectionDetail, CollectionView, ProductListItem } from '@/lib/catalog/types';
import { cn } from '@/lib/utils';

import { fileProblem } from './PhotosSection';
import { ErrorAlert, INPUT, SaveField, Section, StatusPill, Thumb, errorText } from './ui';

function CollectionPanel({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [c, setC] = useState<CollectionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<ProductListItem[]>([]);
  const [entered, setEntered] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(() => {
    setLoadError(null);
    catalogApi.collection(id).then(setC, (err) => setLoadError(errorText(err)));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    const t = requestAnimationFrame(() => setEntered(true));
    heading.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === 'Escape' && !(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'))) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(t);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (search.trim() === '') {
      setFound([]);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      catalogApi.products({ q: search, limit: 8 }).then(
        (page) => live && setFound(page.items),
        (err) => live && setError(errorText(err)),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [search]);

  async function save(run: () => Promise<CollectionDetail>) {
    // A refusal is thrown to the caller, which shows it where it happened (a field, or the alert above).
    setError(null);
    setC(await run());
    onChanged();
  }

  const ids = c?.products.map((p) => p.id) ?? [];
  const setOrder = (next: string[]) => save(() => catalogApi.setCollectionProducts(id, next)).catch((err) => setError(errorText(err)));

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="collection-title"
      className={cn(
        'fixed inset-0 z-40 flex flex-col lg:inset-y-3 lg:right-3 lg:left-auto lg:w-[min(860px,calc(100vw-26rem))]',
        'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none',
        entered ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0',
      )}
    >
      <div className="glass-ground absolute inset-0 lg:hidden" aria-hidden />
      <div className="glass relative flex h-full flex-col overflow-hidden lg:rounded-3xl">
        <header className="flex items-center gap-3 border-b border-foreground/[0.08] px-4 py-3 sm:px-5">
          <h2 id="collection-title" ref={heading} tabIndex={-1} className="min-w-0 flex-1 truncate text-base font-semibold outline-none">
            {c?.title ?? 'Collection'}
          </h2>
          <Button type="button" variant="ghost" size="icon" aria-label="Close the panel" onClick={onClose}>
            <X aria-hidden />
          </Button>
        </header>
        <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5">
          {loadError ? (
            <ErrorAlert message={loadError} onRetry={load} />
          ) : !c ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              Loading the collection…
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {error ? <ErrorAlert message={error} onDismiss={() => setError(null)} /> : null}
              <Section title="Details" id="collection-details">
                <div className="grid gap-3 sm:grid-cols-2">
                  <SaveField
                    label="Title"
                    value={c.title}
                    format={(x) => x}
                    parse={(t) => (t.trim() === '' ? { ok: false, message: 'Enter a title' } : { ok: true, value: t.trim() })}
                    maxLength={200}
                    onSave={(title) => save(() => catalogApi.updateCollection(id, { title }))}
                  />
                  <SaveField
                    label="URL handle"
                    value={c.handle}
                    format={(x) => x}
                    parse={(t) =>
                      /^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.trim().toLowerCase())
                        ? { ok: true, value: t.trim().toLowerCase() }
                        : { ok: false, message: 'Letters, digits and single hyphens between words' }
                    }
                    maxLength={120}
                    onSave={(handle) => save(() => catalogApi.updateCollection(id, { handle }))}
                  />
                  <SaveField
                    className="sm:col-span-2"
                    label="Description"
                    value={c.description}
                    format={(x) => x ?? ''}
                    parse={(t) => (t.length > 4000 ? { ok: false, message: 'At most 4000 characters' } : { ok: true, value: t.trim() === '' ? null : t })}
                    multiline
                    hint="Ctrl or Cmd plus Enter saves"
                    onSave={(description) => save(() => catalogApi.updateCollection(id, { description }))}
                  />
                  <div className="flex items-center gap-3 sm:col-span-2">
                    <Thumb image={c.image} size={56} alt={c.image ? `Image of ${c.title}` : ''} />
                    <input
                      ref={picker}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="sr-only"
                      tabIndex={-1}
                      aria-label="Choose the collection image"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        const problem = fileProblem(file);
                        if (problem) {
                          setError(problem);
                          return;
                        }
                        try {
                          const stored = await catalogApi.storeImage(file);
                          await save(() => catalogApi.updateCollection(id, { imageSha256: stored.sha256 }));
                        } catch (err) {
                          setError(errorText(err));
                        }
                      }}
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => picker.current?.click()}>
                      <ImagePlus aria-hidden /> {c.image ? 'Change image' : 'Add image'}
                    </Button>
                    {c.image ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => void save(() => catalogApi.updateCollection(id, { imageSha256: null })).catch((err) => setError(errorText(err)))}>
                        Remove image
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Section>

              <Section title={`Products (${c.products.length})`} id="collection-products">
                <label className="mb-3 flex flex-col gap-1 text-xs font-medium text-muted-foreground">
                  Add a product
                  <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title or SKU" className={INPUT} />
                </label>
                {found.length > 0 ? (
                  <ul className="mb-3 flex flex-col gap-1" aria-label="Products found">
                    {found.map((p) => (
                      <li key={p.id} className="flex items-center gap-2 text-sm">
                        <Thumb image={p.image} size={28} />
                        <span className="flex-1 truncate">{p.title}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={ids.includes(p.id)}
                          onClick={() => void setOrder([...ids, p.id])}
                        >
                          {ids.includes(p.id) ? 'In the collection' : 'Add'}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {c.products.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No products yet. Search above, or select products in the table and use Add to collection.</p>
                ) : (
                  <ol className="flex flex-col gap-1.5" aria-label="Products in order">
                    {c.products.map((p, i) => (
                      <li key={p.id} className="glass-inset flex items-center gap-2 rounded-xl p-2 text-sm">
                        <span className="w-6 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                        <Thumb image={p.image} size={32} />
                        <span className="min-w-0 flex-1 truncate">{p.title}</span>
                        <StatusPill status={p.status} />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Move ${p.title} up`}
                          disabled={i === 0}
                          onClick={() => {
                            const next = [...ids];
                            [next[i - 1], next[i]] = [next[i], next[i - 1]];
                            void setOrder(next);
                          }}
                        >
                          <ArrowUp aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Move ${p.title} down`}
                          disabled={i === ids.length - 1}
                          onClick={() => {
                            const next = [...ids];
                            [next[i + 1], next[i]] = [next[i], next[i + 1]];
                            void setOrder(next);
                          }}
                        >
                          <ArrowDown aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={`Remove ${p.title} from the collection`}
                          onClick={() => void setOrder(ids.filter((x) => x !== p.id))}
                        >
                          <X aria-hidden />
                        </Button>
                      </li>
                    ))}
                  </ol>
                )}
              </Section>
              <div className="flex justify-end pb-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void save(() => catalogApi.updateCollection(id, { archived: !c.archivedAt })).catch((err) => setError(errorText(err)))}
                >
                  {c.archivedAt ? 'Restore collection' : 'Archive collection'}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function CollectionsTab({
  collections,
  open,
  setOpen,
  onReload,
  onBlocked,
}: {
  collections: CollectionView[] | null;
  /** The collection whose panel is open (kept in the address by the parent). */
  open: string | null;
  setOpen: (id: string | null) => void;
  onReload: () => void;
  onBlocked: (err: CatalogApiError) => void;
}) {
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<CollectionView[]>([]);

  useEffect(() => {
    if (!showArchived) return;
    catalogApi.collections(true).then(
      (r) => setArchived(r.items.filter((c) => c.archivedAt)),
      (err) => setError(errorText(err)),
    );
  }, [showArchived, collections]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim() === '') {
      setError('Enter a title for the collection.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const c = await catalogApi.createCollection(title.trim());
      setTitle('');
      onReload();
      setOpen(c.id);
    } catch (err) {
      if (err instanceof CatalogApiError && err.status === 403) onBlocked(err);
      else setError(errorText(err));
    } finally {
      setCreating(false);
    }
  }

  const list = [...(collections ?? []), ...(showArchived ? archived : [])];
  return (
    <section aria-label="Collections" className="flex flex-col gap-3">
      <form onSubmit={create} className="glass flex flex-wrap items-end gap-3 rounded-2xl p-3">
        <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
          New collection
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Summer rings" className={cn(INPUT, 'h-8')} />
        </label>
        <Button type="submit" size="sm" disabled={creating}>
          <Plus aria-hidden /> {creating ? 'Creating…' : 'Create'}
        </Button>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </form>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {collections === null ? (
        <p role="status" className="glass rounded-2xl p-6 text-sm text-muted-foreground">
          Loading collections…
        </p>
      ) : list.length === 0 ? (
        <div className="glass rounded-2xl px-6 py-12 text-center">
          <h2 className="text-base font-semibold">No collections yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            A collection groups products for the shop, such as Rings or Gifts under 50 euros. Create one above.
          </p>
        </div>
      ) : (
        <ul className="glass flex flex-col overflow-hidden rounded-2xl" aria-label="Collections">
          {list.map((c) => (
            <li key={c.id} className="border-b border-foreground/[0.05] last:border-0">
              <button
                type="button"
                onClick={() => setOpen(c.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-foreground/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                  open === c.id && 'bg-brand/[0.06]',
                )}
              >
                <Thumb image={c.image} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{c.handle}</span>
                </span>
                {c.archivedAt ? <StatusPill status="archived" /> : null}
                <span className="text-sm text-muted-foreground tabular-nums">
                  {c.productCount} {c.productCount === 1 ? 'product' : 'products'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open ? <CollectionPanel key={open} id={open} onClose={() => setOpen(null)} onChanged={onReload} /> : null}
    </section>
  );
}
