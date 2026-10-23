'use client';

// src/app/projects/books/ProductForm.tsx
//
// New item, or an item changed, of the company's product and service list.
// The price is typed in euros in German or plain form ("1.234,50", "80.00")
// and sent in cents; the default discount in percent and sent in basis points;
// the server checks every value again. A problem is shown under its field and
// tied to it (aria-invalid, aria-describedby), and the focus moves to the first
// field with a problem; a name another live item has (the server's
// duplicate_product) is shown under the name. A change sends only the fields
// that differ from the item as opened. Escape cancels, after asking when
// something was typed.

import React, { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BooksApiError, booksApi, type ProductInput, type ProductView } from '@/lib/books/api';
import { DEFAULT_PRODUCT_UNIT, productNameProblem } from '@/lib/books/products';
import { moneyInput, parseMoney, parsePercent, rate } from '@/lib/books/units';

import { ErrorAlert, Field, errorText, fieldA11y } from './ui';

/** The largest unit price a line can hold (a PostgreSQL INTEGER of cents). */
const MAX_PRICE_CENTS = 2_147_483_647;

/** What the form holds while it is typed in (text, as typed). */
export interface ProductDraft {
  kind: ProductView['kind'];
  name: string;
  description: string;
  unitLabel: string;
  unitPrice: string;
  priceBasis: ProductView['priceBasis'];
  taxClass: ProductView['taxClass'];
  discount: string;
}

export type ProductField = 'name' | 'description' | 'unitLabel' | 'unitPrice' | 'discount';
export type ProductErrors = Partial<Record<ProductField, string>>;

export const EMPTY_PRODUCT: ProductDraft = {
  kind: 'service',
  name: '',
  description: '',
  unitLabel: DEFAULT_PRODUCT_UNIT,
  unitPrice: '',
  priceBasis: 'net',
  taxClass: 'standard',
  discount: '',
};

/** The form's values for an existing item. */
export function draftOfProduct(p: ProductView): ProductDraft {
  return {
    kind: p.kind,
    name: p.name,
    description: p.description ?? '',
    unitLabel: p.unitLabel,
    unitPrice: moneyInput(p.unitPrice),
    priceBasis: p.priceBasis,
    taxClass: p.taxClass,
    discount: p.discountBp === 0 ? '' : rate(p.discountBp).replace(' %', ''),
  };
}

/** The request body of the form, or what is wrong, per field (in the order the form shows them). */
export function productBody(d: ProductDraft): { ok: true; body: ProductInput } | { ok: false; errors: ProductErrors } {
  const errors: ProductErrors = {};
  const name = d.name.trim();
  const nameProblem = productNameProblem(name);
  if (nameProblem) errors.name = nameProblem;
  if (d.description.length > 4000) errors.description = 'Use at most 4000 characters.';
  const unit = d.unitLabel.trim();
  if (unit === '') errors.unitLabel = 'Enter a unit, for example Std or Stk.';
  else if (unit.length > 20) errors.unitLabel = 'Use at most 20 characters.';
  const price = parseMoney(d.unitPrice);
  if (d.unitPrice.trim() === '') errors.unitPrice = 'Enter a price in euros, for example 80,00.';
  else if (price === null) errors.unitPrice = 'Enter the price in euros with at most two decimals, for example 80,00.';
  else if (price < 0) errors.unitPrice = 'A price cannot be negative.';
  else if (price > MAX_PRICE_CENTS) errors.unitPrice = 'The price is too large (at most 21.474.836,47 €).';
  const discount = d.discount.trim() === '' ? 0 : parsePercent(d.discount);
  if (discount === null) errors.discount = 'Enter the discount in percent, for example 10 or 2,5.';
  else if (discount < 0 || discount > 10000) errors.discount = 'Enter a discount from 0 to 100 percent.';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      kind: d.kind,
      name,
      description: d.description.trim() === '' ? null : d.description,
      unitLabel: unit,
      unitPrice: price as number,
      priceBasis: d.priceBasis,
      taxClass: d.taxClass,
      discountBp: discount as number,
    },
  };
}

const ORDER: ProductField[] = ['name', 'description', 'unitLabel', 'unitPrice', 'discount'];

/**
 * The fields of `body` that differ from the item as it was opened: a change
 * sends only these, so a field another window changed meanwhile is not
 * overwritten with the value this form happened to show.
 */
export function changedFields(product: ProductView, body: ProductInput): Partial<ProductInput> {
  const out: Partial<ProductInput> = {};
  for (const key of Object.keys(body) as Array<keyof ProductInput>) {
    if (body[key] !== product[key]) (out as Record<string, unknown>)[key] = body[key];
  }
  return out;
}

interface Props {
  /** The item being changed; absent for a new one. */
  product?: ProductView;
  onSaved: (product: ProductView) => void;
  onCancel: () => void;
}

export default function ProductForm({ product, onSaved, onCancel }: Props) {
  const [draft, setDraft] = useState<ProductDraft>(product ? draftOfProduct(product) : EMPTY_PRODUCT);
  const [errors, setErrors] = useState<ProductErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const prefix = product ? `product-${product.id}` : 'product-new';
  const id = (f: string) => `${prefix}-${f}`;

  function focusField(field: ProductField) {
    document.getElementById(id(field))?.focus();
  }

  // The form opens with the cursor in the name (opened from a button, so the move is expected).
  useEffect(() => {
    document.getElementById(`${prefix}-name`)?.focus();
  }, [prefix]);

  function set<K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    // A field typed in again is no longer shown as wrong; the next save checks it again.
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const result = productBody(draft);
    if (!result.ok) {
      setErrors(result.errors);
      const first = ORDER.find((f) => result.errors[f]);
      if (first) focusField(first);
      return;
    }
    setErrors({});
    if (product && Object.keys(changedFields(product, result.body)).length === 0) {
      // Nothing changed: nothing to send.
      onSaved(product);
      return;
    }
    setBusy(true);
    try {
      const saved = product
        ? await booksApi.updateProduct(product.id, changedFields(product, result.body))
        : await booksApi.createProduct(result.body);
      onSaved(saved);
    } catch (err) {
      if (err instanceof BooksApiError && err.code === 'duplicate_product') {
        setErrors({ name: err.message });
        focusField('name');
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const initial = product ? draftOfProduct(product) : EMPTY_PRODUCT;
  const dirty = (Object.keys(initial) as Array<keyof ProductDraft>).some((k) => initial[k] !== draft[k]);
  const title = product ? `Change “${product.name}”` : 'New item';
  return (
    <form
      ref={form}
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || busy) return;
        e.preventDefault();
        // Typed values are never thrown away by one key without asking.
        if (dirty && !window.confirm('Discard what you typed in this form?')) return;
        onCancel();
      }}
      noValidate
      className="rounded-lg border p-4"
      aria-labelledby={id('title')}
    >
      {/* Under the tab's own h2 (ProductsPanel), so the outline stays in order. */}
      <h3 id={id('title')} className="mb-3 text-base font-medium">
        {title}
      </h3>
      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name (printed as the line's title)" htmlFor={id('name')} error={errors.name}>
          <Input
            {...fieldA11y(id('name'), { error: errors.name })}
            required
            aria-required="true"
            maxLength={300}
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label="Kind" htmlFor={id('kind')}>
          <select
            id={id('kind')}
            value={draft.kind}
            onChange={(e) => set('kind', e.target.value as ProductDraft['kind'])}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="service">Service</option>
            <option value="product">Product</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description (optional, printed under the title)" htmlFor={id('description')} error={errors.description}>
            <textarea
              {...fieldA11y(id('description'), { error: errors.description })}
              rows={3}
              maxLength={4000}
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              className="rounded-md border bg-transparent px-3 py-2 text-sm"
            />
          </Field>
        </div>
        <Field label="Unit" htmlFor={id('unitLabel')} hint="For example Std, Stk, Tag or pauschal." error={errors.unitLabel}>
          <Input
            {...fieldA11y(id('unitLabel'), { error: errors.unitLabel, hint: true })}
            required
            aria-required="true"
            maxLength={20}
            value={draft.unitLabel}
            onChange={(e) => set('unitLabel', e.target.value)}
          />
        </Field>
        <Field label="Unit price (EUR)" htmlFor={id('unitPrice')} hint="For example 80,00." error={errors.unitPrice}>
          <Input
            {...fieldA11y(id('unitPrice'), { error: errors.unitPrice, hint: true })}
            required
            aria-required="true"
            inputMode="decimal"
            value={draft.unitPrice}
            onChange={(e) => set('unitPrice', e.target.value)}
          />
        </Field>
        <Field label="The price is" htmlFor={id('priceBasis')}>
          <select
            id={id('priceBasis')}
            value={draft.priceBasis}
            onChange={(e) => set('priceBasis', e.target.value as ProductDraft['priceBasis'])}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="net">net (VAT is added)</option>
            <option value="gross">gross (VAT included)</option>
          </select>
        </Field>
        <Field label="VAT" htmlFor={id('taxClass')} hint="Small businesses (§ 19 UStG) charge none, whatever is chosen.">
          <select
            {...fieldA11y(id('taxClass'), { hint: true })}
            value={draft.taxClass}
            onChange={(e) => set('taxClass', e.target.value as ProductDraft['taxClass'])}
            className="h-9 rounded-md border bg-transparent px-3 text-sm"
          >
            <option value="standard">19 % (standard)</option>
            <option value="reduced">7 % (reduced)</option>
            <option value="zero">0 %</option>
          </select>
        </Field>
        <Field label="Default discount in % (optional)" htmlFor={id('discount')} error={errors.discount}>
          <Input
            {...fieldA11y(id('discount'), { error: errors.discount })}
            inputMode="decimal"
            value={draft.discount}
            onChange={(e) => set('discount', e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={busy}>
          {busy ? 'Saving…' : product ? 'Save changes' : 'Add item'}
        </Button>
      </div>
    </form>
  );
}
