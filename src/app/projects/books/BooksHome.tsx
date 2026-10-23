'use client';

// src/app/projects/books/BooksHome.tsx
//
// The Books area of the editor (Books plan phase 2): the active company's
// documents (drafts first, each with its status and, once issued, its number;
// 50 at a time with "Load more" and a count, findable by number and year),
// its customers and its templates, plus the company configuration the Books
// run under (tax status, sender, the next number), read-only because an
// operator sets it with `pnpm books:init-company`.
//
// "New invoice" always creates a NEW draft on the server and opens it (the
// re-entry path: no state of an earlier invoice is carried over, and a draft
// that is never issued consumes no number). Every failure is shown with the
// server's explanation; a company without the Books grant, or not set up yet,
// gets a page that says so instead of broken buttons.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useCallback, useEffect, useState } from 'react';

import { useCursorList, type CursorList } from './useCursorList';

import { Button } from '@/components/ui/button';
import {
  BooksApiError,
  TYPE_LABELS,
  booksApi,
  type CustomerView,
  type DocumentListItem,
  type SettingsView,
} from '@/lib/books/api';
import { date, money } from '@/lib/books/units';

import CustomerForm from './CustomerForm';
import TemplatesPanel from './TemplatesPanel';
import { ErrorAlert, ImportedBadge, StatusBadge, errorText } from './ui';

type Tab = 'documents' | 'customers' | 'templates';

const BLOCKING = new Set([
  'unauthorized',
  'books_not_enabled',
  'sites_not_enabled',
  'no_active_company',
  'forbidden',
  'books_not_provisioned',
]);

export default function BooksHome() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('documents');
  // A link may open a tab directly (the template composer's way back: ?tab=templates).
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('tab');
    if (wanted === 'customers' || wanted === 'templates') setTab(wanted);
  }, []);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [blocked, setBlocked] = useState<BooksApiError | null>(null);
  // The documents' filters: the typed number (applied after a short pause) and the issue year.
  const [numberInput, setNumberInput] = useState('');
  const [number, setNumber] = useState('');
  const [year, setYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);

  const fail = useCallback((err: unknown) => {
    if (err instanceof BooksApiError && BLOCKING.has(err.code)) setBlocked(err);
    else setError(errorText(err));
  }, []);

  useEffect(() => {
    booksApi.settings().then(setSettings, fail);
  }, [fail]);

  useEffect(() => {
    const t = setTimeout(() => setNumber(numberInput.trim()), 300);
    return () => clearTimeout(t);
  }, [numberInput]);

  const validYear = /^(19|20)\d{2}$/.test(year) ? year : '';
  const yearIncomplete = year !== '' && validYear === '';
  // A list's own failure is shown in the list (with a retry); only a page-wide refusal blocks the page.
  const blockOnly = useCallback(
    (err: unknown) => {
      if (err instanceof BooksApiError && BLOCKING.has(err.code)) setBlocked(err);
    },
    [],
  );
  const documents = useCursorList<DocumentListItem>(
    `${number}|${validYear}`,
    (cursor) => booksApi.documents({ number: number || undefined, year: validYear || undefined, cursor }),
    { onFirstPageError: blockOnly, errorText },
  );
  const customers = useCursorList<CustomerView>('customers', (cursor) => booksApi.customers({ cursor }), {
    onFirstPageError: blockOnly,
    errorText,
  });
  // What the list shows is filtered only by the applied filters; "Clear" appears as soon as anything is typed.
  const filtered = number !== '' || validYear !== '';
  const typed = numberInput.trim() !== '' || year !== '';

  async function newInvoice() {
    setCreating(true);
    setError(null);
    try {
      const draft = await booksApi.createDraft({});
      router.push(`/projects/books/documents/${draft.document.id}`);
    } catch (err) {
      fail(err);
      setCreating(false);
    }
  }

  async function archive(id: string) {
    setError(null);
    try {
      await booksApi.archiveCustomer(id);
      await customers.reload({ keepShown: true });
    } catch (err) {
      fail(err);
    }
  }

  if (blocked) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Books</h1>
        <p className="mt-4 text-sm">{blocked.message}</p>
        {blocked.code === 'books_not_enabled' ? (
          <p className="mt-2 text-sm text-muted-foreground">
            The company needs the Books app enabled by an administrator in the Lumitra account portal.
          </p>
        ) : null}
        <Link href="/projects" className="mt-6 inline-block text-sm underline underline-offset-4">
          Back to projects
        </Link>
      </main>
    );
  }

  const initialised = settings?.initialised ?? true;
  const next = settings?.counters.find((c) => c.docType === 'invoice')?.nextNumber;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/projects" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Projects
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Books</h1>
          {settings?.settings ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {settings.settings.senderBlock.legalName ?? 'Company'} ·{' '}
              {settings.settings.taxStatus === 'small_business'
                ? 'small business (§ 19 UStG, no VAT charged)'
                : 'regular VAT'}
              {next ? ` · next invoice number ${next}` : ''}
            </p>
          ) : null}
        </div>
        <span className="flex flex-wrap gap-2">
          <Link
            href="/projects/books/import"
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            Import past invoices
          </Link>
          <Button onClick={newInvoice} disabled={creating || !initialised}>
            {creating ? 'Creating…' : 'New invoice'}
          </Button>
        </span>
      </header>

      {!initialised ? (
        <div role="status" className="mb-6 rounded-md border px-4 py-3 text-sm">
          The Books are not set up for this company yet: the sender details, the tax status and the invoice number
          series are configured once by an operator (<code>pnpm books:init-company</code>). Until then nothing can be
          issued.
        </div>
      ) : null}

      <ErrorAlert message={error} onDismiss={() => setError(null)} />

      <nav className="mb-6 flex gap-2" aria-label="Books sections">
        {(['documents', 'customers', 'templates'] as Tab[]).map((t) => (
          <Button key={t} size="sm" variant={tab === t ? 'default' : 'outline'} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === 'documents' ? 'Documents' : t === 'customers' ? 'Customers' : 'Templates'}
          </Button>
        ))}
      </nav>

      {tab === 'documents' ? (
        <section aria-label="Documents list">
          <div className="mb-4 flex flex-wrap items-end gap-3" role="search" aria-label="Find documents">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Number
              <input
                type="search"
                value={numberInput}
                onChange={(e) => setNumberInput(e.target.value)}
                placeholder="e.g. 17"
                maxLength={40}
                className="h-9 w-40 rounded-md border bg-transparent px-2 text-sm text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Year
              <input
                type="number"
                inputMode="numeric"
                value={year}
                onChange={(e) => setYear(e.target.value.slice(0, 4))}
                placeholder="e.g. 2023"
                min={1900}
                max={2099}
                aria-invalid={yearIncomplete}
                aria-describedby={yearIncomplete ? 'books-year-hint' : undefined}
                className="h-9 w-28 rounded-md border bg-transparent px-2 text-sm text-foreground"
              />
            </label>
            {yearIncomplete ? (
              <p id="books-year-hint" className="self-center text-xs text-muted-foreground">
                Enter a four-digit year; until then all years are shown.
              </p>
            ) : null}
            {typed ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNumberInput('');
                  setNumber('');
                  setYear('');
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          {documents.items === null ? (
            <FirstPage list={documents} noun="documents" />
          ) : documents.items.length === 0 ? (
            filtered ? null : (
              <section className="rounded-lg border border-dashed p-10 text-center">
                <h2 className="text-base font-medium">No invoices yet</h2>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  Create a customer, then a new invoice. Numbers are given only when an invoice is issued.
                </p>
              </section>
            )
          ) : (
          <ul className="flex flex-col gap-2" aria-label="Documents" aria-busy={documents.loadingMore}>
            {documents.items.map((d) => (
              <li key={d.id}>
                <Link
                  href={`/projects/books/documents/${d.id}`}
                  className="flex items-center justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-accent"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {TYPE_LABELS[d.docType]} {d.documentNumber ?? '(no number yet)'}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {d.customerName ??
                        (d.contactStatus === 'none'
                          ? 'No customer'
                          : d.contactStatus === 'unavailable'
                            ? 'Customer name unavailable'
                            : 'Contact not found')}
                      {d.issueDate ? ` · ${date(d.issueDate)}` : ''}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="text-sm tabular-nums">{money(d.docType === 'credit_note' ? -d.total : d.total, d.currencyCode)}</span>
                    <StatusBadge status={d.status} />
                    {d.source === 'import' ? <ImportedBadge /> : null}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          )}
          <MoreRows list={documents} noun={['document', 'documents']} emptyText={filtered ? 'No document matches these filters.' : ''} />
        </section>
      ) : null}

      {tab === 'customers' ? (
        <section aria-label="Customers">
          {adding ? (
            <div className="mb-6">
              <CustomerForm
                onCancel={() => setAdding(false)}
                onCreated={async () => {
                  setAdding(false);
                  await customers.reload({ keepShown: true });
                }}
              />
            </div>
          ) : (
            <div className="mb-4 flex justify-end">
              <Button variant="outline" onClick={() => setAdding(true)}>
                New customer
              </Button>
            </div>
          )}
          {customers.items === null ? (
            <FirstPage list={customers} noun="customers" />
          ) : customers.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">No customers yet.</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Customers" aria-busy={customers.loadingMore}>
              {customers.items.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-4 rounded-lg border p-4">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {c.contact?.name ?? (c.contactStatus === 'unavailable' ? 'Name unavailable (contacts database not answering)' : 'Contact not found')}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {c.customerType === 'b2b' ? 'Business' : 'Private person'} · {c.countryCode}
                      {c.vatId ? ` · VAT id ${c.vatId}` : ''}
                      {c.drift.length > 0 ? ` · differs from the contact: ${c.drift.join(', ')}` : ''}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => archive(c.id)}>
                    Archive
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <MoreRows list={customers} noun={['customer', 'customers']} emptyText="" />
        </section>
      ) : null}

      {tab === 'templates' ? <TemplatesPanel /> : null}
    </main>
  );
}

/** Where a list's first page goes: loading, or why it failed with a retry. */
function FirstPage<T>({ list, noun }: { list: CursorList<T>; noun: string }) {
  if (list.firstError === null) return <p className="text-sm text-muted-foreground">Loading {noun}…</p>;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive px-4 py-3 text-sm">
      <span>
        The {noun} could not be loaded: {list.firstError}
      </span>
      <Button size="sm" variant="outline" onClick={() => void list.reload()}>
        Try again
      </Button>
    </div>
  );
}

/**
 * Below a paged list: one status line that is always there (so screen readers
 * announce its changes): how many rows are shown of how many, or why none
 * are; "Load more" while there are more. A page that failed says so; the rows
 * shown stay, and "Load more" tries again. A refresh that failed says so with a
 * retry. The button never loses the focus while it waits (aria-disabled, not
 * disabled); when the last page arrives and the button goes, the focus moves
 * to the status line.
 */
function MoreRows<T>({ list, noun, emptyText }: { list: CursorList<T>; noun: [string, string]; emptyText: string }) {
  const count = list.items?.length ?? 0;
  const text =
    list.items === null ? '' : count === 0 ? emptyText : `Showing ${count} of ${list.total} ${list.total === 1 ? noun[0] : noun[1]}`;
  const status = React.useRef<HTMLParagraphElement>(null);
  const button = React.useRef<HTMLButtonElement>(null);
  const hadFocus = React.useRef(false);
  React.useEffect(() => {
    // The button was focused and is gone (the last page arrived): keep the user's place.
    if (!list.hasMore && hadFocus.current) {
      hadFocus.current = false;
      status.current?.focus();
    }
  }, [list.hasMore]);
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <p ref={status} role="status" tabIndex={-1} className="text-muted-foreground outline-none">
        {text}
      </p>
      {list.hasMore && count > 0 ? (
        <Button
          ref={button}
          variant="outline"
          size="sm"
          aria-disabled={list.loadingMore}
          onFocus={() => (hadFocus.current = true)}
          onBlur={() => (hadFocus.current = false)}
          onClick={() => {
            if (!list.loadingMore) void list.loadMore();
          }}
        >
          {list.loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
      {list.moreError ? (
        <p role="alert" className="w-full text-destructive">
          The next {noun[1]} could not be loaded: {list.moreError} Your list is kept; use Load more to try again.
        </p>
      ) : null}
      {list.refreshError ? (
        <div role="alert" className="flex w-full flex-wrap items-center gap-3 text-destructive">
          <span>
            The {noun[1]} could not be refreshed: {list.refreshError} The list may be out of date.
          </span>
          <Button size="sm" variant="outline" onClick={() => void list.reload({ keepShown: true })}>
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}
