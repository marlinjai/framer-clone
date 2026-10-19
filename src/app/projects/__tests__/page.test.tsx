// @vitest-environment node
//
// src/app/projects/__tests__/page.test.tsx
//
// The dashboard page's control flow: only `unauthenticated` redirects to the
// login; a validated `next` deep link is followed once a workspace is active,
// but never from the forced chooser (`switch=1`), which is how the project
// loader sends a link from another workspace back here. That is what keeps
// next-forwarding loop-free.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLoadDashboard = vi.fn();
vi.mock('../loader', () => ({ loadDashboard: (...a: unknown[]) => mockLoadDashboard(...a) }));
vi.mock('../workspace-actions', () => ({ chooseWorkspace: vi.fn() }));
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
}));

import ProjectsPage from '../page';

const WS = { id: 'ws_a', name: 'Acme', slug: 'acme', companyName: 'Acme', companySlug: 'acme' };
const OK = { status: 'ok', sites: [], workspaces: [WS], activeWorkspace: WS };

async function run(query: Record<string, string>) {
  try {
    const element = await ProjectsPage({ searchParams: Promise.resolve(query) });
    return { element, redirect: null as string | null };
  } catch (err) {
    if (err instanceof RedirectSignal) return { element: null, redirect: err.url };
    throw err;
  }
}

beforeEach(() => vi.clearAllMocks());

describe('ProjectsPage', () => {
  it('passes the validated next and switch flag to the loader', async () => {
    mockLoadDashboard.mockResolvedValue(OK);
    await run({ next: 'https://evil.example', switch: '1' });
    expect(mockLoadDashboard).toHaveBeenCalledWith({ forceChooser: true, next: '/projects' });
  });

  it('follows a deep link once a workspace is active', async () => {
    mockLoadDashboard.mockResolvedValue(OK);
    expect((await run({ next: '/projects/site_1' })).redirect).toBe('/projects/site_1');
  });

  it('never forwards from the forced chooser (loop guard)', async () => {
    mockLoadDashboard.mockResolvedValue({ status: 'choose_workspace', workspaces: [WS], activeWorkspaceId: 'ws_a' });
    const result = await run({ switch: '1', next: '/projects/site_1' });
    expect(result.redirect).toBeNull();
    expect(result.element).not.toBeNull();
  });

  it('renders the dashboard without next', async () => {
    mockLoadDashboard.mockResolvedValue(OK);
    expect((await run({})).redirect).toBeNull();
  });

  it('redirects only an unauthenticated visitor to the login', async () => {
    mockLoadDashboard.mockResolvedValue({ status: 'unauthenticated', loginUrl: 'https://auth/login' });
    expect((await run({})).redirect).toBe('https://auth/login');
    mockLoadDashboard.mockResolvedValue({ status: 'auth_unavailable' });
    expect((await run({ next: '/projects/site_1' })).redirect).toBeNull();
  });
});
