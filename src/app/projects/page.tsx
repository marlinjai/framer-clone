// src/app/projects/page.tsx
//
// The per-company projects dashboard (MT-09). A server component: it reads the
// auth-brain session from the request cookies, derives the tenant scope from
// that SERVER-verified session (never a client-supplied company or workspace),
// and lists ONLY the active company's sites. Only companies holding the
// auth-brain app grant `sites` can be active. The "New project" affordance is a small
// client island (NewProjectButton); everything else renders on the server.
//
// Self-guarding: no valid session -> redirect to the auth-brain login with a
// `return_to` of this dashboard (the middleware bounce contract). A VALID
// session with no active company renders the CompanyChooser, and one with no
// company that has Lumitra Sites renders SitesNotEnabled: never a login
// redirect, because bouncing a signed-in user to the login looped forever
// (auth-brain sends a valid session straight back), 2026-10-19. The only other
// redirect is the one-time hop that migrates the retired `framer_ws` cookie
// (`migrated=1` on the way back makes it unrepeatable).
//
// Query parameters (all display-only; none of them changes the scope):
//   ?switch=1   open the chooser although a company is active,
//   ?next=...   a validated editor path (safeEditorReturnPath, never an open
//               redirect) to continue to: carried through the login and the
//               chooser, and followed as soon as a company is active,
//   ?error=...  a refused choice, shown as an alert in the chooser,
//   ?migrated=1 set by the cookie migration handler; never migrate again.

import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { safeEditorReturnPath } from '@/server/auth/activeCompany';
import { loadDashboard } from './loader';
import NewProjectButton from './NewProjectButton';
import ProjectCard from './ProjectCard';
import CompanyChooser from './CompanyChooser';
import SitesNotEnabled from './SitesNotEnabled';
import AuthUnavailable from './AuthUnavailable';
import { chooseCompany } from './company-actions';

export const dynamic = 'force-dynamic';

/** Render a site's updated date in a stable, human-readable form. */
function formatUpdated(value: Date): string {
  return new Date(value).toISOString().slice(0, 10);
}

/** `<label>.<PUBLIC_SITE_BASE_HOST>` for a site's subdomain, or null. */
function liveHostFor(subdomain: string | null): string | null {
  const base = process.env.PUBLIC_SITE_BASE_HOST?.trim();
  return subdomain && base ? `${subdomain}.${base}` : null;
}

const CHOOSER_ERRORS: Record<string, string> = {
  company_unavailable:
    'Lumitra Sites is not available for that company any more. Pick another one.',
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
  const legacyMigrated = param(query.migrated) === '1';
  const data = await loadDashboard({ forceChooser, next, legacyMigrated });
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

  if (data.status === 'migrate_legacy') {
    // Once: the handler deletes `framer_ws` and returns with `migrated=1`, on
    // which the loader never produces this outcome again.
    redirect(data.migrateUrl);
  }

  if (data.status === 'not_enabled') {
    return (
      <SitesNotEnabled
        portalUrl={new URL('/', process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co').toString()}
        grantedWithoutWorkspace={data.grantedWithoutWorkspace}
      />
    );
  }

  if (data.status === 'choose_company') {
    const errorCode = param(query.error);
    return (
      <CompanyChooser
        companies={data.companies}
        activeCompanyId={data.activeCompanyId}
        next={next}
        error={errorCode ? (CHOOSER_ERRORS[errorCode] ?? null) : null}
        action={chooseCompany}
      />
    );
  }

  // A deep link that came through the login (or the chooser) continues to
  // its project now that a company is active. Loop-free: the project loader
  // resolves the same company, and its only way back here is the FORCED
  // chooser (`switch=1`), which renders and never forwards.
  if (next !== '/projects' && !forceChooser) {
    redirect(next);
  }

  const { sites, companies, activeCompany, booksEnabled } = data;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      {/* Persistent live region for list changes made on this page (a deleted
          project's card is gone, so it cannot announce itself). Present and
          empty from the first render, so screen readers pick up later text. */}
      <p id="projects-status" role="status" aria-live="polite" className="sr-only" />
      <header className="mb-8 flex items-center justify-between gap-4">
        <div>
          <h1 id="projects-heading" tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
            Projects
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span>
              Sites in <span className="font-medium text-foreground">{activeCompany.name}</span>
            </span>
            {companies.length > 1 ? (
              <Link
                href="/projects?switch=1"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Switch company
              </Link>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* The catalogue and payments come with the `sites` grant every company on this page holds. */}
          <Link
            href="/projects/catalog"
            className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Catalog
          </Link>
          <Link
            href="/projects/payments"
            className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
          >
            Payments
          </Link>
          {booksEnabled ? (
            <Link
              href="/projects/books"
              className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              Books
            </Link>
          ) : null}
          <NewProjectButton />
        </div>
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
              <ProjectCard
                siteId={site.siteId}
                name={site.name}
                status={site.status}
                updatedLabel={formatUpdated(site.updatedAt)}
                liveHost={liveHostFor(site.subdomain)}
                customDomains={site.customDomains}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
