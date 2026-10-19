// src/app/projects/SitesNotEnabled.tsx
//
// The page a signed-in user sees when none of their companies can use the
// editor: no company holds the auth-brain app grant `sites`, or the granted
// ones have no workspace for this user. A terminal page, never a redirect:
// there is nothing to choose, and the session is valid, so the login would
// send the user straight back (the redirect loop of 2026-10-19).
//
// Access is requested in the auth-brain portal, so that is the one action.

import React from 'react';

export interface SitesNotEnabledProps {
  /** The auth-brain portal (https://auth.lumitra.co in production). */
  portalUrl: string;
  /** Granted companies the user has no workspace in, named for clarity. */
  grantedWithoutWorkspace: string[];
}

export default function SitesNotEnabled({
  portalUrl,
  grantedWithoutWorkspace,
}: SitesNotEnabledProps) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <section className="rounded-lg border border-dashed p-10 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          Lumitra Sites is not enabled for your companies
        </h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          The site editor is available to companies that have Lumitra Sites. Ask an
          owner of your company to request access in the Lumitra account portal.
        </p>
        {grantedWithoutWorkspace.length > 0 ? (
          <p className="mx-auto mt-3 max-w-md text-sm text-muted-foreground">
            Lumitra Sites is enabled for {grantedWithoutWorkspace.join(', ')}, but your
            account has no access to its sites yet. Ask an owner of that company to add
            you.
          </p>
        ) : null}
        <a
          href={portalUrl}
          className="mt-6 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
        >
          Open the account portal
        </a>
      </section>
    </main>
  );
}
