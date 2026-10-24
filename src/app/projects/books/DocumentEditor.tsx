'use client';

// src/app/projects/books/DocumentEditor.tsx
//
// The document editor (Books plan phase 2): pick a customer, add and edit
// lines, preview the totals, issue with confirmation, download the PDF, cancel
// an issued invoice through a credit note, or correct it ("Correct": a
// replacement draft prefilled with its data; issuing that draft cancels the
// old invoice with a credit note in the same step, plan
// docs/plans/2026-10-21-books-visual-template-composer.md, decision 9).
//
// A draft is written ON the invoice page on a wide screen (InvoicePage, the
// WYSIWYG invoice editor plan): the real A4 page in the company's template,
// every field edited in place. Narrow windows, browsers without Web Workers,
// and anyone who prefers it get the form below ("Use the form"); both send the
// same requests through the same change path.
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
import { useRouter } from 'next/navigation';
import React, { useCallback, useEffect, useRef, useState } from 'react';

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
  type DocumentRef,
  type LineView,
  type SettingsView,
} from '@/lib/books/api';
import { browserRenderSupported } from '@/lib/books/engine';
import { isStyled } from '@/server/books/render/richText';
import { date, money, moneyInput, parseMoney, parseQuantity, quantity, quantityInput, rate } from '@/lib/books/units';

import InvoicePage from './invoice/InvoicePage';
import StoredPdf from './invoice/StoredPdf';
import { ErrorAlert, Field, ImportedBadge, StatusBadge, errorText, fieldA11y } from './ui';

/** The invoice page needs room for an A4 page and its margin controls. */
const PAGE_MIN_WIDTH = '(min-width: 1024px)';

/** Whether the window is wide enough for the invoice page (follows resizing). */
function useWideWindow(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PAGE_MIN_WIDTH);
    setWide(query.matches);
    const on = () => setWide(query.matches);
    query.addEventListener('change', on);
    return () => query.removeEventListener('change', on);
  }, []);
  return wide;
}

const FORM_PREFERENCE = 'books-editor-form';

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
    quantity: l.kind === 'text' ? '' : quantityInput(l.quantity),
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
  const [detail, setDetailState] = useState<DocumentDetail | null>(null);
  // Whether the template prints the subject: answered by the document's own GET and PATCH, kept between them.
  const [printsSubject, setPrintsSubject] = useState<boolean | null>(null);
  // The version of the latest answer, set with every answer, so a save queued behind another (the form's texts)
  // sends the version that answer produced, not the one of the last render.
  const versionRef = useRef(0);
  const setDetail = useCallback((d: DocumentDetail) => {
    versionRef.current = d.document.version;
    if (d.printsSubject !== undefined) setPrintsSubject(d.printsSubject);
    setDetailState(d);
  }, []);
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
  const router = useRouter();
  const wide = useWideWindow();
  const [preferForm, setPreferForm] = useState(false);
  const [canRender, setCanRender] = useState(false);
  useEffect(() => {
    setCanRender(browserRenderSupported());
    try {
      setPreferForm(window.localStorage.getItem(FORM_PREFERENCE) === '1');
    } catch {
      // Blocked storage: the page is the default.
    }
  }, []);
  const chooseForm = (form: boolean) => {
    setPreferForm(form);
    try {
      window.localStorage.setItem(FORM_PREFERENCE, form ? '1' : '0');
    } catch {
      // Remembering the choice is a nicety.
    }
  };

  const load = useCallback(async () => {
    try {
      // Every customer, not only the first page: the picker must offer all of them.
      const [d, c, s] = await Promise.all([booksApi.document(id), booksApi.allCustomers(), booksApi.settings()]);
      setDetail(d);
      setCustomers(c);
      setSettings(s);
    } catch (err) {
      if (err instanceof BooksApiError && err.status !== 409 && err.status !== 503) setFatal(errorText(err));
      else setError(errorText(err));
    }
  }, [id, setDetail]);

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
  // Correct: an issued, not cancelled invoice made here (imports keep plain cancellation).
  const correctable = cancellable && !imported;
  const { replaces, replacedBy } = detail.related;
  const replacing = draft && replaces !== null;
  const sign = doc.docType === 'credit_note' ? -1 : 1;
  // The invoice page: a draft made here, on a wide screen, in a browser that can draw it, unless the form is preferred.
  const pageCapable = draft && !imported && wide && canRender;
  const onPage = pageCapable && !preferForm;

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
      const issuedAs = `Issued as ${res.document.document.documentNumber}.`;
      const replacedNote = res.replaced
        ? ` Invoice ${res.document.related.replaces?.documentNumber ?? ''} is cancelled with a credit note.`
        : '';
      setNotice(
        res.render.stored
          ? `${issuedAs}${replacedNote} The PDF is stored and ready to download.`
          : `${issuedAs}${replacedNote} The PDF will be created on the first download.`,
      );
    } catch (err) {
      setConfirming(false);
      setError(errorText(err));
      if (err instanceof BooksApiError && (err.code === 'concurrent_edit' || err.code === 'replaced_invoice_cancelled')) {
        await load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function correct() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await booksApi.correct(id);
      router.push(`/projects/books/documents/${res.document.document.id}`);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof BooksApiError && err.code === 'not_correctable') await load();
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
          {pageCapable ? (
            <Button variant="ghost" onClick={() => chooseForm(!preferForm)}>
              {preferForm ? 'Edit on the page' : 'Use the form'}
            </Button>
          ) : null}
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
      {replacing && replaces ? (
        <section role="region" aria-label="Correction" className="mb-4 rounded-md border px-4 py-3 text-sm">
          {replaces.status === 'cancelled' ? (
            <>
              <p>
                This draft was started to replace invoice {replaces.documentNumber}, which has been cancelled in the
                meantime. Issue it as an ordinary invoice, or leave it.
              </p>
              <div className="mt-3">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void change(() => booksApi.updateDraft(id, { replacesDocumentId: null, expectedVersion: version }))}
                >
                  Make it an ordinary invoice
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>
                This draft replaces invoice {replaces.documentNumber} of {date(replaces.issueDate)}. When you issue it,
                invoice {replaces.documentNumber} is cancelled with a credit note and this one gets a new number, in one
                step. Until then invoice {replaces.documentNumber} stays valid.
              </p>
              <label className="mt-3 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={doc.printReplacesReference}
                  disabled={busy}
                  onChange={(e) =>
                    void change(() =>
                      booksApi.updateDraft(id, { printReplacesReference: e.target.checked, expectedVersion: version }),
                    )
                  }
                />
                Print “Ersetzt Rechnung {replaces.documentNumber} vom {date(replaces.issueDate)}” under the title
              </label>
            </>
          )}
        </section>
      ) : null}

      {confirming ? (
        <section role="dialog" aria-label="Confirm issue" className="mb-6 rounded-lg border p-4">
          <h2 className="font-medium">Issue this invoice?</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            To {recipientName ?? 'no customer'}, total {money(doc.total, doc.currencyCode)}
            {nextNumber ? `, as number ${nextNumber}` : ''}. An issued invoice can no longer be changed; it can only be
            cancelled with a credit note.
          </p>
          {replacing && replaces ? (
            <p className="mt-2 text-sm">
              Invoice {replaces.documentNumber} is cancelled with a credit note at the same time.
            </p>
          ) : null}
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

      {onPage ? <InvoicePage id={id} detail={detail} customers={usable} busy={busy} change={change} /> : null}
      {!draft && wide ? <StoredPdf id={id} version={doc.version} imported={imported} /> : null}

      {onPage ? null : (
      <>
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

      <DocumentTexts id={id} doc={doc} draft={draft} printsSubject={printsSubject} change={change} versionRef={versionRef} />

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
                  <td className="py-2 pr-2 text-right tabular-nums">{l.kind === 'text' ? '' : money(l.unitPrice, doc.currencyCode)}</td>
                  {regular ? (
                    <td className="py-2 pr-2 text-right tabular-nums" data-testid="line-tax">
                      {l.kind === 'text' ? '' : l.taxTreatment === 'reverse_charge' ? 'reverse charge' : rate(l.taxRate)}
                    </td>
                  ) : null}
                  <td className="py-2 text-right tabular-nums">{l.kind === 'text' ? '' : money(sign * l.subtotal, doc.currencyCode)}</td>
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
                  {g.taxTreatment === 'reverse_charge' ? 'Reverse charge' : `VAT ${rate(g.taxRate)} on ${money(sign * g.net, doc.currencyCode)}`}
                </span>
                <span className="tabular-nums">{money(sign * g.tax, doc.currencyCode)}</span>
              </div>
            ))
          : null}
        {regular ? (
          <div className="flex justify-between py-0.5">
            <span>Net</span>
            <span className="tabular-nums">{money(sign * doc.subtotal, doc.currencyCode)}</span>
          </div>
        ) : null}
        <div className="flex justify-between border-t py-1 font-semibold">
          <span>Total</span>
          <span className="tabular-nums" data-testid="total">
            {money(sign * doc.total, doc.currencyCode)}
          </span>
        </div>
        {doc.taxNote ? <p className="mt-2 text-xs text-muted-foreground">{doc.taxNote}</p> : null}
      </section>
      </>
      )}

      {cancellable ? (
        cancelReason === null ? (
          <div className="flex flex-wrap items-center gap-2">
            {correctable ? (
              replacedBy ? (
                <Link
                  href={`/projects/books/documents/${replacedBy.id}`}
                  className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
                >
                  Open the correction draft
                </Link>
              ) : (
                <Button onClick={() => void correct()} disabled={busy}>
                  {busy ? 'Opening…' : 'Correct'}
                </Button>
              )
            ) : null}
            <Button variant="outline" onClick={() => setCancelReason('')} disabled={busy}>
              Cancel with a credit note…
            </Button>
            {correctable ? (
              <p className="w-full text-xs text-muted-foreground">
                Correct opens a new draft with this invoice’s data. This invoice stays valid until you issue the
                corrected one; then it is cancelled with a credit note.
              </p>
            ) : imported ? (
              <p className="w-full text-xs text-muted-foreground">
                An imported invoice cannot be corrected here: cancel it with a credit note and create a new invoice.
              </p>
            ) : null}
          </div>
        ) : (
          <form onSubmit={cancel} className="rounded-lg border p-4" aria-label="Cancel invoice">
            <Field label="Reason (short, no personal data)" htmlFor="cancel-reason">
              <Input id="cancel-reason" maxLength={200} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
            </Field>
            <p className="mt-2 text-xs text-muted-foreground">
              A credit note offsetting the full amount is issued with its own number; the invoice stays as it was and is
              marked cancelled.
            </p>
            {replacedBy && replacedBy.status === 'draft' ? (
              <p className="mt-2 text-sm" role="note">
                A correction draft is open for this invoice. After this cancellation it can no longer replace it; it can
                still be issued as an ordinary invoice.
              </p>
            ) : null}
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
      <RelatedList related={detail.related} />
    </main>
  );
}

const RELATION_LABELS: Record<keyof DocumentDetail['related'], string> = {
  corrects: 'Cancels',
  correctedBy: 'Cancelled by',
  replaces: 'Replaces',
  replacedBy: 'Replaced by',
};

/** The linked documents: the credit note chain and the Correct flow. */
function RelatedList({ related }: { related: DocumentDetail['related'] }) {
  const entries = (Object.keys(RELATION_LABELS) as Array<keyof DocumentDetail['related']>)
    .map((k) => [k, related[k]] as const)
    .filter((e): e is readonly [keyof DocumentDetail['related'], DocumentRef] => e[1] !== null);
  if (entries.length === 0) return null;
  return (
    <section aria-label="Linked documents" className="mt-6 text-sm">
      <h2 className="mb-2 font-medium">Linked documents</h2>
      <ul className="space-y-1">
        {entries.map(([k, ref]) => (
          <li key={k}>
            {k === 'replacedBy' && ref.status === 'draft' ? 'Correction draft (open):' : RELATION_LABELS[k]}{' '}
            <Link href={`/projects/books/documents/${ref.id}`} className="underline underline-offset-4">
              {TYPE_LABELS[ref.docType]} {ref.documentNumber ?? '(draft)'}
            </Link>{' '}
            <span className="text-muted-foreground">({STATUS_LABELS[ref.status]})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const TEXT_FIELDS = [
  { key: 'subject', label: 'Subject', hint: 'One line, printed under the title.', max: 200, multiline: false },
  { key: 'contractReference', label: 'Reference', hint: 'Printed in the document data, for example an order or contract number.', max: 200, multiline: false },
  { key: 'introText', label: 'Intro text', hint: null, max: 4000, multiline: true },
  { key: 'outroText', label: 'Closing text', hint: null, max: 4000, multiline: true },
] as const;
type TextKey = (typeof TEXT_FIELDS)[number]['key'];

/**
 * The document's texts in the form (narrow windows, imports, "Use the form"): the same fields the invoice page
 * edits in place, each saved when it is left. Issued documents show what was printed. The subject is offered only
 * where the template prints it; otherwise the form says how to add it, so nothing is typed that never prints.
 */
function DocumentTexts({
  id,
  doc,
  draft,
  printsSubject,
  change,
  versionRef,
}: {
  id: string;
  doc: DocumentDetail['document'];
  draft: boolean;
  /** Null until the document's own answer said it. */
  printsSubject: boolean | null;
  change: (fn: () => Promise<DocumentDetail>) => Promise<boolean>;
  /** The version of the latest answer, kept by the editor on every answer (a save, a reload after a conflict). */
  versionRef: React.MutableRefObject<number>;
}) {
  // A field whose save failed (or whose text is too long) stays marked, with the reason, until it saves: the
  // banner alone is cleared by the next change and would leave a typed value that looks saved.
  const [problems, setProblems] = useState<Partial<Record<TextKey, string>>>({});
  const mark = (key: TextKey, problem: string | null) =>
    setProblems((p) => {
      const next = { ...p };
      if (problem) next[key] = problem;
      else delete next[key];
      return next;
    });
  // Saves run one after another, each with the version of the latest answer: tabbing from one text to the next
  // saves both, never the second against a version the first has already moved on.
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  const save = (key: TextKey, value: string | null) => {
    queue.current = queue.current.then(async () => {
      const ok = await change(() => booksApi.updateDraft(id, { [key]: value, expectedVersion: versionRef.current }));
      mark(key, ok ? null : 'Not saved: the message above says why. Change the text again to retry.');
    });
  };

  // The subject only where the template prints it (an issued document: where it was printed). A draft whose
  // template has no subject block shows how to add one; a subject typed before the block was removed stays editable.
  const subjectHidden = printsSubject === false && (!draft || !doc.subject);
  const fields = TEXT_FIELDS.filter((f) => !(f.key === 'subject' && subjectHidden));
  if (!draft) {
    const shown = fields.filter((f) => doc[f.key]);
    if (shown.length === 0) return null;
    return (
      <section aria-label="Texts" className="mb-6 rounded-lg border p-4 text-sm">
        <dl className="grid grid-cols-1 gap-3">
          {shown.map((f) => (
            <div key={f.key}>
              <dt className="text-xs font-medium text-muted-foreground">{f.label}</dt>
              <dd className="whitespace-pre-line">{doc[f.key]}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  }
  return (
    <section aria-label="Texts" className="mb-6 grid grid-cols-1 gap-4 rounded-lg border p-4 sm:grid-cols-2">
      {fields.map((f) => {
        const fieldId = `doc-${f.key}`;
        const styled = (f.key === 'introText' && isStyled(doc.introFormat)) || (f.key === 'outroText' && isStyled(doc.outroFormat));
        const note =
          f.key === 'subject' && printsSubject === false
            ? 'Your template has no subject block, so this subject is not printed. Add “Subject” to the template in the template composer.'
            : styled
              ? 'Formatted on the invoice page (bold, italic or a list). Saving it here keeps the words and the line breaks, and removes that formatting.'
              : f.hint;
        return (
          <div key={f.key} className={f.multiline ? 'sm:col-span-2' : undefined}>
            <Field label={f.label} htmlFor={fieldId} hint={note ?? undefined} error={problems[f.key] ?? null}>
              <SavedText
                id={fieldId}
                saved={doc[f.key] ?? ''}
                multiline={f.multiline}
                hint={Boolean(note)}
                error={problems[f.key] ?? null}
                onSave={(raw) => {
                  const v = f.multiline ? raw.trimEnd() : raw.trim();
                  if (v.length > f.max) {
                    mark(f.key, `${f.label} is at most ${f.max} characters (now ${v.length}). Shorten it to save.`);
                    return false;
                  }
                  const next = v === '' ? null : v;
                  if (next !== (doc[f.key] ?? null)) save(f.key, next);
                  else mark(f.key, null);
                  return true;
                }}
              />
            </Field>
          </div>
        );
      })}
      {subjectHidden ? (
        <p className="text-xs text-muted-foreground sm:col-span-2">
          To print a subject line, add “Subject” to your template in the{' '}
          <Link href="/projects/books?tab=templates" className="underline underline-offset-4">
            template composer
          </Link>
          .
        </p>
      ) : null}
    </section>
  );
}

/**
 * A text input that saves what the user changed when it is left (or on Enter in a one-line field, keeping the
 * focus). It shows what is saved: a change saved meanwhile (on the page, in another tab, after a conflict) replaces
 * its value while it is not focused, and a field left without a change takes the saved value instead of sending
 * the old one back, so it never overwrites an edit made elsewhere.
 */
function SavedText({
  id,
  saved,
  multiline,
  hint,
  error,
  onSave,
}: {
  id: string;
  saved: string;
  multiline: boolean;
  hint: boolean;
  error: string | null;
  /** False when the value was refused (too long): it stays as typed, to be shortened. */
  onSave: (value: string) => boolean;
}) {
  const ref = React.useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  // What the field held when the user started on it (or last saved it): only a change from it is theirs to save.
  const since = React.useRef<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.value = saved;
  }, [saved]);
  const commit = (el: HTMLInputElement | HTMLTextAreaElement) => {
    if (since.current !== null && el.value === since.current) {
      // Nothing typed: show what is saved now (it may have changed meanwhile) and send nothing.
      if (!error) el.value = saved;
      return;
    }
    if (onSave(el.value)) since.current = el.value;
  };
  const common = {
    ...fieldA11y(id, { error, hint }),
    ref,
    defaultValue: saved,
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      since.current = e.target.value;
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      commit(e.target);
      since.current = null;
    },
  };
  if (multiline) return <textarea {...common} rows={3} className="w-full rounded-md border bg-transparent px-3 py-2 text-sm" />;
  return (
    <Input
      {...common}
      onKeyDown={(e) => {
        // Enter saves a one-line text and keeps the focus where it is.
        if (e.key === 'Enter') {
          e.preventDefault();
          commit(e.currentTarget);
        }
      }}
    />
  );
}
