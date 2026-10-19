// src/app/projects/WorkspaceChooser.tsx
//
// The workspace chooser on /projects. Rendered (never redirected to the login)
// whenever the session is valid but no workspace is active: the user has
// several workspaces and has not picked one, or opened "Switch workspace".
//
// Pure presentational server component: one plain HTML form per workspace,
// posting to the `action` the page passes in (the chooseWorkspace server
// action), so it works without client script. The action re-validates the id
// against the verified session before writing the `framer_ws` cookie; nothing
// rendered here is trusted.

import React from 'react';
import Link from 'next/link';
import type { WorkspaceChoice } from '@/server/sites';

export interface WorkspaceChooserProps {
  workspaces: WorkspaceChoice[];
  /** The workspace already active (switch mode), marked and cancellable. */
  activeWorkspaceId: string | null;
  /** Where to continue after choosing (validated again by the action). */
  next: string;
  /** Shown when the last choice was refused (not a workspace of the session). */
  error: string | null;
  /** The auth-brain portal, for a user who belongs to no workspace yet. */
  portalUrl: string;
  action: (formData: FormData) => Promise<void>;
}

/** "Company / Workspace", or just one of them when the other adds nothing. */
export function workspaceLabel(w: WorkspaceChoice): string {
  if (!w.companyName) return w.name;
  if (!w.name || w.name === w.companyName) return w.companyName;
  return `${w.companyName} / ${w.name}`;
}

export default function WorkspaceChooser({
  workspaces,
  activeWorkspaceId,
  next,
  error,
  portalUrl,
  action,
}: WorkspaceChooserProps) {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Choose a workspace</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {activeWorkspaceId
            ? 'Pick the workspace whose projects you want to work on.'
            : 'You belong to more than one workspace. Pick the one whose projects you want to work on; you can switch at any time.'}
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

      {workspaces.length === 0 ? (
        <section className="rounded-lg border border-dashed p-10 text-center">
          <h2 className="text-base font-medium">No workspace yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Your account is not a member of any workspace. Ask a company owner to
            invite you, or create a company in your account.
          </p>
          <a
            href={portalUrl}
            className="mt-6 inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            Open your account
          </a>
        </section>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Workspaces">
          {workspaces.map((w) => {
            const isActive = w.id === activeWorkspaceId;
            return (
              <li key={w.id}>
                <form action={action}>
                  <input type="hidden" name="workspaceId" value={w.id} />
                  <input type="hidden" name="next" value={next} />
                  <button
                    type="submit"
                    aria-current={isActive ? 'true' : undefined}
                    className="flex w-full items-center justify-between gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{workspaceLabel(w)}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {w.companySlug ? `${w.companySlug} · ${w.slug}` : w.slug}
                      </span>
                    </span>
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
      )}

      {activeWorkspaceId ? (
        <p className="mt-6 text-sm">
          <Link href="/projects" className="text-muted-foreground underline-offset-4 hover:underline">
            Cancel
          </Link>
        </p>
      ) : null}
    </main>
  );
}
