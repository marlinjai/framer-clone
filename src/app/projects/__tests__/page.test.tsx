// @vitest-environment node
//
// src/app/projects/__tests__/page.test.tsx
//
// The dashboard page's control flow: only `unauthenticated` redirects to the
// login, and `migrate_legacy` redirects once to the cookie migration handler;
// the chooser and the not-enabled page render. A validated `next` deep link is
// followed once a company is active, but never from the forced chooser
// (`switch=1`), which is how the project loader sends a link from another
// company back here. That is what keeps next-forwarding loop-free. The header
// reads "Sites in <Company>" with "Switch company" only when there is a choice.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLoadDashboard = vi.fn();
vi.mock('../loader', () => ({ loadDashboard: (...a: unknown[]) => mockLoadDashboard(...a) }));
vi.mock('../company-actions', () => ({ chooseCompany: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/auth-brain', () => ({ authBrainClient: { verifySession: vi.fn() } }));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(url);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
  useRouter: () => ({ push: vi.fn() }),
}));

import ProjectsPage from '../page';

const ACME = { id: 't-a', name: 'Acme', slug: 'acme', workspaceId: 'ws_a' };
const BETA = { id: 't-b', name: 'Beta', slug: 'beta', workspaceId: 'ws_b' };
const OK = { status: 'ok', sites: [], companies: [ACME], activeCompany: ACME };

async function run(query: Record<string, string>) {
  try {
    const element = await ProjectsPage({ searchParams: Promise.resolve(query) });
    return { element, redirect: null as string | null };
  } catch (err) {
    if (err instanceof RedirectSignal) return { element: null, redirect: err.url };
    throw err;
  }
}

function html(element: React.ReactElement | null): string {
  if (!element) throw new Error('expected a rendered page');
  return renderToStaticMarkup(element);
}

beforeEach(() => vi.clearAllMocks());

describe('ProjectsPage', () => {
  it('passes the validated next, the switch flag and the migrated marker to the loader', async () => {
    mockLoadDashboard.mockResolvedValue(OK);
    await run({ next: 'https://evil.example', switch: '1', migrated: '1' });
    expect(mockLoadDashboard).toHaveBeenCalledWith({
      forceChooser: true,
      next: '/projects',
      legacyMigrated: true,
    });
  });

  it('follows a deep link once a company is active', async () => {
    mockLoadDashboard.mockResolvedValue(OK);
    expect((await run({ next: '/projects/site_1' })).redirect).toBe('/projects/site_1');
  });

  it('never forwards from the forced chooser (loop guard)', async () => {
    mockLoadDashboard.mockResolvedValue({
      status: 'choose_company',
      companies: [ACME, BETA],
      activeCompanyId: 't-a',
    });
    const result = await run({ switch: '1', next: '/projects/site_1' });
    expect(result.redirect).toBeNull();
    expect(html(result.element as React.ReactElement)).toContain('Choose a company');
  });

  it('renders the header "Sites in <Company>", without a switch link for one company', async () => {
    mockLoadDashboard.mockResolvedValue(OK);
    const result = await run({});
    expect(result.redirect).toBeNull();
    const page = html(result.element as React.ReactElement);
    expect(page).toMatch(/Sites in <span[^>]*>Acme<\/span>/);
    expect(page).not.toContain('Switch company');
    expect(page).not.toMatch(/workspace/i);
  });

  it('offers "Switch company" when the user has several companies with Sites', async () => {
    mockLoadDashboard.mockResolvedValue({ ...OK, companies: [ACME, BETA] });
    const page = html((await run({})).element as React.ReactElement);
    expect(page).toContain('Switch company');
    expect(page).toContain('href="/projects?switch=1"');
  });

  it('renders the not-enabled page with the portal link, never a redirect', async () => {
    mockLoadDashboard.mockResolvedValue({ status: 'not_enabled', grantedWithoutWorkspace: [] });
    const result = await run({ next: '/projects/site_1' });
    expect(result.redirect).toBeNull();
    const page = html(result.element as React.ReactElement);
    expect(page).toContain('Lumitra Sites is not enabled for your companies');
    expect(page).toContain('href="https://auth.lumitra.co/"');
  });

  it('redirects once to the migration handler for migrate_legacy', async () => {
    mockLoadDashboard.mockResolvedValue({
      status: 'migrate_legacy',
      migrateUrl: '/projects/migrate-company',
    });
    expect((await run({})).redirect).toBe('/projects/migrate-company');
  });

  it('redirects only an unauthenticated visitor to the login', async () => {
    mockLoadDashboard.mockResolvedValue({ status: 'unauthenticated', loginUrl: 'https://auth/login' });
    expect((await run({})).redirect).toBe('https://auth/login');
    mockLoadDashboard.mockResolvedValue({ status: 'auth_unavailable' });
    expect((await run({ next: '/projects/site_1' })).redirect).toBeNull();
  });
});
