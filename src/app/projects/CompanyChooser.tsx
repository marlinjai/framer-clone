// src/app/projects/CompanyChooser.tsx
//
// The company chooser on /projects. Rendered (never redirected to the login)
// whenever the session is valid but no company is active: the user has several
// companies with Lumitra Sites and has not picked one, or opened "Switch
// company". Only companies holding the auth-brain app grant `sites` are listed
// (the loader passes listCompanyChoices); the others are not shown at all.
//
// Pure presentational server component: one plain HTML form per company,
// posting to the `action` the page passes in (the chooseCompany server action),
// so it works without client script. The action re-validates the id against
// the verified session and the grant before writing the `framer_company`
// cookie; nothing rendered here is trusted.

import React from 'react';
import Link from 'next/link';
import type { CompanyChoice } from '@/server/sites';

export interface CompanyChooserProps {
  companies: CompanyChoice[];
  /** The company already active (switch mode), marked and cancellable. */
  activeCompanyId: string | null;
  /** Where to continue after choosing (validated again by the action). */
  next: string;
  /** Shown when the last choice was refused (not a usable company any more). */
  error: string | null;
  action: (formData: FormData) => Promise<void>;
}

export default function CompanyChooser({
  companies,
  activeCompanyId,
  next,
  error,
  action,
}: CompanyChooserProps) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Choose a company</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {activeCompanyId
            ? 'Pick the company whose sites you want to work on.'
            : 'Lumitra Sites is enabled for more than one of your companies. Pick the one whose sites you want to work on; you can switch at any time.'}
        </p>
      </header>

      {error ? (
        <p
          role="alert"
          className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      <ul className="flex flex-col gap-2" aria-label="Companies">
        {companies.map((c) => {
          const isActive = c.id === activeCompanyId;
          return (
            <li key={c.id}>
              <form action={action}>
                <input type="hidden" name="companyId" value={c.id} />
                <input type="hidden" name="next" value={next} />
                <button
                  type="submit"
                  aria-current={isActive ? 'true' : undefined}
                  className="flex w-full items-center justify-between gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 truncate font-medium">{c.name}</span>
                  {isActive ? (
                    <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                      Current
                    </span>
                  ) : null}
                </button>
              </form>
            </li>
          );
        })}
      </ul>

      {activeCompanyId ? (
        <p className="mt-6 text-sm">
          <Link href="/projects" className="text-muted-foreground underline-offset-4 hover:underline">
            Cancel
          </Link>
        </p>
      ) : null}
    </main>
  );
}
