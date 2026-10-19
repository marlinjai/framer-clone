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
      { id: 't-a', group_id: 'tg_a' },
      { id: 't-b', group_id: 'tg_b' },
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
  it('uses the framer_ws workspace when the session contains it', async () => {
    jar = { lumitra_session: 'sess', framer_ws: 'ws_b' };

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

  it('throws 403 without a resolvable workspace, and for a forged selector', async () => {
    const extras: Array<Record<string, string>> = [{}, { framer_ws: 'ws_foreign' }];
    for (const extra of extras) {
      jar = { lumitra_session: 'sess', ...extra };
      const err = await requireWorkspaceScope('editSite').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
    }
    expect(mockCan).not.toHaveBeenCalled();
  });

  it('throws 401 without a session', async () => {
    jar = { framer_ws: 'ws_a' };
    const err = await requireWorkspaceScope().catch((e: unknown) => e);
    expect((err as AuthError).status).toBe(401);
  });

  it('throws 503 auth_unavailable when auth-brain cannot answer (never 401)', async () => {
    jar = { lumitra_session: 'sess', framer_ws: 'ws_a' };
    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('verifySession failed: 504', 504));
    const err = await requireWorkspaceScope().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(503);
    expect((err as AuthError).code).toBe('auth_unavailable');
    expect(mockCan).not.toHaveBeenCalled();
  });
});
