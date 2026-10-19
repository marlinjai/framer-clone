// @vitest-environment node
//
// src/app/projects/__tests__/company-actions.test.ts
//
// The chooseCompany server action (the chooser's and the switcher's form
// post): it writes the selector only through selectActiveCompany's session and
// `sites` grant check and then continues to a VALIDATED editor path.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSelect = vi.fn();
vi.mock('@/server/auth/activeCompany', async (importActual) => {
  const actual = await importActual<typeof import('@/server/auth/activeCompany')>();
  return { ...actual, selectActiveCompany: (...a: unknown[]) => mockSelect(...a) };
});

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('@/lib/auth-brain', () => ({ authBrainClient: { verifySession: vi.fn() } }));

import { chooseCompany } from '../company-actions';

function form(values: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  if (!(err instanceof RedirectSignal)) throw new Error('expected a redirect');
  return err.url;
}

beforeEach(() => vi.clearAllMocks());

describe('chooseCompany', () => {
  it('selects the company and continues to the dashboard', async () => {
    mockSelect.mockResolvedValue({ ok: true, companyId: 't_b' });

    expect(await redirectOf(chooseCompany(form({ companyId: 't_b' })))).toBe('/projects');
    expect(mockSelect).toHaveBeenCalledWith('t_b');
  });

  it('continues to the editor path it came from', async () => {
    mockSelect.mockResolvedValue({ ok: true, companyId: 't_b' });

    expect(
      await redirectOf(chooseCompany(form({ companyId: 't_b', next: '/projects/site_9/preview' }))),
    ).toBe('/projects/site_9/preview');
  });

  it('never redirects off-site through next', async () => {
    mockSelect.mockResolvedValue({ ok: true, companyId: 't_b' });

    expect(
      await redirectOf(chooseCompany(form({ companyId: 't_b', next: 'https://evil.example' }))),
    ).toBe('/projects');
  });

  it('a refused (forged, stale or ungranted) id goes back to the chooser with an error', async () => {
    mockSelect.mockResolvedValue({ ok: false, reason: 'not_available' });

    expect(await redirectOf(chooseCompany(form({ companyId: 't_x', next: '/projects/s' })))).toBe(
      '/projects?switch=1&error=company_unavailable&next=%2Fprojects%2Fs',
    );
    expect(await redirectOf(chooseCompany(form({ companyId: 't_x' })))).toBe(
      '/projects?switch=1&error=company_unavailable',
    );
  });

  it('no session goes to the dashboard, which sends it to the login', async () => {
    mockSelect.mockResolvedValue({ ok: false, reason: 'unauthenticated' });

    expect(await redirectOf(chooseCompany(form({ companyId: 't_a' })))).toBe('/projects');
  });

  it('an expired session keeps the deep link as a validated next', async () => {
    mockSelect.mockResolvedValue({ ok: false, reason: 'unauthenticated' });

    expect(
      await redirectOf(chooseCompany(form({ companyId: 't_a', next: '/projects/site_7/preview' }))),
    ).toBe('/projects?next=%2Fprojects%2Fsite_7%2Fpreview');
    expect(
      await redirectOf(chooseCompany(form({ companyId: 't_a', next: 'https://evil.example' }))),
    ).toBe('/projects');
  });

  it('an auth-brain outage continues to the requested page (its retry notice), not the login', async () => {
    mockSelect.mockResolvedValue({ ok: false, reason: 'auth_unavailable' });

    expect(
      await redirectOf(chooseCompany(form({ companyId: 't_a', next: '/projects/site_2' }))),
    ).toBe('/projects/site_2');
  });
});
