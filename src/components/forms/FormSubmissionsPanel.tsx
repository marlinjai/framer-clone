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

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  /** The email to the site owner about this submission; null for a submission from before notifications. */
  notification?: {
    status: 'pending' | 'sent' | 'blocked' | 'failed' | 'skipped';
    reason: string | null;
    recipient: string | null;
  } | null;
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

type NotificationItem = NonNullable<SubmissionItem['notification']>;

/** What the owner is told about the email of one submission, and whether it can be sent again. */
export function notificationNote(n: NotificationItem | null | undefined): { text: string; tone: 'ok' | 'warn'; canResend: boolean } | null {
  if (!n) return null;
  const to = n.recipient ? ` to ${n.recipient}` : '';
  switch (n.status) {
    case 'sent':
      return { text: `Email sent${to}.`, tone: 'ok', canResend: false };
    case 'pending':
      return { text: `Email${to} is being sent${n.reason ? ' (trying again after a problem)' : ''}.`, tone: 'ok', canResend: false };
    case 'blocked':
      return { text: `Email${to} was not sent: Lumitra Mail blocks that address (an earlier bounce or complaint). Use another address in the form settings, or lift the block in Lumitra Mail, then send again.`, tone: 'warn', canResend: true };
    case 'failed':
      return { text: `Email${to} could not be sent${n.reason ? `: ${n.reason}` : ''}.`, tone: 'warn', canResend: true };
    case 'skipped':
      if (n.reason === 'no_company') {
        return { text: 'No email was sent: this site is not linked to a company yet, so there is no Lumitra Mail connection to send from.', tone: 'warn', canResend: false };
      }
      if (n.reason === 'internal_error') {
        return { text: 'No email was sent: it could not be prepared when this message arrived (the message itself is stored).', tone: 'warn', canResend: false };
      }
      if (n.reason === 'rate_limited') {
        return { text: 'No email was sent: this company reached the limit of 100 notification emails in an hour. The message is stored here; send the email again later.', tone: 'warn', canResend: true };
      }
      return n.reason === 'not_connected'
        ? { text: 'No email was sent: connect Lumitra Mail on the payments page to be told about new messages.', tone: 'warn', canResend: true }
        : { text: 'No email was sent: neither this form nor the site settings name an address. Set a notification address in the form settings, publish, then send again.', tone: 'warn', canResend: true };
  }
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

type ShownRow = Pick<SubmissionItem, 'id' | 'createdAt'>;

/**
 * The email status of the rows on screen. One page of the list holds at most 200 rows, and new submissions push the
 * shown ones further down, so the cursor is followed (newest first) until every shown row is covered, or the list has
 * passed the oldest of them (a row deleted elsewhere is not looked for to the end). Null when a page cannot be read.
 */
async function readNotifications(
  rows: readonly ShownRow[],
  url: (extra: Record<string, string>) => string,
): Promise<Map<string, SubmissionItem['notification']> | null> {
  const found = new Map<string, SubmissionItem['notification']>();
  const wanted = new Set(rows.map((r) => r.id));
  const oldest = rows.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), rows[0]?.createdAt ?? '');
  let cursor: string | null = null;
  do {
    const res: Response = await fetch(url({ limit: '200', ...(cursor ? { cursor } : {}) }), { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as ListResponse;
    for (const s of data.submissions) {
      if (wanted.delete(s.id)) found.set(s.id, s.notification);
    }
    const last = data.submissions[data.submissions.length - 1];
    cursor = last && last.createdAt >= oldest ? data.nextCursor : null;
  } while (cursor && wanted.size > 0);
  return found;
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

  // How many times the email status was polled in the current round of polling (see below).
  const [syncTick, setSyncTick] = useState(0);

  const refresh = useCallback(async () => {
    setLoad({ kind: 'loading' });
    // A load starts a new round of polling.
    setSyncTick(0);
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

  // The email status of the rows on screen, read again without touching the list (no loading state, same rows, same cursor):
  // after "send again", and while any email is still being sent, so the line never keeps saying "being sent" for a letter that
  // was sent or failed meanwhile. Stops by itself after about five minutes; a reload or another "send again" starts it again.
  // Counts the accepted "send again" clicks: an answer that was asked for before the latest one is out of date and dropped.
  const resends = useRef(0);
  // Only the rows whose email is pending are asked for (and `also`, the row a refused "send again" was about), so the cursor is
  // followed no further than the oldest of those, never through every page of loaded rows on every tick.
  const syncNotifications = useCallback(async (also?: ShownRow) => {
    const rows: ShownRow[] = items.filter((s) => s.notification?.status === 'pending' || s.id === also?.id);
    if (rows.length === 0) return;
    const askedAfter = resends.current;
    try {
      const fresh = await readNotifications(rows, query);
      if (!fresh || askedAfter !== resends.current) return;
      setItems((prev) => prev.map((s) => (fresh.has(s.id) ? { ...s, notification: fresh.get(s.id) ?? null } : s)));
    } catch {
      // The next tick tries again.
    }
  }, [query, items]);
  const anyPending = items.some((s) => s.notification?.status === 'pending');
  useEffect(() => {
    if (!anyPending || syncTick >= 60) return undefined;
    const timer = setTimeout(() => {
      void syncNotifications().finally(() => setSyncTick((n) => n + 1));
    }, 5000);
    return () => clearTimeout(timer);
  }, [anyPending, syncTick, syncNotifications, items]);

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

  const resend = async (item: SubmissionItem) => {
    setBusyId(item.id);
    setRowError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(item.id)}/resend`, { method: 'POST' });
      if (res.status === 404) {
        await refresh();
        return;
      }
      if (!res.ok) {
        setRowError({ id: item.id, message: await readError(res, 'Could not send the email again') });
        // The line on screen may be out of date (it was sent, or another round started): show what is true now.
        void syncNotifications(item);
        return;
      }
      resends.current += 1;
      setSyncTick(0);
      setItems((prev) =>
        prev.map((s) => (s.id === item.id && s.notification ? { ...s, notification: { ...s.notification, status: 'pending', reason: null } } : s)),
      );
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
              setSyncTick(0);
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
                      {notificationNote(item.notification)?.tone === 'warn' && ' · no email sent'}
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
                    {(() => {
                      const note = notificationNote(item.notification);
                      if (!note) return null;
                      return (
                        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="submission-email-status">
                          <p className={note.tone === 'warn' ? 'text-destructive' : 'text-muted-foreground'} role={note.tone === 'warn' ? 'alert' : 'status'}>
                            {note.text}
                          </p>
                          {note.canResend && (
                            <Button type="button" size="sm" variant="outline" disabled={busyId === item.id} onClick={() => void resend(item)}>
                              <Mail /> Send email again
                            </Button>
                          )}
                        </div>
                      );
                    })()}
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
