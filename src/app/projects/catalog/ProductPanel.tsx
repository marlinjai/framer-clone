'use client';

// src/app/projects/catalog/ProductPanel.tsx
//
// The product's side panel (catalogue design, "Side panel"): wide and glass,
// the table stays visible beside it on large screens, full screen on phones.
// Sections: Photos, Details (title, formatted description, kind, type, tags,
// status), Options and variants, Collections, Sites (hidden per site), Tax,
// Search engine preview.
//
// SAVING per field, as the invoice editor: a field saves when it is left (or
// Enter is pressed), a select or a checkbox at once, and every answer is the
// server's product, so the panel always shows what is stored (a reload shows
// the same, the resume path). A refused save shows the server's sentence at
// the field and keeps the stored value.
//
// UNDO for the last steps: each saved step that can be put back keeps how
// (the previous value, sent again); "Undo" or Ctrl or Cmd plus Z outside a
// text field undoes the latest, up to 20 steps back. Saving the options has no
// undo (the variants it removes are gone with their figures), and the panel
// says so before it is saved (VariantsSection).

import { Archive, ArchiveRestore, Undo2, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { CatalogApiError, catalogApi } from '@/lib/catalog/api';
import { TAX_CLASS_LABELS, type CollectionView, type ProductDetail, type SiteView } from '@/lib/catalog/types';
import RichTextEditor from '@/app/projects/books/invoice/RichTextEditor';
import { richFromPlain, type RichText } from '@/server/books/render/richText';
import { cn } from '@/lib/utils';

import PhotosSection from './PhotosSection';
import { ErrorAlert, SaveField, SaveSelect, Section, StatusPill, errorText } from './ui';
import VariantsSection from './VariantsSection';

/** Save one step: run it, show the server's product, keep its undo (null: cannot be undone). Throws the refusal. */
export type Apply = (label: string, run: () => Promise<ProductDetail>, undo: (() => Promise<ProductDetail>) | null) => Promise<void>;

export const MAX_UNDO = 20;

interface UndoStep {
  label: string;
  undo: () => Promise<ProductDetail>;
}

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
}

const text = (max: number, required = false) => (t: string) => {
  const v = t.trim();
  if (required && v === '') return { ok: false as const, message: 'This cannot be empty' };
  if (v.length > max) return { ok: false as const, message: `At most ${max} characters` };
  return { ok: true as const, value: v === '' ? null : v };
};

/** The formatted description as it reads (paragraphs and bullet items, bold and italic). */
function RichPreview({ rich }: { rich: RichText }) {
  return (
    <div className="flex flex-col gap-1 text-sm">
      {rich.blocks.map((b, i) => {
        const runs = b.runs.map((r, j) => (
          <span key={j} className={cn(r.bold && 'font-semibold', r.italic && 'italic')}>
            {r.text}
          </span>
        ));
        return b.kind === 'bullet' ? (
          <p key={i} className="flex gap-2">
            <span aria-hidden>•</span>
            <span>{runs}</span>
          </p>
        ) : (
          <p key={i} className="min-h-5">
            {runs}
          </p>
        );
      })}
    </div>
  );
}

function DescriptionField({ product, apply }: { product: ProductDetail; apply: Apply }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = useRef<RichText | null>(null);
  const current: RichText | null = product.descriptionFormat ?? (product.description ? richFromPlain(product.description) : null);

  async function commit() {
    setEditing(false);
    const next = draft.current;
    draft.current = null;
    if (!next || JSON.stringify(next) === JSON.stringify(current ?? richFromPlain(''))) return;
    setError(null);
    try {
      const before = product.descriptionFormat;
      const beforePlain = product.description;
      await apply(
        'description',
        () => catalogApi.updateProduct(product.id, { descriptionFormat: next }),
        () => catalogApi.updateProduct(product.id, before ? { descriptionFormat: before } : { description: beforePlain }),
      );
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="flex flex-col gap-1 sm:col-span-2">
      <span id="panel-description-label" className="text-xs font-medium text-muted-foreground">
        Description
      </span>
      {editing ? (
        <div className="pt-12">
          <RichTextEditor
            initial={current ?? richFromPlain('')}
            label="Description"
            textStyle={{ fontSize: 14, lineHeight: 1.5, padding: 8 }}
            minHeight={96}
            invalid={Boolean(error)}
            onChange={(rich) => (draft.current = rich)}
            onCommit={() => void commit()}
            onCancel={() => {
              draft.current = null;
              setEditing(false);
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          aria-labelledby="panel-description-label"
          aria-describedby="panel-description-hint"
          onClick={() => setEditing(true)}
          className="glass-inset flex min-h-20 flex-col items-stretch justify-start rounded-lg px-2.5 py-2 text-left transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          {current ? <RichPreview rich={current} /> : <span className="text-sm text-muted-foreground">Add a description</span>}
        </button>
      )}
      <span id="panel-description-hint" className="text-xs text-muted-foreground">
        Bold, italic and bullet lists. Leaving the field saves it.
      </span>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

function CheckList({
  label,
  items,
  checked,
  onChange,
  empty,
}: {
  label: string;
  items: Array<{ id: string; label: string }>;
  checked: Set<string>;
  onChange: (next: Set<string>) => Promise<void>;
  empty: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (items.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={saving}>
      <legend className="sr-only">{label}</legend>
      {items.map((item) => (
        <label key={item.id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={checked.has(item.id)}
            onChange={async () => {
              const next = new Set(checked);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              setSaving(true);
              setError(null);
              try {
                await onChange(next);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setSaving(false);
              }
            }}
          />
          {item.label}
        </label>
      ))}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export interface ProductPanelProps {
  productId: string;
  collections: CollectionView[];
  sites: SiteView[];
  productTypes: string[];
  onClose: () => void;
  /** After every saved step, so the table reads again. */
  onChanged: () => void;
  onBlocked: (err: CatalogApiError) => void;
}

export default function ProductPanel({ productId, collections, sites, productTypes, onClose, onChanged, onBlocked }: ProductPanelProps) {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loadError, setLoadError] = useState<CatalogApiError | Error | null>(null);
  const [undo, setUndo] = useState<UndoStep[]>([]);
  const [undoError, setUndoError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const [reload, setReload] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    setLoadError(null);
    catalogApi.product(productId).then(
      (p) => live && setProduct(p),
      (err) => {
        if (!live) return;
        if (err instanceof CatalogApiError && ['unauthorized', 'sites_not_enabled', 'no_active_company', 'catalog_not_provisioned'].includes(err.code)) onBlocked(err);
        else setLoadError(err);
      },
    );
    return () => {
      live = false;
    };
  }, [productId, reload, onBlocked]);

  // A new product starts with no undo steps.
  useEffect(() => {
    setUndo([]);
    setProduct(null);
  }, [productId]);

  useEffect(() => {
    const t = requestAnimationFrame(() => setEntered(true));
    heading.current?.focus();
    return () => cancelAnimationFrame(t);
  }, []);

  const apply: Apply = useCallback(
    async (label, run, undoStep) => {
      const next = await run();
      setProduct(next);
      setSaved(`Saved ${label}`);
      if (undoStep) setUndo((u) => [...u.slice(-(MAX_UNDO - 1)), { label, undo: undoStep }]);
      onChanged();
    },
    [onChanged],
  );

  const undoLast = useCallback(async () => {
    const step = undo[undo.length - 1];
    if (!step) return;
    setUndoError(null);
    try {
      const next = await step.undo();
      setProduct(next);
      setUndo((u) => u.slice(0, -1));
      setSaved(`Undid ${step.label}`);
      onChanged();
    } catch (err) {
      setUndoError(`The ${step.label} could not be undone: ${errorText(err)}`);
    }
  }, [undo, onChanged]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isTextTarget(e.target)) onClose();
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !isTextTarget(e.target) && undo.length > 0) {
        e.preventDefault();
        void undoLast();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, undoLast, undo.length]);

  const p = product;
  const field = (label: string, patch: Parameters<typeof catalogApi.updateProduct>[1], before: Parameters<typeof catalogApi.updateProduct>[1]) =>
    apply(label, () => catalogApi.updateProduct(productId, patch), () => catalogApi.updateProduct(productId, before));

  const notFound = loadError instanceof CatalogApiError && loadError.status === 404;
  const previewUrl = `${sites[0]?.name ? sites[0].name.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'your-site'}/products/${p?.handle ?? ''}`;

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-labelledby="panel-title"
      className={cn(
        'fixed inset-0 z-40 flex flex-col lg:inset-y-3 lg:right-3 lg:left-auto lg:w-[min(860px,calc(100vw-26rem))]',
        'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none',
        entered ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0',
      )}
    >
      <div className="glass-ground absolute inset-0 lg:hidden" aria-hidden />
      <div className="glass relative flex h-full flex-col overflow-hidden lg:rounded-3xl">
        <header className="flex items-center gap-3 border-b border-foreground/[0.08] px-4 py-3 sm:px-5">
          <h2 id="panel-title" ref={heading} tabIndex={-1} className="min-w-0 flex-1 truncate text-base font-semibold outline-none">
            {p?.title ?? 'Product'}
          </h2>
          {p ? <StatusPill status={p.status} /> : null}
          <p role="status" aria-live="polite" className="hidden text-xs text-muted-foreground sm:block">
            {saved}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={undo.length === 0}
            onClick={() => void undoLast()}
            aria-keyshortcuts="Control+Z Meta+Z"
            title={undo.length ? `Undo ${undo[undo.length - 1].label}` : 'Nothing to undo'}
          >
            <Undo2 aria-hidden /> Undo
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label="Close the panel" onClick={onClose}>
            <X aria-hidden />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-5">
          {undoError ? (
            <div className="mb-3">
              <ErrorAlert message={undoError} onDismiss={() => setUndoError(null)} />
            </div>
          ) : null}
          {notFound ? (
            <div className="flex flex-col items-start gap-3 p-4 text-sm">
              <p>This product is not in this company&apos;s catalogue any more. It may have been removed, or it belongs to another company.</p>
              <Button type="button" variant="outline" onClick={onClose}>
                Close
              </Button>
            </div>
          ) : loadError ? (
            <ErrorAlert message={errorText(loadError)} onRetry={() => setReload((n) => n + 1)} />
          ) : !p ? (
            <p role="status" className="p-4 text-sm text-muted-foreground">
              Loading the product…
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              <PhotosSection product={p} apply={apply} />

              <Section title="Details" id="panel-details">
                <div className="grid gap-3 sm:grid-cols-2">
                  <SaveField
                    className="sm:col-span-2"
                    label="Title"
                    value={p.title}
                    format={(x) => x}
                    parse={(t) => {
                      const r = text(300, true)(t);
                      return r.ok ? { ok: true, value: r.value ?? '' } : r;
                    }}
                    maxLength={300}
                    onSave={(title) => field('title', { title }, { title: p.title })}
                  />
                  <DescriptionField product={p} apply={apply} />
                  <SaveSelect
                    label="Kind"
                    value={p.kind}
                    options={[
                      { value: 'physical', label: 'Product (with stock)' },
                      { value: 'service', label: 'Service (one price, no stock)' },
                    ]}
                    onSave={(kind) => field('kind', { kind }, { kind: p.kind })}
                  />
                  <SaveSelect
                    label="Status"
                    value={p.status}
                    options={[
                      { value: 'draft', label: 'Draft (on no shop)' },
                      { value: 'published', label: 'Published' },
                      { value: 'archived', label: 'Archived' },
                    ]}
                    onSave={(status) => field('status', { status }, { status: p.status === 'archived' ? 'archived' : p.publishStatus })}
                  />
                  <div className="flex flex-col">
                    <SaveField
                      label="Type"
                      value={p.productType}
                      format={(x) => x ?? ''}
                      parse={text(100)}
                      maxLength={100}
                      placeholder="Ring"
                      list="catalog-types"
                      onSave={(productType) => field('type', { productType }, { productType: p.productType })}
                    />
                    <datalist id="catalog-types">
                      {productTypes.map((t) => (
                        <option key={t} value={t} />
                      ))}
                    </datalist>
                  </div>
                  <SaveField
                    label="Tags"
                    value={p.tags}
                    format={(x) => x.join(', ')}
                    parse={(t) => {
                      const tags = t.split(',').map((x) => x.trim()).filter(Boolean);
                      if (tags.some((x) => x.length > 50)) return { ok: false, message: 'A tag has at most 50 characters' };
                      if (tags.length > 50) return { ok: false, message: 'At most 50 tags' };
                      return { ok: true, value: tags };
                    }}
                    hint="Separated by commas"
                    onSave={(tags) => field('tags', { tags }, { tags: p.tags })}
                  />
                </div>
              </Section>

              <VariantsSection product={p} apply={apply} />

              <Section title="Collections" id="panel-collections">
                <CheckList
                  label="Collections"
                  items={collections.filter((c) => !c.archivedAt).map((c) => ({ id: c.id, label: c.title }))}
                  checked={new Set(p.collections.map((c) => c.id))}
                  empty="No collections yet. Create one in the Collections tab."
                  onChange={(next) =>
                    apply('collections', () => catalogApi.setProductCollections(p.id, [...next]), () => catalogApi.setProductCollections(p.id, p.collections.map((c) => c.id)))
                  }
                />
              </Section>

              <Section title="Sites" id="panel-sites">
                <p className="mb-2 text-xs text-muted-foreground">Once published, the product shows on every site of the company that is ticked.</p>
                <CheckList
                  label="Shown on"
                  items={sites.map((s) => ({ id: s.id, label: s.name }))}
                  checked={new Set(sites.map((s) => s.id).filter((id) => !p.hiddenSiteIds.includes(id)))}
                  empty="This company has no sites yet."
                  onChange={(shown) =>
                    apply(
                      'sites',
                      () => catalogApi.setHiddenSites(p.id, sites.map((s) => s.id).filter((id) => !shown.has(id))),
                      () => catalogApi.setHiddenSites(p.id, p.hiddenSiteIds.filter((id) => sites.some((s) => s.id === id))),
                    )
                  }
                />
              </Section>

              <Section title="Tax" id="panel-tax">
                <div className="grid gap-3 sm:grid-cols-3">
                  <SaveSelect
                    label="Tax rate"
                    value={p.taxClass}
                    options={(['standard', 'reduced', 'zero'] as const).map((v) => ({ value: v, label: TAX_CLASS_LABELS[v] }))}
                    onSave={(taxClass) => field('tax rate', { taxClass }, { taxClass: p.taxClass })}
                  />
                  <SaveSelect
                    label="Prices are"
                    value={p.priceBasis}
                    options={[
                      { value: 'gross', label: 'Including tax' },
                      { value: 'net', label: 'Excluding tax' },
                    ]}
                    onSave={(priceBasis) => field('price basis', { priceBasis }, { priceBasis: p.priceBasis })}
                  />
                  <SaveField
                    label="Unit on invoices"
                    value={p.unitLabel}
                    format={(x) => x}
                    parse={(t) => (t.trim() === '' || t.trim().length > 20 ? { ok: false, message: '1 to 20 characters' } : { ok: true, value: t.trim() })}
                    maxLength={20}
                    onSave={(unitLabel) => field('unit', { unitLabel }, { unitLabel: p.unitLabel })}
                  />
                </div>
              </Section>

              <Section title="Search engine preview" id="panel-seo">
                <div className="glass-inset mb-3 rounded-xl p-3" aria-label="How a search result could show the product">
                  <p className="truncate text-xs text-muted-foreground">{previewUrl}</p>
                  <p className="truncate text-base text-brand">{p.seoTitle ?? p.title}</p>
                  <p className="line-clamp-2 text-sm text-muted-foreground">
                    {p.seoDescription ?? p.description?.slice(0, 160) ?? 'Add a description, or a search engine description below.'}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <SaveField
                    label="Page title"
                    value={p.seoTitle}
                    format={(x) => x ?? ''}
                    parse={text(120)}
                    maxLength={120}
                    hint={`${(p.seoTitle ?? '').length} of 120 characters; empty uses the title`}
                    onSave={(seoTitle) => field('page title', { seoTitle }, { seoTitle: p.seoTitle })}
                  />
                  <SaveField
                    label="URL handle"
                    value={p.handle}
                    format={(x) => x}
                    parse={(t) => {
                      const v = t.trim().toLowerCase();
                      return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) && v.length <= 120
                        ? { ok: true, value: v }
                        : { ok: false, message: 'Letters, digits and single hyphens between words' };
                    }}
                    maxLength={120}
                    onSave={(handle) => field('URL handle', { handle }, { handle: p.handle })}
                  />
                  <SaveField
                    className="sm:col-span-2"
                    label="Search engine description"
                    value={p.seoDescription}
                    format={(x) => x ?? ''}
                    parse={text(320)}
                    multiline
                    maxLength={320}
                    hint={`${(p.seoDescription ?? '').length} of 320 characters; Ctrl or Cmd plus Enter saves`}
                    onSave={(seoDescription) => field('search engine description', { seoDescription }, { seoDescription: p.seoDescription })}
                  />
                </div>
              </Section>

              <div className="flex justify-end pb-2">
                {p.status === 'archived' ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void apply('unarchive', () => catalogApi.setArchived(p.id, false), () => catalogApi.setArchived(p.id, true)).catch((err) =>
                        setUndoError(errorText(err)),
                      )
                    }
                  >
                    <ArchiveRestore aria-hidden /> Unarchive
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void apply('archive', () => catalogApi.setArchived(p.id, true), () => catalogApi.setArchived(p.id, false)).catch((err) =>
                        setUndoError(errorText(err)),
                      )
                    }
                  >
                    <Archive aria-hidden /> Archive
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
