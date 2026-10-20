// src/components/domains/DomainsPanel.tsx
//
// The editor's "Domains" panel for one project (plan
// docs/plans/2026-06-25-framer-custom-domains.md): connect a custom domain,
// show the exact DNS records to create, verify, show the status (pending,
// verified, active, failed with its reason) and disconnect.
//
// ALL STATE IS THE SERVER'S. The panel keeps no derived copy of a domain: it
// renders the list the server returns and replaces it after every action, so
// a reload, another tab or another admin always sees the same truth (resume),
// and a disconnected domain's records and token can never linger in the UI
// (revise, re-entry). Only the text field and the in-flight action are local.
//
// Errors surface where they happened: a refused add under the field, a failed
// action on its domain card, a load failure with a retry. A DNS problem is not
// an error response: it comes back as status `failed` with a reason.
'use client';

import React from 'react';
import { CheckCircle2, Clock, Copy, Globe, RefreshCw, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type DomainStatus = 'pending' | 'verified' | 'active' | 'failed';

export interface DnsRecordInstruction {
  type: 'TXT' | 'CNAME' | 'A' | 'AAAA';
  name: string;
  value: string;
  purpose: 'ownership' | 'routing';
  recommended: boolean;
  note?: string;
}

export interface DomainView {
  id: string;
  hostname: string;
  displayHostname: string;
  status: DomainStatus;
  serving: boolean;
  lastErrorCode: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  verifiedAt: string | null;
  activatedAt: string | null;
  records: DnsRecordInstruction[];
}

interface ListResponse {
  configured: boolean;
  domains: DomainView[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; configured: boolean; domains: DomainView[] };

type Busy = { id: string; action: 'verify' | 'remove' } | null;

async function readError(res: Response, fallback: string): Promise<string> {
  const payload: unknown = await res.json().catch(() => null);
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' && message ? message : `${fallback} (${res.status}).`;
}

const STATUS_LABEL: Record<DomainStatus, string> = {
  pending: 'Waiting for DNS',
  verified: 'Verified, certificate pending',
  active: 'Active',
  failed: 'Failed',
};

function StatusBadge({ status }: { status: DomainStatus }) {
  const style: Record<DomainStatus, string> = {
    pending: 'bg-muted text-muted-foreground',
    verified: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    failed: 'bg-destructive/15 text-destructive',
  };
  const Icon = { pending: Clock, verified: ShieldCheck, active: CheckCircle2, failed: XCircle }[status];
  return (
    <span
      data-testid="domain-status"
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style[status]}`}
    >
      <Icon size={12} aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refused (permissions, insecure context): the value stays
      // selectable in the table, so nothing is lost.
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
    </button>
  );
}

function RecordsTable({ records }: { records: DnsRecordInstruction[] }) {
  const ownership = records.filter((r) => r.purpose === 'ownership');
  const routing = records.filter((r) => r.purpose === 'routing');
  const row = (r: DnsRecordInstruction, i: number) => (
    <tr key={`${r.type}-${r.name}-${r.value}-${i}`} className="align-top">
      <td className="py-1 pr-2 font-mono text-[11px] font-semibold">{r.type}</td>
      <td className="py-1 pr-2">
        <div className="flex items-start gap-1">
          <code className="break-all font-mono text-[11px] select-all">{r.name}</code>
          <CopyButton value={r.name} label={`${r.type} name`} />
        </div>
      </td>
      <td className="py-1">
        <div className="flex items-start gap-1">
          <code className="break-all font-mono text-[11px] select-all">{r.value}</code>
          <CopyButton value={r.value} label={`${r.type} value`} />
        </div>
        {r.note && <div className="text-[11px] text-muted-foreground">{r.note}</div>}
      </td>
    </tr>
  );
  return (
    <div className="space-y-2 text-xs" data-testid="dns-records">
      <p className="text-muted-foreground">
        1. Prove you own the domain with this TXT record:
      </p>
      <table className="w-full">
        <tbody>{ownership.map(row)}</tbody>
      </table>
      <p className="text-muted-foreground">
        2. Point the domain at us with ONE of these (the first is recommended). If your DNS is on
        Cloudflare, set the record to DNS only (grey cloud).
      </p>
      <table className="w-full">
        <tbody>{routing.map(row)}</tbody>
      </table>
    </div>
  );
}

function DomainCard({
  domain,
  busy,
  error,
  onVerify,
  onRemove,
}: {
  domain: DomainView;
  busy: Busy;
  error: string | null;
  onVerify: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const verifying = busy?.id === domain.id && busy.action === 'verify';
  const removing = busy?.id === domain.id && busy.action === 'remove';
  const showRecords = domain.status === 'pending' || domain.status === 'failed';

  return (
    <li
      className="space-y-2 rounded-lg border border-border p-3"
      data-testid="domain-card"
      data-hostname={domain.hostname}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Globe size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          {domain.serving ? (
            <a
              href={`https://${domain.hostname}`}
              target="_blank"
              rel="noreferrer"
              className="truncate text-sm font-medium underline"
            >
              {domain.displayHostname}
            </a>
          ) : (
            <span className="truncate text-sm font-medium">{domain.displayHostname}</span>
          )}
        </div>
        <StatusBadge status={domain.status} />
      </div>

      {domain.lastError && (
        <p
          role={domain.status === 'failed' ? 'alert' : 'status'}
          className={`text-xs ${domain.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {domain.lastError}
        </p>
      )}
      {domain.status === 'active' && !domain.lastError && (
        <p className="text-xs text-muted-foreground">Serving this site over HTTPS (when published).</p>
      )}

      {showRecords && domain.records.length > 0 && <RecordsTable records={domain.records} />}

      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onVerify} disabled={busy !== null}>
          <RefreshCw size={14} className={verifying ? 'animate-spin' : undefined} />
          {verifying ? 'Checking...' : domain.status === 'pending' ? 'Verify' : 'Check again'}
        </Button>
        {!confirming ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setConfirming(true)}
            disabled={busy !== null}
          >
            <Trash2 size={14} />
            Disconnect
          </Button>
        ) : (
          <span className="flex items-center gap-2 text-xs">
            <span>
              {domain.serving ? 'The site stops answering on this domain.' : 'Remove this domain?'}
            </span>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                onRemove();
              }}
              disabled={busy !== null}
            >
              {removing ? 'Disconnecting...' : 'Yes, disconnect'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </span>
        )}
      </div>
    </li>
  );
}

export function DomainsPanel({ projectId }: { projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/domains`;
  const [load, setLoad] = React.useState<LoadState>({ kind: 'loading' });
  const [input, setInput] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [addError, setAddError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<Busy>(null);
  const [cardErrors, setCardErrors] = React.useState<Record<string, string>>({});

  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (!res.ok) {
        setLoad({ kind: 'error', message: await readError(res, 'Could not load the domains') });
        return;
      }
      const data = (await res.json()) as ListResponse;
      setLoad({ kind: 'ready', configured: data.configured, domains: data.domains });
    } catch {
      setLoad({ kind: 'error', message: 'Network error while loading the domains.' });
    }
  }, [base]);

  React.useEffect(() => {
    setLoad({ kind: 'loading' });
    setInput('');
    setAddError(null);
    setCardErrors({});
    void refresh();
  }, [refresh]);

  const replaceDomain = (domain: DomainView) =>
    setLoad((prev) =>
      prev.kind === 'ready'
        ? {
            ...prev,
            domains: prev.domains.some((d) => d.id === domain.id)
              ? prev.domains.map((d) => (d.id === domain.id ? domain : d))
              : [...prev.domains, domain],
          }
        : prev,
    );

  const setCardError = (id: string, message: string | null) =>
    setCardErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!input.trim() || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hostname: input }),
      });
      if (!res.ok) {
        setAddError(await readError(res, 'Could not add the domain'));
        return;
      }
      const { domain } = (await res.json()) as { domain: DomainView };
      replaceDomain(domain);
      setInput('');
    } catch {
      setAddError('Network error while adding the domain.');
    } finally {
      setAdding(false);
    }
  };

  const verify = async (domain: DomainView) => {
    setBusy({ id: domain.id, action: 'verify' });
    setCardError(domain.id, null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(domain.id)}/verify`, { method: 'POST' });
      if (!res.ok) {
        setCardError(domain.id, await readError(res, 'Could not check the domain'));
        if (res.status === 404) await refresh();
        return;
      }
      const { domain: updated } = (await res.json()) as { domain: DomainView };
      replaceDomain(updated);
    } catch {
      setCardError(domain.id, 'Network error while checking the domain.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (domain: DomainView) => {
    setBusy({ id: domain.id, action: 'remove' });
    setCardError(domain.id, null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(domain.id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        setCardError(domain.id, await readError(res, 'Could not disconnect the domain'));
        return;
      }
      // Removed (or already gone): drop it, then reload the server's truth.
      setLoad((prev) =>
        prev.kind === 'ready' ? { ...prev, domains: prev.domains.filter((d) => d.id !== domain.id) } : prev,
      );
      setCardError(domain.id, null);
      await refresh();
    } catch {
      setCardError(domain.id, 'Network error while disconnecting the domain.');
    } finally {
      setBusy(null);
    }
  };

  if (load.kind === 'loading') {
    return <p className="text-sm text-muted-foreground">Loading domains...</p>;
  }
  if (load.kind === 'error') {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {load.message}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!load.configured && (
        <p role="status" className="rounded-md bg-muted p-2 text-xs text-muted-foreground">
          Custom domains are not set up on this server yet, so new domains cannot be connected.
        </p>
      )}

      <form onSubmit={add} className="space-y-1" aria-label="Connect a domain">
        <label htmlFor="domain-input" className="text-xs font-medium">
          Connect a domain you own
        </label>
        <div className="flex gap-2">
          <Input
            id="domain-input"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (addError) setAddError(null);
            }}
            placeholder="www.example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={!load.configured || adding}
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? 'domain-add-error' : undefined}
          />
          <Button type="submit" size="sm" disabled={!load.configured || adding || !input.trim()}>
            {adding ? 'Adding...' : 'Add'}
          </Button>
        </div>
        {addError && (
          <p id="domain-add-error" role="alert" className="text-xs text-destructive">
            {addError}
          </p>
        )}
      </form>

      {load.domains.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No custom domain yet. The site stays reachable on its own address either way.
        </p>
      ) : (
        <ul className="space-y-3">
          {load.domains.map((domain) => (
            <DomainCard
              key={domain.id}
              domain={domain}
              busy={busy}
              error={cardErrors[domain.id] ?? null}
              onVerify={() => void verify(domain)}
              onRemove={() => void remove(domain)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default DomainsPanel;
