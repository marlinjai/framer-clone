// src/app/projects/page.tsx
//
// The per-user/workspace projects dashboard (MT-09). A server component: it
// reads the auth-brain session from the request cookies, derives the tenant
// scope from that SERVER-verified session (never a client-supplied workspace),
// and lists ONLY the caller's sites. The "New project" affordance is a small
// client island (NewProjectButton); everything else renders on the server.
//
// Self-guarding: no valid session / no resolvable workspace -> redirect to the
// auth-brain login with a `return_to` of this dashboard (the middleware bounce
// contract). This page is NOT in the middleware matcher (that is MT-16); it
// fences itself here so it can never render another tenant's data.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { loadDashboard } from './loader';
import NewProjectButton from './NewProjectButton';

export const dynamic = 'force-dynamic';

/** Render a site's updated date in a stable, human-readable form. */
function formatUpdated(value: Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

export default async function ProjectsPage() {
  const data = await loadDashboard();
  if (!data.authenticated) {
    // No valid session / workspace -> bounce to auth-brain login.
    redirect(data.loginUrl);
  }

  const { sites } = data;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <header className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your workspace&rsquo;s sites.
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
