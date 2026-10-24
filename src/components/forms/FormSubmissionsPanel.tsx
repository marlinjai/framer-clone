'use client';
// src/components/forms/FormSubmissionsPanel.tsx
//
// The editor's "Form submissions" view (published site essentials, decision 4):
// what visitors sent through this project's forms, newest first. Filter by
// form, open one to read every field (opening marks it read; it can be marked
// unread again), delete one for good (an in-page confirmation, never a native
// dialog), export the list (or one form) as CSV, and load older ones in pages.
//
// Talks only to /api/projects/<id>/forms/submissions* (editSite), so the
// server decides what this user may see. Every failure is shown with a retry.

import React, { useCallback, useEffect, useState } from 'react';
import { Download, Mail, MailOpen, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { StoredField } from '@/lib/forms/validation';

export interface SubmissionItem {
  id: string;
  formId: string;
  formName: string;
  pageId: string;
  pagePath: string;
  fields: StoredField[];
  readAt: string | null;
  createdAt: string;
}

export interface FormSummaryItem {
  formId: string;
  formName: string;
  total: number;
  unread: number;
}

interface ListResponse {
  submissions: SubmissionItem[];
  hasMore: boolean;
  nextCursor: string | null;
  forms: FormSummaryItem[];
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body.error?.message) return `${fallback}: ${body.error.message}`;
  } catch {
    // not JSON
  }
  return `${fallback} (HTTP ${res.status})`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function fieldText(f: StoredField): string {
  if (typeof f.value === 'boolean') return f.value ? 'Yes' : 'No';
  return f.value === '' ? '(empty)' : f.value;
}

/** The one-line preview of a submission: its first non-empty text values. */
function preview(fields: StoredField[]): string {
  return fields
    .filter((f) => typeof f.value === 'string' && f.value !== '')
    .slice(0, 2)
    .map((f) => String(f.value))
    .join(' · ')
    .slice(0, 140);
}

export default function FormSubmissionsPanel({ projectId }: { projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/forms/submissions`;
  const [formFilter, setFormFilter] = useState('');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [items, setItems] = useState<SubmissionItem[]>([]);
  const [forms, setForms] = useState<FormSummaryItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query = useCallback(
    (extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({ limit: '50', ...extra });
      if (formFilter) params.set('form', formFilter);
      return `${base}?${params.toString()}`;
    },
    [base, formFilter],
  );

  const refresh = useCallback(async () => {
    setLoad({ kind: 'loading' });
    try {
      const res = await fetch(query(), { cache: 'no-store' });
      if (!res.ok) {
        setLoad({ kind: 'error', message: await readError(res, 'Could not load the submissions') });
        return;
      }
      const data = (await res.json()) as ListResponse;
      setItems(data.submissions);
      setForms(data.forms);
      setCursor(data.nextCursor);
      setLoad({ kind: 'ready' });
    } catch {
      setLoad({ kind: 'error', message: 'Could not load the submissions: the server did not answer.' });
    }
  }, [query]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(query({ cursor }), { cache: 'no-store' });
      if (!res.ok) {
        setLoad({ kind: 'error', message: await readError(res, 'Could not load older submissions') });
        return;
      }
      const data = (await res.json()) as ListResponse;
      setItems((prev) => [...prev, ...data.submissions.filter((s) => !prev.some((p) => p.id === s.id))]);
      setForms(data.forms);
      setCursor(data.nextCursor);
    } catch {
      setLoad({ kind: 'error', message: 'Could not load older submissions: the server did not answer.' });
    } finally {
      setLoadingMore(false);
    }
  };

  const adjustUnread = (formId: string, delta: number) =>
    setForms((prev) => prev.map((f) => (f.formId === formId ? { ...f, unread: Math.max(0, f.unread + delta) } : f)));

  const setRead = async (item: SubmissionItem, read: boolean) => {
    if (!!item.readAt === read) return;
    setBusyId(item.id);
    setRowError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ read }),
      });
      if (res.status === 404) {
        await refresh();
        return;
      }
      if (!res.ok) {
        setRowError({ id: item.id, message: await readError(res, read ? 'Could not mark it read' : 'Could not mark it unread') });
        return;
      }
      setItems((prev) => prev.map((s) => (s.id === item.id ? { ...s, readAt: read ? new Date().toISOString() : null } : s)));
      adjustUnread(item.formId, read ? -1 : 1);
    } catch {
      setRowError({ id: item.id, message: 'The server did not answer. Try again.' });
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: SubmissionItem) => {
    setBusyId(item.id);
    setRowError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        setRowError({ id: item.id, message: await readError(res, 'Could not delete the submission') });
        return;
      }
      setItems((prev) => prev.filter((s) => s.id !== item.id));
      setForms((prev) =>
        prev
          .map((f) => (f.formId === item.formId ? { ...f, total: f.total - 1, unread: item.readAt ? f.unread : Math.max(0, f.unread - 1) } : f))
          .filter((f) => f.total > 0),
      );
      setConfirmDeleteId(null);
      if (openId === item.id) setOpenId(null);
    } catch {
      setRowError({ id: item.id, message: 'The server did not answer. Try again.' });
    } finally {
      setBusyId(null);
    }
  };

  const toggleOpen = (item: SubmissionItem) => {
    const next = openId === item.id ? null : item.id;
    setOpenId(next);
    setConfirmDeleteId(null);
    if (next && !item.readAt) void setRead(item, true);
  };

  const exportHref = `${base}/export${formFilter ? `?form=${encodeURIComponent(formFilter)}` : ''}`;

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="form-submissions">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="submissions-form-filter" className="text-xs text-muted-foreground">
            Form
          </label>
          <select
            id="submissions-form-filter"
            value={formFilter}
            onChange={(e) => {
              setFormFilter(e.target.value);
              setOpenId(null);
            }}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            <option value="">All forms</option>
            {forms.map((f) => (
              <option key={f.formId} value={f.formId}>
                {f.formName} ({f.total}{f.unread > 0 ? `, ${f.unread} unread` : ''})
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} aria-label="Reload submissions">
          <RefreshCw /> Reload
        </Button>
        <Button asChild variant="outline" size="sm">
          <a href={exportHref} download>
            <Download /> Export CSV
          </a>
        </Button>
      </div>

      {load.kind === 'loading' && <p className="text-sm text-muted-foreground" role="status">Loading submissions...</p>}
      {load.kind === 'error' && (
        <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm">
          <p>{load.message}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </div>
      )}
      {load.kind === 'ready' && items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {formFilter
            ? 'This form has no submissions.'
            : 'No submissions yet. When visitors send a form on your published site, their messages appear here.'}
        </p>
      )}

      {load.kind === 'ready' && items.length > 0 && (
        <ul className="flex max-h-[60vh] flex-col divide-y divide-border overflow-y-auto rounded-md border border-border">
          {items.map((item) => {
            const open = openId === item.id;
            const unread = !item.readAt;
            return (
              <li key={item.id} className="flex flex-col">
                <button
                  type="button"
                  onClick={() => toggleOpen(item)}
                  aria-expanded={open}
                  aria-controls={`submission-${item.id}`}
                  className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                >
                  <span className="mt-0.5 flex-none text-muted-foreground" aria-hidden>
                    {unread ? <Mail size={14} /> : <MailOpen size={14} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate text-sm ${unread ? 'font-semibold' : ''}`}>
                      {preview(item.fields) || item.formName}
                      {unread && <span className="sr-only"> (unread)</span>}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {item.formName} on {item.pagePath} · {formatDate(item.createdAt)}
                    </span>
                  </span>
                </button>
                {open && (
                  <div id={`submission-${item.id}`} className="flex flex-col gap-3 px-3 pb-3">
                    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1 text-sm">
                      {item.fields.map((f) => (
                        <React.Fragment key={f.key}>
                          <dt className="truncate text-muted-foreground" title={f.label}>
                            {f.label}
                          </dt>
                          <dd className="whitespace-pre-wrap break-words">{fieldText(f)}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button type="button" size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void setRead(item, unread)}>
                        {unread ? <MailOpen /> : <Mail />} {unread ? 'Mark read' : 'Mark unread'}
                      </Button>
                      {confirmDeleteId === item.id ? (
                        <span className="flex items-center gap-2" role="group" aria-label="Confirm delete">
                          <span className="text-sm">Delete for good?</span>
                          <Button type="button" size="sm" variant="destructive" disabled={busyId === item.id} onClick={() => void remove(item)}>
                            Delete
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                            Keep
                          </Button>
                        </span>
                      ) : (
                        <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDeleteId(item.id)}>
                          <Trash2 /> Delete
                        </Button>
                      )}
                    </div>
                    {rowError?.id === item.id && (
                      <p role="alert" className="text-sm text-destructive">
                        {rowError.message}
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {load.kind === 'ready' && cursor && (
        <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? 'Loading...' : 'Load older submissions'}
        </Button>
      )}
    </div>
  );
}
