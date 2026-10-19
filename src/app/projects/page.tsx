// src/app/projects/page.tsx
//
// The per-user/workspace projects dashboard (MT-09). A server component: it
// reads the auth-brain session from the request cookies, derives the tenant
// scope from that SERVER-verified session (never a client-supplied workspace),
// and lists ONLY the caller's sites. The "New project" affordance is a small
// client island (NewProjectButton); everything else renders on the server.
//
// Self-guarding: no valid session -> redirect to the auth-brain login with a
// `return_to` of this dashboard (the middleware bounce contract). A VALID
// session with no active workspace renders the WorkspaceChooser instead, never
// a redirect: bouncing a signed-in user to the login looped forever (auth-brain
// sends a valid session straight back), 2026-10-19.
//
// Query parameters (all display-only; none of them changes the scope):
//   ?switch=1   open the chooser although a workspace is active,
//   ?next=...   a validated editor path (safeEditorReturnPath, never an open
//               redirect) to continue to: carried through the login and the
//               chooser, and followed as soon as a workspace is active,
//   ?error=...  a refused choice, shown as an alert in the chooser.

import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { safeEditorReturnPath } from '@/server/auth/activeWorkspace';
import { loadDashboard } from './loader';
import NewProjectButton from './NewProjectButton';
import WorkspaceChooser, { workspaceLabel } from './WorkspaceChooser';
import AuthUnavailable from './AuthUnavailable';
import { chooseWorkspace } from './workspace-actions';

export const dynamic = 'force-dynamic';

/** Render a site's updated date in a stable, human-readable form. */
function formatUpdated(value: Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

const CHOOSER_ERRORS: Record<string, string> = {
  workspace_unavailable:
    'That workspace is not available to your account any more. Pick another one.',
};

/** The first value of a search param, or null. */
function param(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

interface ProjectsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProjectsPage({ searchParams }: ProjectsPageProps) {
  const query = await searchParams;
  const forceChooser = param(query.switch) === '1';
  const next = safeEditorReturnPath(param(query.next));
  const data = await loadDashboard({ forceChooser, next });
  if (data.status === 'unauthenticated') {
    // No valid session -> bounce to auth-brain login (the only login redirect).
    redirect(data.loginUrl);
  }

  if (data.status === 'auth_unavailable') {
    // auth-brain could not answer: a retry notice, never the login (an outage
    // must not loop a signed-in user through the login).
    const retryHref =
      next === '/projects' ? '/projects' : `/projects?next=${encodeURIComponent(next)}`;
    return <AuthUnavailable retryHref={retryHref} />;
  }

  if (data.status === 'choose_workspace') {
    const errorCode = param(query.error);
    return (
      <WorkspaceChooser
        workspaces={data.workspaces}
        activeWorkspaceId={data.activeWorkspaceId}
        next={next}
        error={errorCode ? (CHOOSER_ERRORS[errorCode] ?? null) : null}
        portalUrl={new URL('/', process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co').toString()}
        action={chooseWorkspace}
      />
    );
  }

  // A deep link that came through the login (or the chooser) continues to
  // its project now that a workspace is active. Loop-free: the project loader
  // resolves the same workspace, and its only way back here is the FORCED
  // chooser (`switch=1`), which renders and never forwards.
  if (next !== '/projects' && !forceChooser) {
    redirect(next);
  }

  const { sites, workspaces, activeWorkspace } = data;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span>
              Sites in <span className="font-medium text-foreground">{workspaceLabel(activeWorkspace)}</span>
            </span>
            {workspaces.length > 1 ? (
              <Link
                href="/projects?switch=1"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Switch workspace
              </Link>
            ) : null}
          </p>
        </div>
        <NewProjectButton />
      </header>

      {sites.length === 0 ? (
        <section className="rounded-lg border border-dashed p-10 text-center">
          <h2 className="text-base font-medium">No projects yet</h2>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Create your first project to start building.
          </p>
          <div className="mt-6 flex justify-center">
            <NewProjectButton />
          </div>
        </section>
      ) : (
        <ul className="flex flex-col gap-2">
          {sites.map((site) => (
            <li key={site.siteId}>
              <Link
                href={`/projects/${site.siteId}`}
                className="flex items-center justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-accent"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium">
                    {site.name || 'Untitled Project'}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Updated {formatUpdated(site.updatedAt)}
                  </span>
                </span>
                <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                  {site.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
