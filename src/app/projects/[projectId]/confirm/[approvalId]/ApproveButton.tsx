'use client';

// src/app/projects/[projectId]/confirm/[approvalId]/ApproveButton.tsx
//
// The two buttons of the approval page. Each is a same-origin POST (never a GET,
// so a link preview or a prefetch cannot decide anything); the route checks the
// session, publishSite and the request again, and the middleware refuses a write
// from another origin.

import React, { useState } from 'react';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done'; decision: 'approve' | 'decline' } | { kind: 'error'; message: string };

export default function ApproveButton({
  projectId,
  approvalId,
  label,
  decided,
}: {
  projectId: string;
  approvalId: string;
  label: string;
  decided: 'approve' | 'decline' | null;
}) {
  const [state, setState] = useState<State>(decided ? { kind: 'done', decision: decided } : { kind: 'idle' });

  async function send(decision: 'approve' | 'decline') {
    setState({ kind: 'sending' });
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/confirmations/${encodeURIComponent(approvalId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ decision }),
      });
      if (res.ok) {
        setState({ kind: 'done', decision });
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setState({ kind: 'error', message: body?.error?.message ?? `the request failed (${res.status})` });
    } catch {
      setState({ kind: 'error', message: 'the request did not reach the server; check your connection and try again' });
    }
  }

  if (state.kind === 'done') {
    return (
      <p role="status" className="text-sm font-medium">
        {state.decision === 'approve'
          ? 'Approved. Tell the agent; it carries this out on its next call.'
          : 'Declined. Nothing will be published from this request.'}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={state.kind === 'sending'}
        onClick={() => void send('approve')}
        className="inline-flex h-9 items-center rounded-md bg-foreground px-4 text-sm font-medium text-background disabled:opacity-50"
      >
        {label}
      </button>
      <button
        type="button"
        disabled={state.kind === 'sending'}
        onClick={() => void send('decline')}
        className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent disabled:opacity-50"
      >
        Decline
      </button>
      {state.kind === 'error' ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
