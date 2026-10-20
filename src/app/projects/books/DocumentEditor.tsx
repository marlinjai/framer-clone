'use client';

// src/app/projects/books/DocumentEditor.tsx
//
// The document editor (Books plan phase 2): pick a customer, add and edit
// lines, preview the totals, issue with confirmation, download the PDF, cancel
// an issued invoice through a credit note.
//
// The stateful-flow rules it follows (knowledge-base stateful-flow-testing.md):
//   - The SERVER owns every derived figure. Each change sends one request and
//     renders the whole document the server answers (lines, tax, totals), so a
//     customer swap that turns the invoice into reverse charge shows the
//     recomputed lines at once, and nothing computed here can disagree.
//   - Every change carries the version on screen (`expectedVersion`); a change
//     made in another window answers 409, and the editor reloads and says so
//     instead of overwriting it.
//   - Resume: the editor holds no state of its own beyond the last answer; a
//     reload is a fresh GET. A draft whose customer's tax data changed meanwhile
//     comes back recomputed and marked `stale`, which is shown.
//   - Issue confirms the total and the customer the user is looking at, by
//     version: if anything changed since, nothing is issued.

import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  BooksApiError,
  STATUS_LABELS,
  TYPE_LABELS,
  booksApi,
  pdfUrl,
  type CustomerView,
  type DocumentDetail,
  type LineView,
  type SettingsView,
} from '@/lib/books/api';
import { date, money, moneyInput, parseMoney, parseQuantity, quantity, rate } from '@/lib/books/units';

import { ErrorAlert, Field, ImportedBadge, StatusBadge, errorText } from './ui';

interface LineDraft {
  kind: 'service' | 'product' | 'text';
  title: string;
  quantity: string;
  unitLabel: string;
  unitPrice: string;
  taxClass: 'standard' | 'reduced' | 'zero';
}

const EMPTY_LINE: LineDraft = { kind: 'service', title: '', quantity: '1', unitLabel: 'Std', unitPrice: '', taxClass: 'standard' };

/** The request body of a line form, or the sentence that says what is wrong. */
export function lineBody(d: LineDraft): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (d.title.trim() === '') return { ok: false, message: 'Enter a description for the line.' };
  if (d.kind === 'text') return { ok: true, body: { kind: 'text', title: d.title.trim() } };
  const q = parseQuantity(d.quantity);
  if (q === null || q <= 0) return { ok: false, message: 'Enter a quantity above 0, for example 1,5.' };
  const p = parseMoney(d.unitPrice);
  if (p === null || p < 0) return { ok: false, message: 'Enter a unit price in euros, for example 80,00.' };
  return {
    ok: true,
    body: {
      kind: d.kind,
      title: d.title.trim(),
      quantity: q,
      unitLabel: d.unitLabel.trim() || 'Stk',
      unitPrice: p,
      taxClass: d.taxClass,
    },
  };
}

function draftOf(l: LineView): LineDraft {
  return {
    kind: l.kind,
    title: l.title,
    quantity: l.kind === 'text' ? '' : quantity(l.quantity),
    unitLabel: l.unitLabel,
    unitPrice: l.kind === 'text' ? '' : moneyInput(l.unitPrice),
    taxClass: l.taxClass ?? 'standard',
  };
}

function LineForm({
  value,
  onChange,
  regular,
  idPrefix,
}: {
  value: LineDraft;
  onChange: (v: LineDraft) => void;
  regular: boolean;
  idPrefix: string;
}) {
  const text = value.kind === 'text';
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
      <Field label="Kind" htmlFor={`${idPrefix}-kind`}>
        <select
          id={`${idPrefix}-kind`}
          value={value.kind}
          onChange={(e) => onChange({ ...value, kind: e.target.value as LineDraft['kind'] })}
          className="h-9 rounded-md border bg-transparent px-2 text-sm"
        >
          <option value="service">Service</option>
          <option value="product">Product</option>
          <option value="text">Text only</option>
        </select>
      </Field>
      <div className="col-span-2">
        <Field label="Description" htmlFor={`${idPrefix}-title`}>
          <Input id={`${idPrefix}-title`} value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} />
        </Field>
      </div>
      {!text ? (
        <>
          <Field label="Quantity" htmlFor={`${idPrefix}-qty`}>
            <Input id={`${idPrefix}-qty`} inputMode="decimal" value={value.quantity} onChange={(e) => onChange({ ...value, quantity: e.target.value })} />
          </Field>
          <Field label="Unit" htmlFor={`${idPrefix}-unit`}>
            <Input id={`${idPrefix}-unit`} value={value.unitLabel} onChange={(e) => onChange({ ...value, unitLabel: e.target.value })} />
          </Field>
          <Field label="Unit price (EUR)" htmlFor={`${idPrefix}-price`}>
            <Input id={`${idPrefix}-price`} inputMode="decimal" value={value.unitPrice} onChange={(e) => onChange({ ...value, unitPrice: e.target.value })} />
          </Field>
          {regular ? (
            <Field label="VAT" htmlFor={`${idPrefix}-tax`}>
              <select
                id={`${idPrefix}-tax`}
                value={value.taxClass}
                onChange={(e) => onChange({ ...value, taxClass: e.target.value as LineDraft['taxClass'] })}
                className="h-9 rounded-md border bg-transparent px-2 text-sm"
              >
                <option value="standard">19 %</option>
                <option value="reduced">7 %</option>
                <option value="zero">0 %</option>
              </select>
            </Field>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default function DocumentEditor({ id }: { id: string }) {
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [customers, setCustomers] = useState<CustomerView[]>([]);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newLine, setNewLine] = useState<LineDraft>(EMPTY_LINE);
  const [editing, setEditing] = useState<{ id: string; value: LineDraft } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [d, c, s] = await Promise.all([booksApi.document(id), booksApi.customers(), booksApi.settings()]);
      setDetail(d);
      setCustomers(c.items);
      setSettings(s);
    } catch (err) {
      if (err instanceof BooksApiError && err.status !== 409 && err.status !== 503) setFatal(errorText(err));
      else setError(errorText(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Run one change; render the server's answer; on a stale version reload and say so. */
  async function change(fn: () => Promise<DocumentDetail>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setDetail(await fn());
      return true;
    } catch (err) {
      setError(errorText(err));
      if (err instanceof BooksApiError && (err.code === 'concurrent_edit' || err.code === 'not_draft')) await load();
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (fatal) {
    return (
      <main className="mx-auto w-full max-w-4xl px-6 py-12">
        <p className="text-sm">{fatal}</p>
        <Link href="/projects/books" className="mt-4 inline-block text-sm underline underline-offset-4">
          Back to the Books
        </Link>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="mx-auto w-full max-w-4xl px-6 py-12">
        <ErrorAlert message={error} />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  const doc = detail.document;
  const draft = doc.status === 'draft';
  const imported = doc.source === 'import';
  const version = doc.version;
  const regular = !doc.kleinunternehmer;
  const nextNumber = settings?.counters.find((c) => c.docType === doc.docType)?.nextNumber ?? null;
  const usable = customers.filter((c) => !c.archivedAt);
  const recipientName = doc.customerSnapshot?.name ?? detail.customer?.contact?.name ?? null;
  const cancellable = doc.docType === 'invoice' && ['issued', 'sent', 'paid'].includes(doc.status);
  const sign = doc.docType === 'credit_note' ? -1 : 1;

  async function addLine(e: React.FormEvent) {
    e.preventDefault();
    const body = lineBody(newLine);
    if (!body.ok) return setError(body.message);
    if (await change(() => booksApi.addLine(id, { ...body.body, expectedVersion: version }))) setNewLine(EMPTY_LINE);
  }

  async function saveLine() {
    if (!editing) return;
    const body = lineBody(editing.value);
    if (!body.ok) return setError(body.message);
    if (await change(() => booksApi.updateLine(id, editing.id, { ...body.body, expectedVersion: version }))) setEditing(null);
  }

  function move(index: number, by: -1 | 1) {
    const ids = detail!.lines.map((l) => l.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void change(() => booksApi.reorderLines(id, ids, version));
  }

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const res = await booksApi.issue(id, version);
      setDetail(res.document);
      setConfirming(false);
      setNotice(
        res.render.stored
          ? `Issued as ${res.document.document.documentNumber}. The PDF is stored and ready to download.`
          : `Issued as ${res.document.document.documentNumber}. The PDF will be created on the first download.`,
      );
    } catch (err) {
      setConfirming(false);
      setError(errorText(err));
      if (err instanceof BooksApiError && err.code === 'concurrent_edit') await load();
    } finally {
      setBusy(false);
    }
  }

  async function cancel(e: React.FormEvent) {
    e.preventDefault();
    if (!cancelReason || cancelReason.trim() === '') return setError('Enter a short reason for the cancellation.');
    setBusy(true);
    setError(null);
    try {
      const res = await booksApi.cancel(id, cancelReason.trim());
      setDetail(res.invoice);
      setCancelReason(null);
      setNotice(`Cancelled by credit note ${res.creditNote.document.documentNumber}.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/projects/books" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Books
          </Link>
          <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-tight">
            {TYPE_LABELS[doc.docType]} {doc.documentNumber ?? ''}
            <StatusBadge status={doc.status} />
            {imported ? <ImportedBadge /> : null}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {draft
              ? `Draft: the number is given when you issue it${nextNumber ? ` (next: ${nextNumber})` : ''}.`
              : `${STATUS_LABELS[doc.status]} on ${date(doc.issueDate)}${doc.dueDate ? ` · due ${date(doc.dueDate)}` : ''}${
                  imported ? ' · imported, the original PDF is the document of record' : ''
                }`}
          </p>
        </div>
        <div className="flex gap-2">
          <a href={pdfUrl(id)} className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent">
            {draft ? 'Preview PDF' : imported ? 'Download original PDF' : 'Download PDF'}
          </a>
          {draft ? (
            <Button onClick={() => setConfirming(true)} disabled={busy || detail.lines.length === 0}>
              Issue…
            </Button>
          ) : null}
        </div>
      </header>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      {notice ? (
        <div role="status" className="mb-4 rounded-md border px-4 py-3 text-sm">
          {notice}
        </div>
      ) : null}
      {detail.stale ? (
        <div role="status" className="mb-4 rounded-md border border-dashed px-4 py-3 text-sm">
          The customer’s tax details changed since this draft was last saved. The figures below are recalculated and
          are saved with your next change or when you issue.
        </div>
      ) : null}

      {confirming ? (
        <section role="dialog" aria-label="Confirm issue" className="mb-6 rounded-lg border p-4">
          <h2 className="font-medium">Issue this invoice?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            To {recipientName ?? 'no customer'}, total {money(doc.total)}
            {nextNumber ? `, as number ${nextNumber}` : ''}. An issued invoice can no longer be changed; it can only be
            cancelled with a credit note.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Back
            </Button>
            <Button onClick={issue} disabled={busy}>
              {busy ? 'Issuing…' : 'Issue invoice'}
            </Button>
          </div>
        </section>
      ) : null}

      <section className="mb-6 grid grid-cols-1 gap-4 rounded-lg border p-4 sm:grid-cols-2" aria-label="Recipient and dates">
        {draft ? (
          <Field label="Customer" htmlFor="doc-customer">
            <select
              id="doc-customer"
              value={doc.customerId ?? ''}
              disabled={busy}
              onChange={(e) => e.target.value && change(() => booksApi.setCustomer(id, e.target.value, version))}
              className="h-9 rounded-md border bg-transparent px-2 text-sm"
            >
              <option value="">Choose a customer…</option>
              {usable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.contact?.name ?? c.contactId}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="text-sm">
            <div className="text-xs font-medium text-muted-foreground">Recipient (as issued)</div>
            {doc.customerSnapshot ? (
              <address className="not-italic">
                {doc.customerSnapshot.name}
                <br />
                {doc.customerSnapshot.addressLine1}
                <br />
                {doc.customerSnapshot.postalCode} {doc.customerSnapshot.city}
              </address>
            ) : null}
          </div>
        )}
        {draft ? (
          <Field
            label="Service date"
            htmlFor="doc-service-date"
            hint={regular ? 'Required before issuing under regular VAT.' : 'Optional; without it the issue date counts.'}
          >
            <Input
              id="doc-service-date"
              type="date"
              defaultValue={doc.serviceDate ?? ''}
              disabled={busy}
              onBlur={(e) => {
                const v = e.target.value || null;
                if (v !== doc.serviceDate) void change(() => booksApi.updateDraft(id, { serviceDate: v, expectedVersion: version }));
              }}
            />
          </Field>
        ) : (
          <div className="text-sm">
            <div className="text-xs font-medium text-muted-foreground">Service date</div>
            {doc.servicePeriodStart
              ? `${date(doc.servicePeriodStart)} to ${date(doc.servicePeriodEnd)}`
              : doc.serviceDate
                ? date(doc.serviceDate)
                : 'Same as the issue date'}
          </div>
        )}
        {detail.customer && detail.customer.drift.length > 0 && draft ? (
          <p className="text-xs text-muted-foreground sm:col-span-2">
            The contact’s {detail.customer.drift.join(' and ')} differ from the customer’s tax details; the invoice uses
            the customer’s.
          </p>
        ) : null}
      </section>

      <section aria-label="Lines" className="mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 pr-2 font-medium">Description</th>
              <th className="py-2 pr-2 text-right font-medium">Quantity</th>
              <th className="py-2 pr-2 text-right font-medium">Unit price</th>
              {regular ? <th className="py-2 pr-2 text-right font-medium">VAT</th> : null}
              <th className="py-2 text-right font-medium">Amount</th>
              {draft ? <th className="w-0" /> : null}
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((l, i) =>
              editing?.id === l.id ? (
                <tr key={l.id} className="border-b">
                  <td colSpan={draft ? (regular ? 6 : 5) : 5} className="py-3">
                    <LineForm value={editing.value} onChange={(v) => setEditing({ id: l.id, value: v })} regular={regular} idPrefix={`edit-${l.id}`} />
                    <div className="mt-2 flex justify-end gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                      <Button size="sm" onClick={saveLine} disabled={busy}>
                        Save line
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={l.id} className="border-b align-top" data-testid="line">
                  <td className={`py-2 pr-2 ${l.kind === 'text' ? 'italic text-muted-foreground' : ''}`}>{l.title}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{l.kind === 'text' ? '' : `${quantity(l.quantity)} ${l.unitLabel}`}</td>
                  <td className="py-2 pr-2 text-right tabular-nums">{l.kind === 'text' ? '' : money(l.unitPrice)}</td>
                  {regular ? (
                    <td className="py-2 pr-2 text-right tabular-nums" data-testid="line-tax">
                      {l.kind === 'text' ? '' : l.taxTreatment === 'reverse_charge' ? 'reverse charge' : rate(l.taxRate)}
                    </td>
                  ) : null}
                  <td className="py-2 text-right tabular-nums">{l.kind === 'text' ? '' : money(sign * l.subtotal)}</td>
                  {draft ? (
                    <td className="whitespace-nowrap py-1 pl-2 text-right">
                      <Button size="sm" variant="ghost" aria-label={`Move ${l.title} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move ${l.title} down`}
                        disabled={busy || i === detail.lines.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        ↓
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ id: l.id, value: draftOf(l) })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => change(() => booksApi.removeLine(id, l.id, version))}>
                        Remove
                      </Button>
                    </td>
                  ) : null}
                </tr>
              ),
            )}
          </tbody>
        </table>
        {detail.lines.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No lines yet.</p> : null}

        {draft ? (
          <form onSubmit={addLine} className="mt-4 rounded-lg border p-4" aria-label="Add line">
            <LineForm value={newLine} onChange={setNewLine} regular={regular} idPrefix="new" />
            <div className="mt-2 flex justify-end">
              <Button type="submit" size="sm" disabled={busy}>
                Add line
              </Button>
            </div>
          </form>
        ) : null}
      </section>

      <section aria-label="Totals" className="mb-6 ml-auto w-full max-w-sm text-sm">
        {regular
          ? doc.taxSummary.map((g) => (
              <div key={`${g.taxRate}-${g.taxTreatment}`} className="flex justify-between py-0.5 text-muted-foreground">
                <span>
                  {g.taxTreatment === 'reverse_charge' ? 'Reverse charge' : `VAT ${rate(g.taxRate)} on ${money(sign * g.net)}`}
                </span>
                <span className="tabular-nums">{money(sign * g.tax)}</span>
              </div>
            ))
          : null}
        {regular ? (
          <div className="flex justify-between py-0.5">
            <span>Net</span>
            <span className="tabular-nums">{money(sign * doc.subtotal)}</span>
          </div>
        ) : null}
        <div className="flex justify-between border-t py-1 font-semibold">
          <span>Total</span>
          <span className="tabular-nums" data-testid="total">
            {money(sign * doc.total)}
          </span>
        </div>
        {doc.taxNote ? <p className="mt-2 text-xs text-muted-foreground">{doc.taxNote}</p> : null}
      </section>

      {cancellable ? (
        cancelReason === null ? (
          <Button variant="outline" onClick={() => setCancelReason('')}>
            Cancel with a credit note…
          </Button>
        ) : (
          <form onSubmit={cancel} className="rounded-lg border p-4" aria-label="Cancel invoice">
            <Field label="Reason (short, no personal data)" htmlFor="cancel-reason">
              <Input id="cancel-reason" maxLength={200} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </Field>
            <p className="mt-2 text-xs text-muted-foreground">
              A credit note offsetting the full amount is issued with its own number; the invoice stays as it was and is
              marked cancelled.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setCancelReason(null)}>
                Back
              </Button>
              <Button type="submit" variant="destructive" disabled={busy}>
                Issue credit note
              </Button>
            </div>
          </form>
        )
      ) : null}
      {doc.correctsDocumentId ? (
        <Link href={`/projects/books/documents/${doc.correctsDocumentId}`} className="text-sm underline underline-offset-4">
          Open the cancelled invoice
        </Link>
      ) : null}
    </main>
  );
}
