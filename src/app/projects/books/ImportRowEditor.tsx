'use client';

// src/app/projects/books/ImportRowEditor.tsx
//
// One staged past invoice beside its PDF: every printed field the import uses
// (number, dates, recipient, sender as printed, the lines with their discounts
// and VAT, total, currency, tax treatment), the problems named by the server,
// and the fields the AI was unsure about marked. Saving sends the corrected
// printed invoice keyed to the reading it corrects (the parent passes the
// row's extraction id and version); the server validates it again and answers
// the new problems. The form is keyed to the reading (the parent's `key`), so
// when the invoice is read again the form starts from the new reading, never
// from edits of the old one.

import React, { useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { importPdfUrl, type ImportItemView, type PrintedInvoice, type PrintedLine } from '@/lib/books/api';
import { pathLabel, problemText } from '@/lib/books/importProblems';

import { Field } from './ui';

/** A decimal typed either way ("1.234,50", "1234.5"); null for empty, NaN for not a number. */
export function readDecimal(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return /^-?\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

const show = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

interface LineForm {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discount: string;
  lineTotal: string;
  taxRate: string;
  taxAmount: string;
}

interface TaxGroupForm {
  rate: string;
  net: string;
  tax: string;
}

interface Form {
  number: string;
  issueDate: string;
  serviceDate: string;
  servicePeriod: string;
  currency: string;
  taxTreatment: string;
  total: string;
  taxNote: string;
  paymentTerms: string;
  pricesIncludeVat: boolean;
  recipientName: string;
  recipientLines: string;
  recipientCountry: string;
  recipientVatId: string;
  senderName: string;
  senderLines: string;
  senderCountry: string;
  senderTaxNumber: string;
  senderVatId: string;
  lines: LineForm[];
  /** The printed VAT summary per rate (regular taxation): line VAT not printed is derived from it. */
  taxAmounts: TaxGroupForm[];
}

function toForm(p: PrintedInvoice | null): Form {
  return {
    number: p?.number == null ? '' : String(p.number),
    issueDate: p?.issueDate ?? '',
    serviceDate: p?.serviceDate ?? '',
    servicePeriod: typeof p?.servicePeriod === 'string' ? p.servicePeriod : '',
    currency: p?.currency ?? 'EUR',
    taxTreatment: p?.taxTreatment ?? 'small_business',
    total: show(p?.total),
    taxNote: p?.taxNote ?? '',
    paymentTerms: p?.paymentTerms ?? '',
    pricesIncludeVat: p?.pricesIncludeVat === true,
    recipientName: p?.recipient?.name ?? '',
    recipientLines: (p?.recipient?.addressLines ?? []).join('\n'),
    recipientCountry: p?.recipient?.country ?? p?.recipient?.countryInferred ?? '',
    recipientVatId: p?.recipientVatId ?? '',
    senderName: p?.sender?.name ?? '',
    senderLines: (p?.sender?.addressLines ?? []).join('\n'),
    senderCountry: p?.sender?.country ?? '',
    senderTaxNumber: p?.sender?.taxNumber ?? '',
    senderVatId: p?.sender?.vatId ?? '',
    lines: (p?.lines ?? []).map((l) => ({
      description: l.description,
      quantity: show(l.quantity),
      unit: l.unit ?? '',
      unitPrice: show(l.unitPrice),
      discount: l.discount ?? '',
      lineTotal: show(l.lineTotal),
      taxRate: show(l.taxRate),
      taxAmount: show(l.taxAmount),
    })),
    taxAmounts: (p?.taxAmounts ?? []).map((g) => ({ rate: show(g.rate), net: show(g.net), tax: show(g.tax) })),
  };
}

/** The form as a printed invoice, or the label of the first field that is not a number. */
export function fromForm(form: Form, base: PrintedInvoice | null): { ok: true; printed: PrintedInvoice } | { ok: false; field: string } {
  const num = (text: string, field: string): number | null => {
    const v = readDecimal(text);
    if (v !== null && Number.isNaN(v)) throw new Error(`${field} is not a number.`);
    return v;
  };
  const required = (v: number | null, field: string): number => {
    if (v === null) throw new Error(`${field} is missing.`);
    return v;
  };
  try {
    const printedLines: PrintedLine[] = form.lines.map((l, i) => ({
      description: l.description.trim(),
      quantity: num(l.quantity, `Line ${i + 1}, quantity`),
      unit: l.unit.trim() === '' ? null : l.unit.trim(),
      unitPrice: num(l.unitPrice, `Line ${i + 1}, unit price`),
      discount: l.discount.trim() === '' ? null : l.discount.trim(),
      lineTotal: num(l.lineTotal, `Line ${i + 1}, total`) ?? 0,
      taxRate: num(l.taxRate, `Line ${i + 1}, VAT rate`),
      taxAmount: num(l.taxAmount, `Line ${i + 1}, VAT`),
    }));
    const opt = (s: string) => (s.trim() === '' ? null : s.trim());
    const printed: PrintedInvoice = {
      ...(base ?? {}),
      number: opt(form.number),
      issueDate: opt(form.issueDate),
      serviceDate: opt(form.serviceDate),
      servicePeriod: opt(form.servicePeriod),
      recipient:
        form.recipientName.trim() === ''
          ? null
          : {
              name: form.recipientName.trim(),
              addressLines: lines(form.recipientLines),
              // A country the AI inferred (none printed) stays inferred unless the user changed it.
              ...(inferredKept(form, base)
                ? { country: null, countryInferred: base!.recipient!.countryInferred }
                : { country: opt(form.recipientCountry), countryInferred: null }),
              customerNumber: base?.recipient?.customerNumber ?? null,
            },
      recipientVatId: opt(form.recipientVatId),
      sender:
        form.senderName.trim() === ''
          ? null
          : {
              name: form.senderName.trim(),
              addressLines: lines(form.senderLines),
              country: opt(form.senderCountry),
              taxNumber: opt(form.senderTaxNumber),
              vatId: opt(form.senderVatId),
              taxNumberPresent: opt(form.senderTaxNumber) !== null,
              vatIdPresent: opt(form.senderVatId) !== null,
            },
      lines: printedLines,
      total: num(form.total, 'Total'),
      currency: opt(form.currency)?.toUpperCase() ?? null,
      taxTreatment: form.taxTreatment,
      taxAmounts: form.taxAmounts
        .filter((g) => g.rate.trim() !== '' || g.net.trim() !== '' || g.tax.trim() !== '')
        .map((g, i) => ({
          // A rate or VAT left empty in a filled row is asked for, never taken as 0.
          rate: required(num(g.rate, `VAT summary ${i + 1}, rate`), `VAT summary ${i + 1}, rate`),
          net: num(g.net, `VAT summary ${i + 1}, net`),
          tax: required(num(g.tax, `VAT summary ${i + 1}, VAT`), `VAT summary ${i + 1}, VAT`),
        })),
      pricesIncludeVat: form.pricesIncludeVat,
      taxNote: opt(form.taxNote),
      paymentTerms: opt(form.paymentTerms),
    };
    return { ok: true, printed };
  } catch (err) {
    return { ok: false, field: (err as Error).message };
  }
}

/** Whether the form keeps the recipient country the AI inferred (not printed, not changed). */
function inferredKept(form: Form, base: PrintedInvoice | null): boolean {
  const r = base?.recipient;
  return r != null && r.country == null && r.countryInferred != null && form.recipientCountry.trim() === r.countryInferred;
}

const EMPTY_GROUP: TaxGroupForm = { rate: '', net: '', tax: '' };

const EMPTY_LINE: LineForm = { description: '', quantity: '', unit: '', unitPrice: '', discount: '', lineTotal: '', taxRate: '', taxAmount: '' };

export default function ImportRowEditor({
  item,
  busy,
  onSave,
  onRecheck,
  onReadAgain,
  onClose,
}: {
  item: ImportItemView;
  busy: boolean;
  onSave: (printed: PrintedInvoice) => Promise<void>;
  onRecheck: () => Promise<void>;
  onReadAgain: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<Form>(() => toForm(item.printed));
  const [formError, setFormError] = useState<string | null>(null);
  /** "Read again with AI" would replace what the user entered: asked first. */
  const [confirmReread, setConfirmReread] = useState(false);
  const rereadButton = useRef<HTMLButtonElement>(null);
  const initial = useMemo(() => JSON.stringify(toForm(item.printed)), [item.printed]);
  const typedHere = item.corrected || item.extractionId?.startsWith('manual:') === true || JSON.stringify(form) !== initial;
  function readAgain() {
    if (typedHere) return setConfirmReread(true);
    onReadAgain();
  }
  function closeReread() {
    setConfirmReread(false);
    requestAnimationFrame(() => rereadButton.current?.focus());
  }
  const unsure = useMemo(() => new Set(Object.keys(item.confidence)), [item.confidence]);
  const set = (change: Partial<Form>) => setForm((f) => ({ ...f, ...change }));
  const setLine = (i: number, change: Partial<LineForm>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...change } : l)) }));
  // An unsure field: an amber DASHED frame (not colour alone) and the explanation read out with it.
  const hintId = `${item.id}-unsure-hint`;
  const mark = (path: string) => (unsure.has(path) ? 'border-dashed border-2 border-amber-500 ring-1 ring-amber-500' : '');
  const fieldProps = (path: string, extra = '') => ({
    className: `h-9 rounded-md border bg-transparent px-2 text-sm ${mark(path)} ${extra}`,
    ...(unsure.has(path) ? { 'aria-describedby': hintId } : {}),
  });
  const areaProps = (path: string) => ({
    className: `rounded-md border bg-transparent px-2 py-1 text-sm ${mark(path)}`,
    ...(unsure.has(path) ? { 'aria-describedby': hintId } : {}),
  });
  const setGroup = (i: number, change: Partial<TaxGroupForm>) =>
    setForm((f) => ({ ...f, taxAmounts: f.taxAmounts.map((g, j) => (j === i ? { ...g, ...change } : g)) }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const out = fromForm(form, item.printed);
    if (!out.ok) return setFormError(out.field);
    setFormError(null);
    await onSave(out.printed);
  }

  const id = item.id;
  return (
    <section aria-label="Check past invoice" className="mt-6 grid grid-cols-1 gap-6 rounded-lg border p-4 lg:grid-cols-2">
      <div className="min-h-[32rem]">
        <iframe title="Invoice PDF" src={importPdfUrl(id)} className="h-full min-h-[32rem] w-full rounded-md border" />
      </div>
      <form aria-label="Invoice as printed" onSubmit={save} className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-medium">Check the invoice as printed</h2>
          <button type="button" className="text-sm underline underline-offset-4" onClick={onClose}>
            Close
          </button>
        </div>
        {item.problems.length > 0 ? (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Problems">
            {item.problems.map((p, i) => (
              <li key={i} className={p.blocking ? 'text-destructive' : 'text-muted-foreground'}>
                {pathLabel(p.path) ? `${pathLabel(p.path)}: ` : ''}
                {problemText(p)}
              </li>
            ))}
          </ul>
        ) : null}
        {unsure.size > 0 ? (
          <p id={hintId} className="text-xs text-muted-foreground">
            Fields with a dashed amber frame: the AI was not sure. Compare them with the PDF.
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Invoice number" htmlFor={`${id}-number`}>
            <input id={`${id}-number`} value={form.number} onChange={(e) => set({ number: e.target.value })} {...fieldProps('number')} />
          </Field>
          <Field label="Invoice date" htmlFor={`${id}-date`} hint="YYYY-MM-DD">
            <input id={`${id}-date`} value={form.issueDate} onChange={(e) => set({ issueDate: e.target.value })} {...fieldProps('issueDate')} />
          </Field>
          <Field label="Service date" htmlFor={`${id}-sdate`}>
            <input id={`${id}-sdate`} value={form.serviceDate} onChange={(e) => set({ serviceDate: e.target.value })} {...fieldProps('serviceDate')} />
          </Field>
          <Field label="Service period (as printed)" htmlFor={`${id}-period`}>
            <input id={`${id}-period`} value={form.servicePeriod} onChange={(e) => set({ servicePeriod: e.target.value })} {...fieldProps('servicePeriod')} />
          </Field>
          <Field label="Currency" htmlFor={`${id}-currency`} hint="Kept as printed, never converted">
            <input id={`${id}-currency`} value={form.currency} onChange={(e) => set({ currency: e.target.value })} {...fieldProps('currency')} />
          </Field>
          <Field label="Tax" htmlFor={`${id}-tax`}>
            <select id={`${id}-tax`} value={form.taxTreatment} onChange={(e) => set({ taxTreatment: e.target.value })} {...fieldProps('taxTreatment')}>
              <option value="small_business">No VAT (§ 19 UStG)</option>
              <option value="regular">VAT charged</option>
              <option value="reverse_charge">Reverse charge (§ 13b UStG)</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Total" htmlFor={`${id}-total`}>
            <input id={`${id}-total`} value={form.total} onChange={(e) => set({ total: e.target.value })} {...fieldProps('total')} inputMode="decimal" />
          </Field>
          <Field label="Payment terms" htmlFor={`${id}-terms`}>
            <input id={`${id}-terms`} value={form.paymentTerms} onChange={(e) => set({ paymentTerms: e.target.value })} {...fieldProps('paymentTerms')} />
          </Field>
        </div>
        <Field label="Tax note (as printed)" htmlFor={`${id}-note`}>
          <input id={`${id}-note`} value={form.taxNote} onChange={(e) => set({ taxNote: e.target.value })} {...fieldProps('taxNote')} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.pricesIncludeVat} onChange={(e) => set({ pricesIncludeVat: e.target.checked })} />
          Line prices include VAT
        </label>

        <fieldset className="grid grid-cols-2 gap-3 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Recipient</legend>
          <Field label="Name" htmlFor={`${id}-rname`}>
            <input id={`${id}-rname`} value={form.recipientName} onChange={(e) => set({ recipientName: e.target.value })} {...fieldProps('recipient.name')} />
          </Field>
          <Field label="Country" htmlFor={`${id}-rcountry`}>
            <input id={`${id}-rcountry`} value={form.recipientCountry} onChange={(e) => set({ recipientCountry: e.target.value })} {...fieldProps('recipient.country')} />
          </Field>
          <Field label="Address (one line each)" htmlFor={`${id}-rlines`}>
            <textarea id={`${id}-rlines`} value={form.recipientLines} onChange={(e) => set({ recipientLines: e.target.value })} rows={3} {...areaProps('recipient.addressLines')} />
          </Field>
          <Field label="VAT id (as printed)" htmlFor={`${id}-rvat`}>
            <input id={`${id}-rvat`} value={form.recipientVatId} onChange={(e) => set({ recipientVatId: e.target.value })} {...fieldProps('recipientVatId')} />
          </Field>
        </fieldset>

        <fieldset className="grid grid-cols-2 gap-3 rounded-md border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Sender as printed (empty fields come from the company settings)</legend>
          <Field label="Name" htmlFor={`${id}-sname`}>
            <input id={`${id}-sname`} value={form.senderName} onChange={(e) => set({ senderName: e.target.value })} {...fieldProps('sender.name')} />
          </Field>
          <Field label="Country" htmlFor={`${id}-scountry`}>
            <input id={`${id}-scountry`} value={form.senderCountry} onChange={(e) => set({ senderCountry: e.target.value })} {...fieldProps('sender.country')} />
          </Field>
          <Field label="Address (one line each)" htmlFor={`${id}-slines`}>
            <textarea id={`${id}-slines`} value={form.senderLines} onChange={(e) => set({ senderLines: e.target.value })} rows={3} {...areaProps('sender.addressLines')} />
          </Field>
          <div className="flex flex-col gap-3">
            <Field label="Tax number" htmlFor={`${id}-stax`}>
              <input id={`${id}-stax`} value={form.senderTaxNumber} onChange={(e) => set({ senderTaxNumber: e.target.value })} {...fieldProps('sender.taxNumber')} />
            </Field>
            <Field label="VAT id" htmlFor={`${id}-svat`}>
              <input id={`${id}-svat`} value={form.senderVatId} onChange={(e) => set({ senderVatId: e.target.value })} {...fieldProps('sender.vatId')} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="rounded-md border p-3">
          <legend className="px-1 text-xs font-medium text-muted-foreground">Lines (a discount printed as its own line has a minus total)</legend>
          <div className="flex flex-col gap-3">
            {form.lines.map((l, i) => (
              <div key={i} className="grid grid-cols-4 gap-2" aria-label={`Line ${i + 1}`} role="group">
                <input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} {...fieldProps(`lines.${i}.description`, 'col-span-4')} />
                <input aria-label={`Line ${i + 1} quantity`} placeholder="Qty" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} {...fieldProps(`lines.${i}.quantity`)} />
                <input aria-label={`Line ${i + 1} unit`} placeholder="Unit" value={l.unit} onChange={(e) => setLine(i, { unit: e.target.value })} {...fieldProps(`lines.${i}.unit`)} />
                <input aria-label={`Line ${i + 1} unit price`} placeholder="Unit price" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} {...fieldProps(`lines.${i}.unitPrice`)} />
                <input aria-label={`Line ${i + 1} total`} placeholder="Total" value={l.lineTotal} onChange={(e) => setLine(i, { lineTotal: e.target.value })} {...fieldProps(`lines.${i}.lineTotal`)} />
                <input aria-label={`Line ${i + 1} discount`} placeholder="Discount (10 %)" value={l.discount} onChange={(e) => setLine(i, { discount: e.target.value })} {...fieldProps(`lines.${i}.discount`)} />
                <input aria-label={`Line ${i + 1} VAT rate`} placeholder="VAT %" value={l.taxRate} onChange={(e) => setLine(i, { taxRate: e.target.value })} {...fieldProps(`lines.${i}.taxRate`)} />
                <input aria-label={`Line ${i + 1} VAT`} placeholder="VAT" value={l.taxAmount} onChange={(e) => setLine(i, { taxAmount: e.target.value })} {...fieldProps(`lines.${i}.taxAmount`)} />
                <button type="button" className="text-left text-xs underline underline-offset-4" onClick={() => setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))}>
                  Remove line
                </button>
              </div>
            ))}
            <button type="button" className="self-start text-sm underline underline-offset-4" onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, EMPTY_LINE] }))}>
              Add line
            </button>
          </div>
        </fieldset>

        {form.taxTreatment === 'regular' || form.taxAmounts.length > 0 ? (
          <fieldset className="rounded-md border p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">
              VAT summary as printed, per rate (a line without its own VAT gets it from here)
            </legend>
            <div className="flex flex-col gap-2">
              {form.taxAmounts.map((g, i) => (
                <div key={i} className="grid grid-cols-4 gap-2" role="group" aria-label={`VAT summary ${i + 1}`}>
                  <input aria-label={`VAT summary ${i + 1} rate`} placeholder="Rate %" value={g.rate} onChange={(e) => setGroup(i, { rate: e.target.value })} {...fieldProps(`taxAmounts.${i}.rate`)} />
                  <input aria-label={`VAT summary ${i + 1} net`} placeholder="Net" value={g.net} onChange={(e) => setGroup(i, { net: e.target.value })} {...fieldProps(`taxAmounts.${i}.net`)} />
                  <input aria-label={`VAT summary ${i + 1} VAT`} placeholder="VAT" value={g.tax} onChange={(e) => setGroup(i, { tax: e.target.value })} {...fieldProps(`taxAmounts.${i}.tax`)} />
                  <button type="button" className="text-left text-xs underline underline-offset-4" onClick={() => setForm((f) => ({ ...f, taxAmounts: f.taxAmounts.filter((_, j) => j !== i) }))}>
                    Remove rate
                  </button>
                </div>
              ))}
              <button type="button" className="self-start text-sm underline underline-offset-4" onClick={() => setForm((f) => ({ ...f, taxAmounts: [...f.taxAmounts, EMPTY_GROUP] }))}>
                Add rate
              </button>
            </div>
          </fieldset>
        ) : null}

        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
        {confirmReread ? (
          <div
            role="alertdialog"
            aria-label="Replace what you entered"
            aria-describedby={`${id}-reread-text`}
            className="rounded-md border border-amber-500 p-3 text-sm"
            onKeyDown={(e) => e.key === 'Escape' && closeReread()}
          >
            <p id={`${id}-reread-text`}>Reading again replaces what you entered or corrected here with a new reading by the AI.</p>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setConfirmReread(false);
                  onReadAgain();
                }}
              >
                Replace with a new reading
              </Button>
              <Button type="button" size="sm" variant="ghost" autoFocus onClick={closeReread}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={rereadButton} type="button" variant="ghost" onClick={readAgain} disabled={busy}>
            Read again with AI
          </Button>
          <Button type="button" variant="outline" onClick={() => void onRecheck()} disabled={busy}>
            Check again
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save corrections'}
          </Button>
        </div>
      </form>
    </section>
  );
}
