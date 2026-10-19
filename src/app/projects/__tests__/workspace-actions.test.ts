// @vitest-environment node
//
// src/app/projects/__tests__/workspace-actions.test.ts
//
// The chooseWorkspace server action (the chooser's and the switcher's form
// post): it writes the selector only through selectActiveWorkspace's
// membership check and then continues to a VALIDATED editor path.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSelect = vi.fn();
vi.mock('@/server/auth/activeWorkspace', async (importActual) => {
  const actual = await importActual<typeof import('@/server/auth/activeWorkspace')>();
  return { ...actual, selectActiveWorkspace: (...a: unknown[]) => mockSelect(...a) };
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

import { chooseWorkspace } from '../workspace-actions';

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

describe('chooseWorkspace', () => {
  it('selects the workspace and continues to the dashboard', async () => {
    mockSelect.mockResolvedValue({ ok: true, workspaceId: 'ws_b' });

    expect(await redirectOf(chooseWorkspace(form({ workspaceId: 'ws_b' })))).toBe('/projects');
    expect(mockSelect).toHaveBeenCalledWith('ws_b');
  });

  it('continues to the editor path it came from', async () => {
    mockSelect.mockResolvedValue({ ok: true, workspaceId: 'ws_b' });

    expect(
      await redirectOf(chooseWorkspace(form({ workspaceId: 'ws_b', next: '/projects/site_9/preview' }))),
    ).toBe('/projects/site_9/preview');
  });

  it('never redirects off-site through next', async () => {
    mockSelect.mockResolvedValue({ ok: true, workspaceId: 'ws_b' });

    expect(
      await redirectOf(chooseWorkspace(form({ workspaceId: 'ws_b', next: 'https://evil.example' }))),
    ).toBe('/projects');
  });

  it('a refused (forged or stale) id goes back to the chooser with an error', async () => {
    mockSelect.mockResolvedValue({ ok: false, reason: 'not_a_member' });

    expect(await redirectOf(chooseWorkspace(form({ workspaceId: 'ws_x', next: '/projects/s' })))).toBe(
      '/projects?switch=1&error=workspace_unavailable',
    );
  });

  it('no session goes to the dashboard, which sends it to the login', async () => {
    mockSelect.mockResolvedValue({ ok: false, reason: 'unauthenticated' });

    expect(await redirectOf(chooseWorkspace(form({ workspaceId: 'ws_a' })))).toBe('/projects');
  });

  it('an auth-brain outage continues to the requested page (its retry notice), not the login', async () => {
    mockSelect.mockResolvedValue({ ok: false, reason: 'auth_unavailable' });

    expect(
      await redirectOf(chooseWorkspace(form({ workspaceId: 'ws_a', next: '/projects/site_2' }))),
    ).toBe('/projects/site_2');
  });
});
