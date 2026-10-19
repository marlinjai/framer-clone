// src/server/auth/__tests__/requireWorkspaceScope.test.ts
//
// The server-action guard resolves the workspace exactly like the routes and
// loaders: the membership-checked `framer_ws` selector, else active_workspace,
// else the only workspace; without one it throws a 403 AuthError (a rejected
// action), never a silent write to a guessed workspace.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockVerifySession = vi.fn();
const mockCan = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => mockVerifySession(...args),
    can: (...args: unknown[]) => mockCan(...args),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

let jar: Record<string, string> = {};
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
  }),
}));

import { AuthBrainError } from '@marlinjai/auth-brain-sdk';
import { AuthError, requireWorkspaceScope } from '../requireWorkspaceScope';

function multiSession() {
  return {
    user: { id: 'u' },
    session: {},
    tenants: [
      { id: 't-a', app_grants: ['sites'], group_id: 'tg_a' },
      { id: 't-b', app_grants: ['sites'], group_id: 'tg_b' },
    ],
    workspaces: [
      { id: 'ws_a', tenant_id: 't-a' },
      { id: 'ws_b', tenant_id: 't-b' },
    ],
    active_tenant: null,
    active_workspace: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySession.mockResolvedValue(multiSession());
  mockCan.mockResolvedValue(true);
});

describe('requireWorkspaceScope', () => {
  it("uses the selected company's workspace (framer_company)", async () => {
    jar = { lumitra_session: 'sess', framer_company: 't-b' };

    await expect(requireWorkspaceScope('editSite')).resolves.toEqual({
      workspaceId: 'ws_b',
      tenantGroupId: 'tg_b',
    });
    expect(mockCan).toHaveBeenCalledWith('u', 'workspace.admin', {
      type: 'workspace',
      id: 'ws_b',
      workspaceId: 'ws_b',
    });
  });

  it('throws 403 no_active_company without a resolvable company, and for a forged selector', async () => {
    const extras: Array<Record<string, string>> = [
      {},
      { framer_company: 't-foreign' },
      { framer_ws: 'ws_foreign' },
    ];
    for (const extra of extras) {
      jar = { lumitra_session: 'sess', ...extra };
      const err = await requireWorkspaceScope('editSite').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
      expect((err as AuthError).code).toBe('no_active_company');
    }
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('throws 403 sites_not_enabled when no company of the session holds the grant', async () => {
    const s = multiSession();
    mockVerifySession.mockResolvedValue({
      ...s,
      tenants: s.tenants.map((t) => ({ ...t, app_grants: [] })),
    });
    jar = { lumitra_session: 'sess', framer_company: 't-a' };
    const err = await requireWorkspaceScope('editSite').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(403);
    expect((err as AuthError).code).toBe('sites_not_enabled');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('throws 401 without a session', async () => {
    jar = { framer_company: 't-a' };
    const err = await requireWorkspaceScope().catch((e: unknown) => e);
    expect((err as AuthError).status).toBe(401);
  });

  it('throws 503 auth_unavailable when auth-brain cannot answer (never 401)', async () => {
    jar = { lumitra_session: 'sess', framer_company: 't-a' };
    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('verifySession failed: 504', 504));
    const err = await requireWorkspaceScope().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(503);
    expect((err as AuthError).code).toBe('auth_unavailable');
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('throws 403 forbidden when OpenFGA answers a real deny', async () => {
    jar = { lumitra_session: 'sess', framer_company: 't-a' };
    mockCan.mockResolvedValueOnce(false);
    const err = await requireWorkspaceScope('editSite').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(403);
    expect((err as AuthError).code).toBe('forbidden');
  });

  it('throws 503 authz_unavailable (never 403) when OpenFGA cannot answer', async () => {
    jar = { lumitra_session: 'sess', framer_company: 't-a' };
    mockCan.mockRejectedValueOnce(new AuthBrainError('OpenFGA check failed: 401', 401));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await requireWorkspaceScope('editSite').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(503);
    expect((err as AuthError).code).toBe('authz_unavailable');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
