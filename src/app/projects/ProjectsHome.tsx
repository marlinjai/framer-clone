// src/app/projects/ProjectsHome.tsx: the projects home, Direction A
// (docs/plans/2026-11-23-sites-home-and-light-mode.md, decided by Marlin on 2026-11-23): a top bar,
// the projects as cards with a "New project" card, and the company's tools as a quiet row below.
// Data-free: the dashboard page (page.tsx) loads and passes everything, so the layout can also be
// rendered with sample data (the browser harness, home.harness.tsx).
import React from 'react';
import Link from 'next/link';
import type { SiteSummary } from '@/server/sites/repository';
import type { CompanyChoice } from '@/server/sites/scope';
import { DEMO_PATH } from '@/lib/projects/demoAddress';
import NewProjectButton from './NewProjectButton';
import ProjectCard from './ProjectCard';
import HomeTopBar from './HomeTopBar';
import Greeting from './Greeting';

// A fixed locale and time zone, so the server's render is the same everywhere ("22 Nov 2026").
const UPDATED = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Render a site's updated date in a stable, human-readable form. */
function formatUpdated(value: Date): string {
  return UPDATED.format(new Date(value));
}

export interface ProjectsHomeProps {
  sites: SiteSummary[];
  companies: CompanyChoice[];
  activeCompany: CompanyChoice;
  booksEnabled: boolean;
  /** Show open branch counts (site branches are on for the company). */
  branchesOn: boolean;
  accountHref: string;
  /** `<label>.<base host>` for a subdomain, or null. */
  liveHostFor: (subdomain: string | null) => string | null;
}

export default function ProjectsHome({
  sites,
  companies,
  activeCompany,
  booksEnabled,
  branchesOn,
  accountHref,
  liveHostFor,
}: ProjectsHomeProps) {
  const tool =
    'block rounded-lg border border-border bg-card px-3.5 py-3 transition-colors hover:border-input hover:bg-accent focus-visible:outline-none focus-visible:shadow-selection';

  // The projects home, Direction A (docs/plans/2026-11-23-sites-home-and-light-mode.md, decided
  // by Marlin on 2026-11-23): a top bar, the projects as cards with a "New project" card, and the
  // company's tools as a quiet row below.
  return (
    <div className="relative min-h-svh overflow-x-hidden bg-background text-foreground">
      <div aria-hidden="true" className="home-glow pointer-events-none absolute inset-0" />
      <HomeTopBar companyName={activeCompany.name} canSwitchCompany={companies.length > 1} accountHref={accountHref} />
      <main className="relative mx-auto w-full max-w-5xl px-4 pb-12 pt-6 sm:px-6 sm:pt-8">
        {/* Persistent live region for list changes made on this page (a deleted
            project's card is gone, so it cannot announce itself). Present and
            empty from the first render, so screen readers pick up later text. */}
        <p id="projects-status" role="status" aria-live="polite" className="sr-only" />
        <Greeting className="text-2xl font-semibold tracking-tight sm:text-[26px]" />
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          {sites.length === 0 ? 'No projects yet in ' : `${sites.length} ${sites.length === 1 ? 'project' : 'projects'} in `}
          <span className="font-medium text-foreground">{activeCompany.name}</span>
          {companies.length > 1 ? (
            <>
              {' · '}
              <Link href="/projects?switch=1" className="text-[var(--link)] underline underline-offset-4 hover:text-foreground">
                Switch company
              </Link>
            </>
          ) : null}
        </p>

        <h1
          id="projects-heading"
          tabIndex={-1}
          className="mb-2.5 text-xs font-semibold uppercase tracking-[0.06em] text-muted-foreground outline-none"
        >
          Projects
        </h1>
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] sm:gap-4">
          {sites.map((site) => (
            <li key={site.siteId}>
              <ProjectCard
                siteId={site.siteId}
                name={site.name}
                status={site.status}
                updatedLabel={formatUpdated(site.updatedAt)}
                liveHost={liveHostFor(site.subdomain)}
                customDomains={site.customDomains}
                openBranches={branchesOn ? site.openBranches : null}
                cardColors={site.cardColors}
              />
            </li>
          ))}
          <li className={sites.length === 0 ? 'col-span-2 sm:col-span-1' : undefined}>
            <NewProjectButton variant="card" />
          </li>
        </ul>

        <nav aria-label="Tools" className="mt-7">
          <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 sm:gap-3">
            {/* The catalogue and payments come with the `sites` grant every company on this page holds. */}
            <li>
              <Link href="/projects/catalog" className={tool}>
                <span className="block font-semibold">Catalog</span>
                <span className="block text-xs text-muted-foreground">Products and collections</span>
              </Link>
            </li>
            <li>
              <Link href="/projects/payments" className={tool}>
                <span className="block font-semibold">Payments</span>
                <span className="block text-xs text-muted-foreground">Orders and receipts</span>
              </Link>
            </li>
            {booksEnabled ? (
              <li>
                <Link href="/projects/books" className={tool}>
                  <span className="block font-semibold">Books</span>
                  <span className="block text-xs text-muted-foreground">Invoices and customers</span>
                </Link>
              </li>
            ) : null}
            <li>
              <a href={DEMO_PATH} className={tool}>
                <span className="block font-semibold">Demo editor</span>
                <span className="block text-xs text-muted-foreground">Try ideas, nothing is saved</span>
              </a>
            </li>
          </ul>
        </nav>
      </main>
    </div>
  );
}
