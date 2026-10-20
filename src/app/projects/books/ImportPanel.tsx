'use client';

// src/app/projects/books/ImportPanel.tsx
//
// "Import past invoices" (docs/plans/2026-10-20-books-upload-import.md): drop or
// pick up to 50 PDFs; each is uploaded on its own, read by the AI (at most four
// at a time, the server's limit too), and listed in a review table with what
// was read, the named problems and the fields the AI was unsure about. A row
// opens beside its PDF for correction (ImportRowEditor). Rows are confirmed one
// by one or all that have no blocking problem; confirmed rows import as
// historical documents with the uploaded PDF as the document of record.
//
// The states the plan names: empty (says what happens), uploading, partial
// failure (a file that fails to upload or to be read says why and offers a
// retry), all ready, mixed, everything imported. Leaving and coming back shows
// the staged rows as they were: the table is the server's, and rows that were
// uploaded but not read yet are read on load (resume). A file staged or
// imported before answers "duplicate" and is never read again.

import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { BooksApiError, importsApi, type ImportItemView, type ImportList } from '@/lib/books/api';
import { problemText, pathLabel } from '@/lib/books/importProblems';
import { date, money } from '@/lib/books/units';

import ImportConfirm from './ImportConfirm';
import ImportRowEditor from './ImportRowEditor';
import { ErrorAlert, errorText } from './ui';

/** A file of this session that has no staging row (yet): uploading, or failed to upload. */
interface LocalUpload {
  key: string;
  fileName: string;
  state: 'uploading' | 'failed' | 'duplicate';
  message: string | null;
  file: File;
}

const STATUS_TEXT: Record<ImportItemView['status'], string> = {
  uploaded: 'Waiting to be read',
  extracting: 'Reading…',
  ready: 'Ready to check',
  needs_attention: 'Needs attention',
  imported: 'Imported',
  discarded: 'Discarded',
};

const MAX_FILES = 50;
const MAX_BYTES = 10 * 1024 * 1024;
/** A row `extracting` for longer than the server's claim timeout (10 minutes) was interrupted: read it again. */
const STALE_READING_MS = 11 * 60 * 1000;

const staleReadings = (items: ImportItemView[]) =>
  items.filter((i) => i.status === 'extracting' && Date.parse(i.updatedAt) < Date.now() - STALE_READING_MS).map((i) => i.id);

/**
 * A dialog's focus return to the button that opened it, named explicitly: a
 * click does not focus a button in every browser (Safari), so "what was
 * focused before" can be the page itself. Falls back to the default when the
 * button is gone (the row was imported or discarded).
 */
function focusOn(selector: string | null): (event: Event) => void {
  return (event) => {
    event.preventDefault();
    const target = selector ? document.querySelector<HTMLElement>(selector) : null;
    // A button that is gone (imported, discarded) or waiting (disabled) cannot take the focus: the page heading does.
    const usable = target && target.isConnected && !(target as HTMLButtonElement).disabled ? target : null;
    (usable ?? document.getElementById(PAGE_HEADING_ID))?.focus();
  };
}

/** The page heading, where the focus goes when a dialog's own button cannot take it back. */
const PAGE_HEADING_ID = 'import-past-invoices-heading';

/** The new next invoice number importing this row would set, or null when it does not raise the counter. */
function raiseOf(item: ImportItemView): number | null {
  return item.problems.find((p) => p.code === 'counter_raised')?.count ?? null;
}

/** A printed amount in its printed currency ("1.234,50 €", "500,00 CHF"); "?" when not an amount. */
function printedMoney(amount: unknown, currency: unknown): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '?';
  const code = typeof currency === 'string' && /^[A-Z]{3}$/.test(currency.trim().toUpperCase()) ? currency.trim().toUpperCase() : 'EUR';
  return money(Math.round(amount * 100), code);
}

export default function ImportPanel() {
  const [list, setList] = useState<ImportList | null>(null);
  const [uploads, setUploads] = useState<LocalUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [blocked, setBlocked] = useState<BooksApiError | null>(null);
  /** A row whose import would raise the invoice counter, waiting for the user's explicit confirmation. */
  const [raising, setRaising] = useState<{ id: string; to: number } | null>(null);
  /** The batch import waiting for its explicit confirmation of the highest new next number. */
  const [batchRaise, setBatchRaise] = useState<number | null>(null);
  /** A row the user asked to discard, waiting for the confirmation (the file is deleted at once). */
  const [discarding, setDiscarding] = useState<string | null>(null);
  /** The row whose dialog is open or closing: the focus returns to its button after the state is cleared. */
  const dialogRow = useRef<string | null>(null);
  /** The row whose editor reopens on a reading the user asked for there, and the reading it replaces. */
  const headingFocus = useRef<{ id: string; from: string | null } | null>(null);
  const clearHeadingFocus = useCallback(() => {
    headingFocus.current = null;
  }, []);
  // What a closing dialog keeps showing while it fades out (its state is already cleared).
  const lastRaise = useRef<{ id: string; to: number } | null>(null);
  const lastBatchRaise = useRef<number | null>(null);
  if (raising) lastRaise.current = raising;
  if (batchRaise !== null) lastBatchRaise.current = batchRaise;
  const shownRaise = raising ?? lastRaise.current;
  const shownBatchRaise = batchRaise ?? lastBatchRaise.current;
  const queue = useRef<string[]>([]);
  /** Rows the user asked to read again although they hold what was typed or corrected. */
  const replacing = useRef<Set<string>>(new Set());
  /** Rows filled in by hand while a busy retry was pending: the retry is dropped. */
  const handFilled = useRef<Set<string>>(new Set());
  const running = useRef<Set<string>>(new Set());
  const stopped = useRef(false);
  const mounted = useRef(true);

  const upsert = useCallback((item: ImportItemView) => {
    setList((cur) => {
      if (!cur) return cur;
      const others = cur.items.filter((i) => i.id !== item.id);
      const items = item.status === 'discarded' ? others : [...others, item].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { ...cur, items };
    });
  }, []);

  const reload = useCallback(async () => {
    try {
      const next = await importsApi.list();
      if (!mounted.current) return;
      setList(next);
      return next;
    } catch (err) {
      if (err instanceof BooksApiError && ['books_not_enabled', 'forbidden', 'unauthorized', 'books_not_provisioned', 'sites_not_enabled', 'no_active_company'].includes(err.code)) {
        setBlocked(err);
      } else setError(errorText(err));
      return undefined;
    }
  }, []);

  // The reading queue: at most `parallel` at a time; a busy answer waits and retries, the daily ceiling stops it.
  const pump = useCallback(() => {
    const parallel = list?.limits.parallel ?? 4;
    while (!stopped.current && running.current.size < parallel && queue.current.length > 0) {
      const id = queue.current.shift()!;
      if (running.current.has(id)) continue;
      running.current.add(id);
      setBusy((b) => new Set(b).add(id));
      const replace = replacing.current.has(id);
      replacing.current.delete(id);
      importsApi
        .extract(id, replace)
        .then((item) => mounted.current && upsert(item))
        .catch((err: unknown) => {
          if (!mounted.current) return;
          if (err instanceof BooksApiError && err.code === 'extract_busy') {
            const wait = Number((err.details as { retryAfterSec?: unknown }).retryAfterSec ?? 5);
            setTimeout(() => {
              // Filled in by hand meanwhile: nothing to read any more.
              if (handFilled.current.has(id)) return;
              // The retry is the same request: the user's "Read again" stays a replacing read.
              if (replace) replacing.current.add(id);
              queue.current.push(id);
              pump();
            }, Math.max(1, wait) * 1000);
          } else if (err instanceof BooksApiError && err.code === 'import_limit') {
            // Stop, and forget what was waiting: each row keeps its own "Read" button for later.
            stopped.current = true;
            queue.current = [];
            setNotice(err.message);
          } else if (err instanceof BooksApiError && ['extraction_running', 'concurrent_edit', 'reading_would_be_replaced'].includes(err.code)) {
            // Read in another window, or set aside or imported meanwhile: show the row as it is now.
            void reload();
          } else {
            setError(errorText(err));
          }
        })
        .finally(() => {
          running.current.delete(id);
          setBusy((b) => {
            const n = new Set(b);
            n.delete(id);
            return n;
          });
          pump();
        });
    }
  }, [list?.limits.parallel, upsert, reload]);

  const enqueue = useCallback(
    (ids: string[]) => {
      for (const id of ids) if (!queue.current.includes(id) && !running.current.has(id)) queue.current.push(id);
      pump();
    },
    [pump],
  );

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  // Resume: rows uploaded but not read yet are read now; a row left `extracting` past the
  // server's claim timeout (an interrupted call) is read again (the server takes the claim over).
  const resumed = useRef(false);
  useEffect(() => {
    if (!list || resumed.current) return;
    resumed.current = true;
    enqueue([...list.items.filter((i) => i.status === 'uploaded').map((i) => i.id), ...staleReadings(list.items)]);
  }, [list, enqueue]);

  // While a row is being read elsewhere, refresh now and then; one interrupted meanwhile is read again.
  const reading = list?.items.some((i) => i.status === 'extracting' && !running.current.has(i.id)) ?? false;
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => {
      void reload().then((next) => {
        if (next) enqueue(staleReadings(next.items));
      });
    }, 10_000);
    return () => clearInterval(t);
  }, [reading, reload, enqueue]);

  // A dialog about a row that left the list or changed meanwhile asks no more: it closes and says so.
  useEffect(() => {
    if (!list) return;
    const find = (id: string) => list.items.find((i) => i.id === id);
    if (raising) {
      const row = find(raising.id);
      if (!row || row.status !== 'ready' || raiseOf(row) !== raising.to) {
        setRaising(null);
        setNotice('That invoice changed meanwhile, so nothing was imported. Check it again.');
      }
    }
    if (discarding) {
      const row = find(discarding);
      if (!row || row.status === 'imported' || row.status === 'extracting') {
        setDiscarding(null);
        setNotice('That file changed meanwhile, so it was not discarded.');
      }
    }
  }, [list, raising, discarding]);

  async function addFiles(files: File[]) {
    setError(null);
    setNotice(null);
    if (files.length === 0) return;
    if (files.length > MAX_FILES) {
      setError(`Choose at most ${MAX_FILES} files at once (${files.length} chosen).`);
      return;
    }
    const entries: LocalUpload[] = files.map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, fileName: file.name, state: 'uploading', message: null, file }));
    setUploads((u) => [...u, ...entries]);
    for (const entry of entries) await uploadOne(entry);
  }

  async function uploadOne(entry: LocalUpload) {
    const mark = (change: Partial<LocalUpload> | null) =>
      setUploads((u) => (change === null ? u.filter((x) => x.key !== entry.key) : u.map((x) => (x.key === entry.key ? { ...x, ...change } : x))));
    if (entry.file.size > MAX_BYTES) return mark({ state: 'failed', message: 'Larger than 10 MB.' });
    mark({ state: 'uploading', message: null });
    try {
      const result = await importsApi.upload(entry.file);
      if (result.status === 'duplicate') {
        return mark({
          state: 'duplicate',
          message: result.documentId ? 'Already imported.' : 'Already in this table.',
        });
      }
      mark(null);
      upsert(result.item);
      enqueue([result.item.id]);
    } catch (err) {
      mark({ state: 'failed', message: errorText(err) });
    }
  }

  async function act(id: string, run: () => Promise<ImportItemView | void>) {
    setError(null);
    setBusy((b) => new Set(b).add(id));
    try {
      const item = await run();
      if (item) upsert(item);
    } catch (err) {
      setError(errorText(err));
      if (err instanceof BooksApiError && ['concurrent_edit', 'stale_extraction', 'import_not_ready'].includes(err.code)) await reload();
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(id);
        return n;
      });
    }
  }

  /** Import one row; null when it was imported, else what went wrong (the caller shows it). */
  async function confirm(item: ImportItemView, confirmedRaise: number | null = null): Promise<string | null> {
    try {
      const res = await importsApi.confirm(item.id, item.version, confirmedRaise);
      upsert(res.item);
      if (res.counterRaisedTo !== null) setNotice(`The invoice counter was raised to ${res.counterRaisedTo}: your next invoice continues after the imported ones.`);
      return null;
    } catch (err) {
      return errorText(err);
    }
  }

  /** Import a row; one that raises the counter first asks for the explicit confirmation. */
  async function importRow(item: ImportItemView, confirmedRaise: number | null = null) {
    const to = raiseOf(item);
    if (to !== null && confirmedRaise !== to) {
      dialogRow.current = item.id;
      setRaising({ id: item.id, to });
      return;
    }
    setRaising(null);
    await act(item.id, async () => {
      const failed = await confirm(item, to);
      if (failed !== null) {
        setError(failed);
        await reload();
      }
    });
  }

  /** Ask before discarding (the file is deleted at once). */
  function askDiscard(id: string) {
    dialogRow.current = id;
    setDiscarding(id);
  }

  /** Fill a row in by hand (no AI reading), then open it; it leaves the reading queue, so nothing replaces what is typed. */
  async function byHand(item: ImportItemView) {
    queue.current = queue.current.filter((id) => id !== item.id);
    replacing.current.delete(item.id);
    // Drops a pending busy retry while the request runs; cleared again if filling in fails.
    handFilled.current.add(item.id);
    let done = false;
    await act(item.id, async () => {
      const filled = await importsApi.byHand(item.id, item.version);
      done = true;
      return filled;
    });
    if (!done) {
      handFilled.current.delete(item.id);
      return;
    }
    setOpen(item.id);
  }

  /** Read one row now (its own button): only this row, never the rest of an old queue. */
  function readOne(id: string, replace = false) {
    handFilled.current.delete(id);
    if (replace) replacing.current.add(id);
    const wasStopped = stopped.current;
    stopped.current = false;
    if (wasStopped) queue.current = [];
    enqueue([id]);
  }

  /** Import every ready row; when any of them raises the counter, the highest new value is confirmed first. */
  async function confirmAllReady(confirmedRaise: number | null = null) {
    if (!list) return;
    setError(null);
    const ready = list.items.filter((i) => i.status === 'ready');
    const highest = ready.map(raiseOf).reduce<number | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
    if (highest !== null && confirmedRaise !== highest) {
      setBatchRaise(highest);
      return;
    }
    setBatchRaise(null);
    const failures: string[] = [];
    let changed = 0;
    let notImported = 0;
    let current = ready;
    const ids = ready.map((i) => i.id);
    for (const [n, id] of ids.entries()) {
      const item = current.find((i) => i.id === id);
      // Changed since (read again, corrected, imported elsewhere): left for the user, not imported blind.
      if (!item || item.status !== 'ready') {
        // Imported elsewhere or set aside meanwhile (gone from the list): nothing left to do.
        if (item && item.status !== 'imported') {
          changed += 1;
          notImported += 1;
        }
        continue;
      }
      const to = raiseOf(item);
      // A raise beyond the value the user confirmed is not covered by that confirmation.
      if (to !== null && (highest === null || to > highest)) {
        failures.push(`${item.fileName}: the next invoice number it would set changed; confirm it on its row.`);
        notImported += 1;
        continue;
      }
      setBusy((b) => new Set(b).add(item.id));
      // Each row names its own new next value; the batch confirmation covered the highest.
      const failed = await confirm(item, to);
      setBusy((b) => {
        const n = new Set(b);
        n.delete(item.id);
        return n;
      });
      if (failed !== null) {
        failures.push(`${item.fileName}: ${failed}`);
        notImported += 1;
        // Continue with the rows as they are now (versions moved), never with the old list.
        const fresh = await reload();
        if (!fresh) {
          failures.push(`The list could not be reloaded, so ${ids.length - n - 1} more were not tried; reload the page and import them.`);
          notImported += ids.length - n - 1;
          break;
        }
        current = fresh.items;
      }
    }
    if (changed > 0) failures.push(`${changed} changed meanwhile and were left for you to check.`);
    if (failures.length > 0) {
      setError(`${notImported} of ${ready.length} were not imported. ${failures.join(' ')}`);
      await reload();
    }
  }

  if (blocked) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight">Import past invoices</h1>
        <p className="mt-4 text-sm">{blocked.message}</p>
        <Link href="/projects/books" className="mt-6 inline-block text-sm underline underline-offset-4">
          Back to the Books
        </Link>
      </main>
    );
  }

  const items = list?.items ?? [];
  const pending = items.filter((i) => i.status !== 'imported');
  const readyCount = items.filter((i) => i.status === 'ready').length;
  const editing = items.find((i) => i.id === open) ?? null;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/projects/books" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            Books
          </Link>
          <h1 id={PAGE_HEADING_ID} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
            Import past invoices
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Add the PDFs of invoices you issued before using the Books. Each one is read by AI; you check and correct
            what was read, and confirmed invoices are imported with their original PDF as the document of record.
            {list?.counter ? ` Next invoice number: ${list.counter.nextValue}.` : ''}
          </p>
        </div>
        <Button data-import-all onClick={() => void confirmAllReady()} disabled={readyCount === 0 || busy.size > 0}>
          {readyCount > 0 ? `Import all ready (${readyCount})` : 'Import all ready'}
        </Button>
      </header>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />
      <ImportConfirm
        open={batchRaise !== null}
        title="Confirm the new invoice number"
        description={
          <>
            <p className="font-medium text-foreground">Your next invoice number will become {shownBatchRaise}. It cannot be lowered later.</p>
            <p className="mt-1">
              Importing the ready invoices raises the invoice counter past the highest imported number. Check that number
              against its PDF before you continue.
            </p>
          </>
        }
        confirmLabel={`Import and set the next number to ${shownBatchRaise ?? ''}`}
        onConfirm={() => void confirmAllReady(batchRaise)}
        onCancel={() => setBatchRaise(null)}
        onCloseAutoFocus={focusOn('[data-import-all]')}
      />
      <ImportConfirm
        open={raising !== null}
        title="Confirm the new invoice number"
        description={<p className="font-medium text-foreground">Your next invoice number will become {shownRaise?.to}. It cannot be lowered later.</p>}
        confirmLabel={`Import and set the next number to ${shownRaise?.to ?? ''}`}
        onConfirm={() => {
          const row = raising && list?.items.find((i) => i.id === raising.id);
          if (row && raising) return void importRow(row, raising.to);
          setRaising(null);
          setNotice('That invoice changed meanwhile, so nothing was imported. Check it again.');
        }}
        onCancel={() => setRaising(null)}
        onCloseAutoFocus={(e) => focusOn(dialogRow.current ? `[data-import-row="${dialogRow.current}"]` : null)(e)}
      />
      <ImportConfirm
        open={discarding !== null}
        title="Discard this file"
        description={<p>The uploaded file and what was read from it are deleted now. To import it later, upload it again.</p>}
        confirmLabel="Discard"
        onConfirm={() => {
          const id = discarding;
          setDiscarding(null);
          if (id) void act(id, () => importsApi.discard(id));
        }}
        onCancel={() => setDiscarding(null)}
        onCloseAutoFocus={(e) => focusOn(dialogRow.current ? `[data-discard-row="${dialogRow.current}"]` : null)(e)}
      />
      {notice ? (
        <div role="status" className="mb-4 rounded-md border px-4 py-3 text-sm">
          {notice}
        </div>
      ) : null}

      <label
        className="mb-6 flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-6 py-10 text-center text-sm hover:bg-accent"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <span className="font-medium">Drop invoice PDFs here, or choose files</span>
        <span className="mt-1 text-muted-foreground">Up to {MAX_FILES} files at once, each at most 10 MB.</span>
        <input
          type="file"
          accept="application/pdf,.pdf"
          multiple
          aria-label="Choose invoice PDFs"
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            void addFiles(files);
          }}
        />
      </label>

      {uploads.length > 0 ? (
        <ul className="mb-6 flex flex-col gap-2" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.key} className="flex items-center justify-between gap-4 rounded-md border px-4 py-2 text-sm">
              <span className="min-w-0 truncate">{u.fileName}</span>
              <span className="flex shrink-0 items-center gap-3">
                <span className={u.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                  {u.state === 'uploading' ? 'Uploading…' : u.state === 'duplicate' ? `Duplicate: ${u.message}` : `Failed: ${u.message}`}
                </span>
                {u.state === 'failed' ? (
                  <Button variant="outline" size="sm" onClick={() => void uploadOne(u)}>
                    Retry
                  </Button>
                ) : null}
                {u.state !== 'uploading' ? (
                  <button type="button" className="underline underline-offset-4" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                    Dismiss
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {list && items.length === 0 && uploads.length === 0 ? (
        <section className="rounded-lg border p-6 text-sm text-muted-foreground" aria-label="No past invoices yet">
          No past invoices yet. Add PDFs above: each one is read and listed here for you to check before anything is
          imported. Nothing is imported without your confirmation.
        </section>
      ) : null}
      {list && items.length > 0 && pending.length === 0 ? (
        <section role="status" className="mb-4 rounded-lg border p-4 text-sm" aria-label="Everything imported">
          Everything here is imported. The invoices are in the documents list, marked imported.
        </section>
      ) : null}

      {items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" aria-label="Past invoices to check">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">File</th>
                <th className="px-3 py-2">Number</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const p = item.printed;
                const blocking = item.problems.filter((x) => x.blocking);
                const warnings = item.problems.filter((x) => !x.blocking);
                const rowBusy = busy.has(item.id) || item.status === 'extracting';
                return (
                  <tr key={item.id} className="border-t align-top" data-testid={`import-row-${item.id}`}>
                    <td className="max-w-[12rem] truncate px-3 py-2" title={item.fileName}>
                      {item.fileName}
                    </td>
                    <td className="px-3 py-2">{p?.number != null ? String(p.number) : ''}</td>
                    <td className="px-3 py-2">{p?.issueDate ? date(p.issueDate) : ''}</td>
                    <td className="max-w-[14rem] truncate px-3 py-2">{p?.recipient?.name ?? ''}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p ? printedMoney(p.total, p.currency) : ''}</td>
                    <td className="px-3 py-2">
                      <span className="block">{busy.has(item.id) && item.status === 'uploaded' ? 'Reading…' : STATUS_TEXT[item.status]}</span>
                      {blocking.length > 0 ? (
                        <ul className="mt-1 list-disc pl-4 text-xs text-destructive">
                          {blocking.slice(0, 3).map((x, i) => (
                            <li key={i}>
                              {pathLabel(x.path) ? `${pathLabel(x.path)}: ` : ''}
                              {problemText(x)}
                            </li>
                          ))}
                          {blocking.length > 3 ? <li>and {blocking.length - 3} more</li> : null}
                        </ul>
                      ) : null}
                      {warnings.length > 0 && item.status !== 'imported' ? (
                        <span className="mt-1 block text-xs text-muted-foreground">{warnings.length} to check</span>
                      ) : null}
                      {raiseOf(item) !== null && item.status !== 'imported' ? (
                        <span className="mt-1 block text-xs text-amber-700 dark:text-amber-400">
                          Importing sets your next invoice number to {raiseOf(item)}. It cannot be lowered later.
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap justify-end gap-2">
                        {item.status === 'imported' && item.documentId ? (
                          <Link href={`/projects/books/documents/${item.documentId}`} className="underline underline-offset-4">
                            Open
                          </Link>
                        ) : null}
                        {(item.status === 'ready' || item.status === 'needs_attention') && item.extractionId !== null ? (
                          <Button variant="outline" size="sm" onClick={() => setOpen(open === item.id ? null : item.id)} disabled={rowBusy}>
                            {open === item.id ? 'Close' : 'Check'}
                          </Button>
                        ) : null}
                        {item.status === 'ready' ? (
                          <Button size="sm" data-import-row={item.id} onClick={() => void importRow(item)} disabled={rowBusy}>
                            Import
                          </Button>
                        ) : null}
                        {item.problems.some((x) => x.code === 'number_jump') && p?.number != null ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void act(item.id, () => importsApi.confirmNumber(item.id, String(p.number), item.version))}
                            disabled={rowBusy}
                          >
                            The number is right
                          </Button>
                        ) : null}
                        {item.status === 'uploaded' && !busy.has(item.id) ? (
                          <Button variant="outline" size="sm" onClick={() => readOne(item.id)}>
                            Read
                          </Button>
                        ) : null}
                        {item.status === 'needs_attention' && item.extractionError && item.extractionError !== 'unreadable' ? (
                          <Button variant="outline" size="sm" onClick={() => readOne(item.id, true)} disabled={rowBusy}>
                            Read again
                          </Button>
                        ) : null}
                        {(item.status === 'uploaded' || item.status === 'needs_attention') && item.extractionId === null && !busy.has(item.id) ? (
                          <Button variant="outline" size="sm" onClick={() => void byHand(item)} disabled={rowBusy}>
                            Fill in by hand
                          </Button>
                        ) : null}
                        {item.status !== 'imported' ? (
                          <Button variant="ghost" size="sm" data-discard-row={item.id} onClick={() => askDiscard(item.id)} disabled={rowBusy}>
                            Discard
                          </Button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {list && list.importedTotal > items.filter((i) => i.status === 'imported').length ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the newest {items.filter((i) => i.status === 'imported').length} of {list.importedTotal} imported invoices; all of them
          are in the documents list.
        </p>
      ) : null}

      {editing && editing.extractionId !== null ? (
        <ImportRowEditor
          key={`${editing.id}-${editing.extractionId}`}
          item={editing}
          busy={busy.has(editing.id)}
          onSave={(printed) => act(editing.id, () => importsApi.correct(editing.id, printed, editing.extractionId!, editing.version))}
          onRecheck={() => act(editing.id, () => importsApi.recheck(editing.id))}
          onReadAgain={() => {
            // The editor reopens on the new reading: its heading takes the focus then.
            headingFocus.current = { id: editing.id, from: editing.extractionId };
            readOne(editing.id, true);
          }}
          autoFocusHeading={headingFocus.current?.id === editing.id && headingFocus.current.from !== editing.extractionId}
          onHeadingFocused={clearHeadingFocus}
          onClose={() => {
            headingFocus.current = null;
            setOpen(null);
          }}
        />
      ) : null}
    </main>
  );
}
