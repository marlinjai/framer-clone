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
  const queue = useRef<string[]>([]);
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

  // The reading queue: at most `parallel` at a time; a busy answer waits and retries, the daily ceiling stops it.
  const pump = useCallback(() => {
    const parallel = list?.limits.parallel ?? 4;
    while (!stopped.current && running.current.size < parallel && queue.current.length > 0) {
      const id = queue.current.shift()!;
      if (running.current.has(id)) continue;
      running.current.add(id);
      setBusy((b) => new Set(b).add(id));
      importsApi
        .extract(id)
        .then((item) => mounted.current && upsert(item))
        .catch((err: unknown) => {
          if (!mounted.current) return;
          if (err instanceof BooksApiError && err.code === 'extract_busy') {
            const wait = Number((err.details as { retryAfterSec?: unknown }).retryAfterSec ?? 5);
            setTimeout(() => {
              queue.current.push(id);
              pump();
            }, Math.max(1, wait) * 1000);
          } else if (err instanceof BooksApiError && err.code === 'import_limit') {
            stopped.current = true;
            setNotice(err.message);
          } else if (err instanceof BooksApiError && err.code === 'extraction_running') {
            // Being read in another window: the next refresh shows the result.
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
  }, [list?.limits.parallel, upsert]);

  const enqueue = useCallback(
    (ids: string[]) => {
      for (const id of ids) if (!queue.current.includes(id) && !running.current.has(id)) queue.current.push(id);
      pump();
    },
    [pump],
  );

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

  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);

  // Resume: rows uploaded but not read yet are read now; a row left `extracting` for over
  // five minutes (an interrupted call) is read again (the server takes the stale claim over).
  const resumed = useRef(false);
  useEffect(() => {
    if (!list || resumed.current) return;
    resumed.current = true;
    const stale = Date.now() - 5 * 60 * 1000;
    enqueue(list.items.filter((i) => i.status === 'uploaded' || (i.status === 'extracting' && Date.parse(i.updatedAt) < stale)).map((i) => i.id));
  }, [list, enqueue]);

  // While a row is being read elsewhere, refresh now and then.
  const reading = list?.items.some((i) => i.status === 'extracting' && !running.current.has(i.id)) ?? false;
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => void reload(), 10_000);
    return () => clearInterval(t);
  }, [reading, reload]);

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

  async function confirm(item: ImportItemView): Promise<boolean> {
    try {
      const res = await importsApi.confirm(item.id, item.version);
      upsert(res.item);
      if (res.counterRaisedTo !== null) setNotice(`The invoice counter was raised to ${res.counterRaisedTo}: your next invoice continues after the imported ones.`);
      return true;
    } catch (err) {
      setError(errorText(err));
      await reload();
      return false;
    }
  }

  async function confirmAllReady() {
    if (!list) return;
    setError(null);
    for (const item of list.items.filter((i) => i.status === 'ready')) {
      setBusy((b) => new Set(b).add(item.id));
      await confirm(item);
      setBusy((b) => {
        const n = new Set(b);
        n.delete(item.id);
        return n;
      });
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
          <h1 className="text-2xl font-semibold tracking-tight">Import past invoices</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Add the PDFs of invoices you issued before using the Books. Each one is read by AI; you check and correct
            what was read, and confirmed invoices are imported with their original PDF as the document of record.
            {list?.counter ? ` Next invoice number: ${list.counter.nextValue}.` : ''}
          </p>
        </div>
        <Button onClick={confirmAllReady} disabled={readyCount === 0 || busy.size > 0}>
          {readyCount > 0 ? `Import all ready (${readyCount})` : 'Import all ready'}
        </Button>
      </header>

      <ErrorAlert message={error} onDismiss={() => setError(null)} />
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
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap justify-end gap-2">
                        {item.status === 'imported' && item.documentId ? (
                          <Link href={`/projects/books/documents/${item.documentId}`} className="underline underline-offset-4">
                            Open
                          </Link>
                        ) : null}
                        {item.status === 'ready' || item.status === 'needs_attention' ? (
                          <Button variant="outline" size="sm" onClick={() => setOpen(open === item.id ? null : item.id)} disabled={rowBusy}>
                            {open === item.id ? 'Close' : 'Check'}
                          </Button>
                        ) : null}
                        {item.status === 'ready' ? (
                          <Button size="sm" onClick={() => void act(item.id, async () => { await confirm(item); })} disabled={rowBusy}>
                            Import
                          </Button>
                        ) : null}
                        {item.status === 'needs_attention' && item.extractionError ? (
                          <Button variant="outline" size="sm" onClick={() => enqueue([item.id])} disabled={rowBusy}>
                            Read again
                          </Button>
                        ) : null}
                        {item.status !== 'imported' ? (
                          <Button variant="ghost" size="sm" onClick={() => void act(item.id, () => importsApi.discard(item.id))} disabled={rowBusy}>
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

      {editing ? (
        <ImportRowEditor
          key={`${editing.id}-${editing.extractionId}`}
          item={editing}
          busy={busy.has(editing.id)}
          onSave={(printed) => act(editing.id, () => importsApi.correct(editing.id, printed, editing.extractionId!, editing.version))}
          onRecheck={() => act(editing.id, () => importsApi.recheck(editing.id))}
          onReadAgain={() => enqueue([editing.id])}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </main>
  );
}
