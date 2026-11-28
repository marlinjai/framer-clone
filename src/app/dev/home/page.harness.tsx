// src/app/dev/home/page.harness.tsx
//
// The projects home with sample data, for browser proof of the layout without a session or a
// database (docs/plans/2026-11-23-sites-home-and-light-mode.md, S5). Like the Books engine
// harness it exists only in a build with BOOKS_ENGINE_HARNESS=1 (next.config.ts) and never ships.
// `?empty=1` shows the empty state, `?companies=1` a single company.
import '../../globals.css';
import React from 'react';
import ProjectsHome from '../../projects/ProjectsHome';
import type { SiteSummary } from '@/server/sites/repository';

const day = (d: string) => new Date(`2026-11-${d}T10:00:00Z`);
const site = (siteId: string, name: string, status: string, updated: string, extra: Partial<SiteSummary> = {}): SiteSummary => ({
  siteId, name, description: '', status, lumitraEnabled: false, createdAt: day('01'), updatedAt: day(updated),
  subdomain: null, customDomains: [], openBranches: 0, cardColors: null, ...extra,
});

const SITES: SiteSummary[] = [
  site('s1', 'Lumitra (new landing page)', 'published', '22', {
    openBranches: 1,
    cardColors: { background: '#04090b', text: '#e8f2ef', accent: '#52ffa5' },
  }),
  site('s2', 'FX proof', 'published', '14', { cardColors: { background: '#120b2e', text: '#ffffff', accent: '#3b84ff' } }),
  site('s3', 'Bakery Sommer', 'draft', '20', {
    subdomain: 'baeckerei',
    cardColors: { background: '#fbf6ee', text: '#3b2a1a', accent: '#c4622d' },
  }),
  site('s4', 'Untitled Project', 'draft', '23'),
];
const ACME = { id: 't-a', name: 'Lumitra', slug: 'lumitra', workspaceId: 'w' };
const BETA = { id: 't-b', name: 'Studio Beta', slug: 'beta', workspaceId: 'w2' };

export default async function HomeHarness({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const q = await searchParams;
  return (
    <ProjectsHome
      sites={q.empty === '1' ? [] : SITES}
      companies={q.companies === '1' ? [ACME] : [ACME, BETA]}
      activeCompany={ACME}
      booksEnabled
      branchesOn
      accountHref="https://auth.lumitra.co/"
      liveHostFor={(sub) => (sub ? `${sub}.sites.lumitra.co` : null)}
    />
  );
}
// ci-replay touch
