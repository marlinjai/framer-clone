'use client';

// src/app/projects/payments/ReceiptEmailCard.tsx
//
// "Receipt email" on the payments page (docs/plans/2026-10-27-shop-receipt-email.md, decision 2): the shop sends
// each buyer an order confirmation with a link to their receipt, from one of the company's Lumitra Mail
// workspaces. Connected: which workspace and sender, letters that could not be sent, change or disconnect. Not
// connected: choose a workspace of this company and a sending account, then Connect. Every refusal of the
// server is shown as text, with the next step.

import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, Mail } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface Connection {
  workspaceId: string;
  workspaceName: string;
  sender: string;
  connectedAt: string;
  failed: { count: number; latestReason: string | null };
}

interface Status {
  configured: boolean;
  connection: Connection | null;
  workspaces: { id: string; name: string; role: string }[];
  otherCompanies: number;
  workspacesError?: string;
}

const MAIL_DASHBOARD = 'https://app.mail.lumitra.co';
const SELECT =
  'h-9 w-full rounded-lg border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';

function newAttempt(): string {
  return `connect-${crypto.randomUUID()}`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return body.error?.message ?? `${fallback} (${res.status})`;
}

export default function ReceiptEmailCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const [senders, setSenders] = useState<{ id: string; label: string }[] | null>(null);
  const [providerId, setProviderId] = useState('');
  const [busy, setBusy] = useState(false);
  // After a disconnect whose key the person could not revoke in Lumitra Mail.
  const [keyLeft, setKeyLeft] = useState(false);
  // One attempt id per press that can still succeed: a press while one is running is blocked (busy), and after a
  // failed connect the next press gets a new id, because a failed connect revokes the key it made and Lumitra
  // Mail would answer the same id with that revoked key again.
  const [attempt, setAttempt] = useState(newAttempt);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/payments/mail');
      if (!res.ok) {
        setError(await readError(res, 'the receipt email status could not be read'));
        return;
      }
      setStatus((await res.json()) as Status);
    } catch {
      setError('the receipt email status could not be read; check your connection and reload');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function chooseWorkspace(id: string) {
    setWorkspaceId(id);
    setSenders(null);
    setProviderId('');
    if (!id) return;
    setError(null);
    try {
      const res = await fetch(`/api/payments/mail/senders?workspace=${encodeURIComponent(id)}`);
      if (!res.ok) {
        setError(await readError(res, 'the sending accounts could not be read'));
        setSenders([]);
        return;
      }
      const body = (await res.json()) as { senders: { id: string; label: string }[] };
      setSenders(body.senders);
      if (body.senders.length === 1) setProviderId(body.senders[0].id);
    } catch {
      setError('the sending accounts could not be read; check your connection');
      setSenders([]);
    }
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/payments/mail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, providerId, attempt }),
      });
      // Success or failure, this attempt is used up (see above).
      setAttempt(newAttempt());
      if (!res.ok) {
        setError(await readError(res, 'the shop could not be connected'));
        return;
      }
      setChoosing(false);
      await load();
    } catch {
      // The answer was lost: the next press is a new attempt too; a key made meanwhile is revoked by the
      // connect that succeeds (it replaces the connection).
      setAttempt(newAttempt());
      setError('the shop could not be connected; check your connection and try again');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/payments/mail', { method: 'DELETE' });
      if (!res.ok) {
        setError(await readError(res, 'the shop could not be disconnected'));
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { keyRevoked?: boolean };
      setKeyLeft(body.keyRevoked === false);
      await load();
    } catch {
      setError('the shop could not be disconnected; check your connection and try again');
    } finally {
      setBusy(false);
    }
  }

  const connection = status?.connection ?? null;
  const showChooser = status?.configured && (choosing || !connection);

  return (
    <section aria-labelledby="receipt-email-heading" className="glass rounded-2xl p-5" data-testid="receipt-email">
      <div className="flex items-start gap-3">
        <Mail aria-hidden className="mt-0.5 size-5 text-foreground/70" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="receipt-email-heading" className="text-base font-semibold">
            Receipt email{' '}
            {status ? (
              <span className="font-normal text-muted-foreground">· {connection ? 'Connected' : status.configured ? 'Not connected' : 'Not available'}</span>
            ) : null}
          </h2>
          <p className="text-sm text-muted-foreground">
            {status === null && !error
              ? 'Reading the receipt email status…'
              : !status?.configured
                ? 'Receipt emails through Lumitra Mail are not set up on this platform yet. Buyers still see their order number after paying.'
                : connection
                  ? `Each buyer gets an order confirmation with a link to their receipt, from ${connection.sender} (Lumitra Mail workspace "${connection.workspaceName}").`
                  : 'Send each buyer an order confirmation with a link to their receipt, from one of this company’s Lumitra Mail workspaces. Until then, buyers get no email.'}
          </p>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {keyLeft ? (
        <p role="status" className="mt-3 text-sm text-amber-600 dark:text-amber-400">
          The shop no longer sends mail. Its key in Lumitra Mail is still there, because you are not an admin of that
          workspace: ask an admin to revoke &quot;Lumitra Sites shop&quot; under API keys in{' '}
          <a className="underline" href={MAIL_DASHBOARD} target="_blank" rel="noreferrer">
            Lumitra Mail
          </a>
          .
        </p>
      ) : null}

      {connection && connection.failed.count > 0 ? (
        <p role="status" className="mt-3 text-sm text-amber-600 dark:text-amber-400">
          {connection.failed.count === 1 ? 'One letter' : `${connection.failed.count} letters`} of the last 30 days could not be sent
          {connection.failed.latestReason ? `: ${connection.failed.latestReason}` : '.'}
        </p>
      ) : null}

      {connection && !choosing ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChoosing(true)}>
            Change
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect()}>
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            Disconnect
          </Button>
        </div>
      ) : null}

      {showChooser ? (
        <div className="mt-4 flex flex-col gap-3">
          {status.workspacesError ? (
            <p className="text-sm text-muted-foreground">
              Lumitra Mail cannot list your workspaces right now. <button className="underline" onClick={() => void load()}>Try again</button>
            </p>
          ) : status.workspaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This company has no Lumitra Mail workspace you can use yet
              {status.otherCompanies > 0 ? ` (your ${status.otherCompanies === 1 ? 'one workspace belongs' : `${status.otherCompanies} workspaces belong`} to another company)` : ''}. Create one for this company in{' '}
              <a className="underline" href={MAIL_DASHBOARD} target="_blank" rel="noreferrer">
                Lumitra Mail <ExternalLink aria-hidden className="inline size-3" />
              </a>
              , add a sending account there, then reload this page.
            </p>
          ) : (
            <>
              <label className="flex flex-col gap-1 text-sm">
                Lumitra Mail workspace
                <select className={SELECT} value={workspaceId} onChange={(e) => void chooseWorkspace(e.target.value)}>
                  <option value="">Choose a workspace</option>
                  {status.workspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name}
                      {ws.role === 'owner' || ws.role === 'admin' ? '' : ` (you are ${ws.role}: connecting needs an owner or admin)`}
                    </option>
                  ))}
                </select>
              </label>
              {workspaceId && senders !== null ? (
                senders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This workspace has no sending account yet. Add one in{' '}
                    <a className="underline" href={MAIL_DASHBOARD} target="_blank" rel="noreferrer">
                      Lumitra Mail
                    </a>
                    , then choose the workspace again.
                  </p>
                ) : (
                  <label className="flex flex-col gap-1 text-sm">
                    Send from
                    <select className={SELECT} value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                      <option value="">Choose a sending account</option>
                      {senders.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={busy || !workspaceId || !providerId} onClick={() => void connect()}>
                  {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
                  Connect
                </Button>
                {connection ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChoosing(false)}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        Connecting installs two mail templates in the workspace (the order confirmation and the notice when a late
        payment had to be refunded), in German and English, and gives the shop a key that can only send.
      </p>
    </section>
  );
}
