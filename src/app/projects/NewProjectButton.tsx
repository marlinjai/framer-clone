'use client';

// src/app/projects/NewProjectButton.tsx
//
// The "New project" affordance for the /projects dashboard (MT-09). A small
// client island: it POSTs to /api/projects (MT-05), which mints an empty draft
// in the caller's active company SERVER-SIDE and returns its id, then
// navigates to that project's editor route.
//
// It is intentionally the ONLY client boundary on the dashboard — the page
// stays a server component. Keep server-only imports OUT of this file (the
// `next build` boundary check runs in the verify gate).

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';

export default function NewProjectButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createProject() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Empty body -> the route creates an "Untitled Project" draft.
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        // Prefer the server's own explanation (e.g. `no_active_company` when
        // the company was switched in another tab) over a bare status code.
        let message = `Could not create a new project (${res.status}).`;
        try {
          const body: { error?: { code?: string; message?: string } } = await res.json();
          const code = body.error?.code;
          if (code === 'no_active_company') {
            message = 'No company is selected. Reload the page and choose a company.';
          } else if (code === 'sites_not_enabled') {
            message =
              'Could not create a new project: Lumitra Sites is not enabled for this company.';
          } else if (code === 'authz_unavailable') {
            // OpenFGA (the permission service) could not answer. Not a deny:
            // the user may well be allowed, so say it is temporary.
            message =
              'Could not create a new project: the permission service is temporarily unavailable. Please try again in a moment.';
          } else if (code === 'auth_unavailable') {
            message =
              'Could not create a new project: the sign-in service is temporarily unavailable. Please try again in a moment.';
          } else if (body.error?.message) {
            message = `Could not create a new project: ${body.error.message}`;
          }
        } catch {
          // Non-JSON error body: keep the status-code message.
        }
        throw new Error(message);
      }
      const data: { siteId?: string } = await res.json();
      if (!data.siteId) {
        throw new Error('The server did not return a new project id.');
      }
      router.push(`/projects/${data.siteId}`);
    } catch (err) {
      // Surface the failure — never silently swallow it.
      setError(err instanceof Error ? err.message : 'Could not create a new project.');
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <Button onClick={createProject} disabled={busy} aria-busy={busy}>
        {busy ? 'Creating…' : 'New project'}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
