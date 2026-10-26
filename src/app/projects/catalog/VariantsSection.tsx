'use client';

// src/app/projects/catalog/VariantsSection.tsx
//
// The panel's "Options and variants" section (catalogue design, "Side panel"):
// the options editor and the variant table.
//
// The options editor is a draft until "Save options": adding or removing a
// value changes which variants exist, so the person sees the count it will
// make and saves once (the server regenerates the matrix in one transaction,
// src/server/catalog/repository/variants.ts). Existing options and values keep
// their ids, so a rename keeps every variant with its price and stock; removed
// values take their variants with them, which the button says before it is
// pressed. Up to three options (the fourth is refused with the reason).
//
// The variant table saves per field like the rest of the panel: SKU, price,
// compare-at price, stock, stock tracking, backorder and the photo. Stock
// needs tracking and a SKU, and the field says so when it is locked.

import { Plus, Trash2, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { money, moneyInput, parseMoney } from '@/lib/books/units';
import { MAX_OPTIONS, MAX_OPTION_VALUES, MAX_VARIANTS, type OptionInput, type ProductDetail, type VariantView } from '@/lib/catalog/types';
import { cn } from '@/lib/utils';

import { INPUT, SaveField, Section, Thumb, errorText } from './ui';
import type { Apply } from './ProductPanel';
import { catalogApi } from '@/lib/catalog/api';

interface DraftOption {
  key: string;
  id?: string;
  title: string;
  values: Array<{ key: string; id?: string; value: string }>;
}

let keySeq = 0;
const nextKey = () => `k${(keySeq += 1)}`;

function draftOf(product: ProductDetail): DraftOption[] {
  return product.options.map((o) => ({ key: o.id, id: o.id, title: o.title, values: o.values.map((v) => ({ key: v.id, id: v.id, value: v.value })) }));
}

function inputOf(draft: DraftOption[]): OptionInput[] {
  return draft.map((o) => ({
    ...(o.id ? { id: o.id } : {}),
    title: o.title.trim(),
    values: o.values.filter((v) => v.value.trim() !== '').map((v) => ({ ...(v.id ? { id: v.id } : {}), value: v.value.trim() })),
  }));
}

/** What the draft would do: its variant count and how many existing variants it removes (the server's rule, variants.ts). */
export function draftEffect(product: ProductDetail, draft: DraftOption[]): { count: number; removed: number } {
  const final = draft.map((o) => ({ id: o.id, values: o.values.filter((v) => v.value.trim() !== '') }));
  const count = final.reduce((n, o) => n * o.values.length, 1);
  const keptValues = new Set(final.flatMap((o) => o.values.map((v) => v.id).filter(Boolean)));
  const taken = new Set<string>();
  for (const variant of product.variants) {
    const combo: string[] = [];
    let ok = true;
    for (const o of final) {
      const valueId = o.id ? variant.values.find((x) => x.optionId === o.id)?.valueId : (o.values[0]?.id ?? o.values[0]?.value);
      if (!valueId || (o.id && !keptValues.has(valueId))) {
        ok = false;
        break;
      }
      combo.push(valueId);
    }
    if (ok) taken.add(combo.join(','));
  }
  const kept = final.length === 0 ? Math.min(1, product.variants.length) : taken.size;
  return { count, removed: Math.max(0, product.variants.length - kept) };
}

function problemOf(draft: DraftOption[]): string | null {
  const titles = new Set<string>();
  for (const o of draft) {
    const t = o.title.trim().toLowerCase();
    if (t === '') return 'Name every option (for example Size).';
    if (titles.has(t)) return `Two options are called ${o.title.trim()}.`;
    titles.add(t);
    const values = o.values.map((v) => v.value.trim().toLowerCase()).filter(Boolean);
    if (values.length === 0) return `Give ${o.title.trim()} at least one value.`;
    if (new Set(values).size !== values.length) return `A value of ${o.title.trim()} is listed twice.`;
    if (values.length > MAX_OPTION_VALUES) return `${o.title.trim()} has more than ${MAX_OPTION_VALUES} values.`;
  }
  return null;
}

function OptionsEditor({ product, apply }: { product: ProductDetail; apply: Apply }) {
  const stored = useMemo(() => JSON.stringify(inputOf(draftOf(product))), [product]);
  const [draft, setDraft] = useState<DraftOption[]>(() => draftOf(product));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A saved or undone product resets the draft to what the server stored.
  useEffect(() => setDraft(draftOf(product)), [stored]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(inputOf(draft)) !== stored;
  const problem = problemOf(draft);
  const effect = draftEffect(product, draft);
  const tooMany = effect.count > MAX_VARIANTS;

  const update = (key: string, fn: (o: DraftOption) => DraftOption) => setDraft((d) => d.map((o) => (o.key === key ? fn(o) : o)));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // The matrix cannot be put back exactly (removed variants are gone), so this step has no undo.
      await apply('options', () => catalogApi.setOptions(product.id, inputOf(draft)), null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {draft.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No options: the product is sold as one item. Add an option such as Size or Metal to sell it in variants.
        </p>
      ) : null}
      {draft.map((o, i) => (
        <fieldset key={o.key} className="glass-inset flex flex-col gap-2 rounded-xl p-3">
          <legend className="sr-only">Option {i + 1}</legend>
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
              Option name
              <input
                value={o.title}
                maxLength={100}
                placeholder="Size"
                onChange={(e) => update(o.key, (x) => ({ ...x, title: e.target.value }))}
                className={INPUT}
              />
            </label>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove the option ${o.title || i + 1}`}
              onClick={() => setDraft((d) => d.filter((x) => x.key !== o.key))}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
          <ul className="flex flex-wrap gap-1.5" aria-label={`Values of ${o.title || 'this option'}`}>
            {o.values.map((v) => (
              <li key={v.key} className="flex items-center gap-1 rounded-lg bg-background/70 pl-2 pr-1 ring-1 ring-foreground/10">
                <input
                  aria-label={`Value of ${o.title || 'the option'}`}
                  value={v.value}
                  maxLength={100}
                  size={Math.max(3, v.value.length)}
                  onChange={(e) => update(o.key, (x) => ({ ...x, values: x.values.map((y) => (y.key === v.key ? { ...y, value: e.target.value } : y)) }))}
                  className="h-7 bg-transparent text-sm outline-none"
                />
                <button
                  type="button"
                  aria-label={`Remove the value ${v.value}`}
                  onClick={() => update(o.key, (x) => ({ ...x, values: x.values.filter((y) => y.key !== v.key) }))}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
            <li>
              <input
                aria-label={`Add a value to ${o.title || 'the option'}`}
                placeholder="Add a value, then Enter"
                maxLength={100}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ',') return;
                  e.preventDefault();
                  const value = e.currentTarget.value.trim();
                  if (!value) return;
                  update(o.key, (x) => ({ ...x, values: [...x.values, { key: nextKey(), value }] }));
                  e.currentTarget.value = '';
                }}
                className={cn(INPUT, 'h-7 w-44')}
              />
            </li>
          </ul>
        </fieldset>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <span title={draft.length >= MAX_OPTIONS ? `A product has at most ${MAX_OPTIONS} options` : undefined}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={draft.length >= MAX_OPTIONS}
            onClick={() => setDraft((d) => [...d, { key: nextKey(), title: '', values: [] }])}
          >
            <Plus aria-hidden /> Add option
          </Button>
        </span>
        {draft.length >= MAX_OPTIONS ? <span className="text-xs text-muted-foreground">At most {MAX_OPTIONS} options.</span> : null}
        {dirty ? (
          <>
            <Button type="button" size="sm" disabled={saving || Boolean(problem) || tooMany} onClick={save}>
              {saving ? 'Saving…' : `Save options (${effect.count} ${effect.count === 1 ? 'variant' : 'variants'})`}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(draftOf(product))}>
              Discard changes
            </Button>
          </>
        ) : null}
      </div>
      {dirty && effect.removed > 0 && !problem ? (
        <p className="text-xs text-muted-foreground">
          Saving removes {effect.removed} {effect.removed === 1 ? 'variant' : 'variants'} with their price and stock settings. Renamed values keep
          their variants.
        </p>
      ) : null}
      {problem && dirty ? <p className="text-xs text-destructive">{problem}</p> : null}
      {tooMany ? <p className="text-xs text-destructive">These options make {effect.count} variants; at most {MAX_VARIANTS}.</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function moneyField(value: number | null) {
  return value === null ? '' : moneyInput(value);
}

function parseOptionalMoney(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  if (text.trim() === '') return { ok: true, value: null };
  const cents = parseMoney(text);
  return cents === null || cents < 0 ? { ok: false, message: 'Enter an amount such as 49,00' } : { ok: true, value: cents };
}

function stockReason(v: VariantView, service: boolean): string | null {
  if (service) return 'A service has no stock';
  if (!v.manageInventory) return 'Turn on tracking to keep stock';
  if (!v.sku) return 'Add a SKU first: stock is kept per SKU';
  return null;
}

function VariantRow({ product, variant, apply }: { product: ProductDetail; variant: VariantView; apply: Apply }) {
  const service = product.kind === 'service';
  const lock = stockReason(variant, service);
  const label = variant.title ?? product.title;
  const image = product.images.find((i) => i.id === variant.imageId) ?? null;
  const [toggleError, setToggleError] = useState<string | null>(null);
  const save = (field: string, run: () => Promise<ProductDetail>, undo: () => Promise<ProductDetail>) => apply(`${field} of ${label}`, run, undo);
  const p = product.id;
  const v = variant.id;

  async function toggle(field: 'manageInventory' | 'allowBackorder', value: boolean) {
    setToggleError(null);
    try {
      await save(field === 'manageInventory' ? 'stock tracking' : 'backorder', () => catalogApi.updateVariant(p, v, { [field]: value }), () =>
        catalogApi.updateVariant(p, v, { [field]: !value }),
      );
    } catch (err) {
      setToggleError(errorText(err));
    }
  }

  return (
    <li className="glass-inset grid grid-cols-2 gap-3 rounded-xl p-3 sm:grid-cols-6">
      <div className="col-span-2 flex items-center gap-2 sm:col-span-6">
        <Thumb image={image} size={32} />
        <span className="text-sm font-medium">{variant.title ?? 'The one variant'}</span>
        {product.images.length > 0 ? (
          <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            Photo
            <select
              value={variant.imageId ?? ''}
              onChange={async (e) => {
                const next = e.target.value || null;
                const before = variant.imageId;
                setToggleError(null);
                try {
                  await save('photo', () => catalogApi.updateVariant(p, v, { imageId: next }), () => catalogApi.updateVariant(p, v, { imageId: before }));
                } catch (err) {
                  setToggleError(errorText(err));
                }
              }}
              className={cn(INPUT, 'h-7 w-auto')}
            >
              <option value="">None</option>
              {product.images.map((img) => (
                <option key={img.id} value={img.id}>
                  Photo {img.position}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <SaveField
        className="col-span-2"
        label="SKU"
        value={variant.sku}
        format={(x) => x ?? ''}
        parse={(t) => ({ ok: true, value: t.trim() === '' ? null : t.trim() })}
        onSave={(sku) => save('SKU', () => catalogApi.updateVariant(p, v, { sku }), () => catalogApi.updateVariant(p, v, { sku: variant.sku }))}
        maxLength={64}
      />
      <SaveField
        label="Price"
        value={variant.price}
        format={moneyField}
        parse={parseOptionalMoney}
        inputMode="decimal"
        onSave={(price) => save('price', () => catalogApi.updateVariant(p, v, { price }), () => catalogApi.updateVariant(p, v, { price: variant.price, compareAt: variant.compareAt }))}
      />
      <SaveField
        label="Compare at"
        value={variant.compareAt}
        format={moneyField}
        parse={parseOptionalMoney}
        inputMode="decimal"
        hint={variant.compareAt !== null && variant.price !== null && variant.compareAt > variant.price ? `Shown struck through: ${money(variant.compareAt)}` : undefined}
        onSave={(compareAt) => save('compare-at price', () => catalogApi.updateVariant(p, v, { compareAt }), () => catalogApi.updateVariant(p, v, { compareAt: variant.compareAt }))}
      />
      {lock ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Stock</span>
          <span className="flex h-9 items-center text-xs text-muted-foreground">{lock}</span>
        </div>
      ) : (
        <SaveField
          label="Stock"
          value={variant.stock ?? 0}
          format={(x) => String(x)}
          parse={(t) => (/^\d+$/.test(t.trim()) ? { ok: true, value: Number(t.trim()) } : { ok: false, message: 'Whole units, 0 or more' })}
          inputMode="numeric"
          onSave={(available) => save('stock', () => catalogApi.setStock(p, v, available), () => catalogApi.setStock(p, v, variant.stock ?? 0))}
        />
      )}
      {service ? null : (
        <div className="flex flex-col justify-end gap-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={variant.manageInventory} onChange={(e) => void toggle('manageInventory', e.target.checked)} />
            Track stock
          </label>
          <label className="flex items-center gap-2" title="Sell when out of stock; the order waits for new stock">
            <input
              type="checkbox"
              checked={variant.allowBackorder}
              disabled={!variant.manageInventory}
              onChange={(e) => void toggle('allowBackorder', e.target.checked)}
            />
            Sell when out of stock
          </label>
        </div>
      )}
      {toggleError ? (
        <p role="alert" className="col-span-2 text-xs text-destructive sm:col-span-6">
          {toggleError}
        </p>
      ) : null}
    </li>
  );
}

export default function VariantsSection({ product, apply }: { product: ProductDetail; apply: Apply }) {
  const service = product.kind === 'service';
  return (
    <Section title={service ? 'Price' : 'Options and variants'} id="panel-variants">
      {service ? (
        <p className="mb-3 text-sm text-muted-foreground">A service has one price and no stock.</p>
      ) : (
        <OptionsEditor product={product} apply={apply} />
      )}
      <ul className={cn('flex flex-col gap-2', !service && 'mt-4')} aria-label="Variants">
        {product.variants.map((v) => (
          <VariantRow key={v.id} product={product} variant={v} apply={apply} />
        ))}
      </ul>
    </Section>
  );
}
