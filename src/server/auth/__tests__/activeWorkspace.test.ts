// src/server/auth/__tests__/activeWorkspace.test.ts
//
// The write side of the `framer_ws` selector: the cookie is written ONLY for a
// workspace of the verified session, with host-only httpOnly attributes, and a
// forged id or a missing session leaves it untouched. Also the `next` path
// validation that keeps the chooser from becoming an open redirect.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockVerifySession = vi.fn();
vi.mock('@/lib/auth-brain', () => ({
  authBrainClient: {
    verifySession: (...args: unknown[]) => mockVerifySession(...args),
    can: vi.fn(),
    verifyApiKey: vi.fn(),
    getCurrentUser: vi.fn(),
  },
}));

let jar: Record<string, string> = {};
const mockSet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
    set: (...args: unknown[]) => mockSet(...args),
    delete: vi.fn(),
  }),
}));

import { AuthBrainError, AuthBrainNetworkError } from '@marlinjai/auth-brain-sdk';
import { safeEditorReturnPath, selectActiveWorkspace } from '../activeWorkspace';

function multiSession(workspaceIds = ['ws_a', 'ws_b']) {
  return {
    user: { id: 'u' },
    session: {},
    tenants: [],
    workspaces: workspaceIds.map((id) => ({ id, tenant_id: `t-${id}`, name: id, slug: id })),
    active_tenant: null,
    active_workspace: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jar = { lumitra_session: 'sess' };
  mockVerifySession.mockResolvedValue(multiSession());
});

describe('selectActiveWorkspace', () => {
  it('writes the host-only, httpOnly framer_ws cookie for a workspace of the session', async () => {
    const result = await selectActiveWorkspace('ws_b');

    expect(result).toEqual({ ok: true, workspaceId: 'ws_b' });
    expect(mockSet).toHaveBeenCalledTimes(1);
    const [name, value, options] = mockSet.mock.calls[0];
    expect(name).toBe('framer_ws');
    expect(value).toBe('ws_b');
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(options).not.toHaveProperty('domain');
  });

  it('refuses a forged id and writes nothing', async () => {
    expect(await selectActiveWorkspace('ws_foreign')).toEqual({ ok: false, reason: 'not_a_member' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a non-string or empty id', async () => {
    expect(await selectActiveWorkspace(null)).toEqual({ ok: false, reason: 'not_a_member' });
    expect(await selectActiveWorkspace('')).toEqual({ ok: false, reason: 'not_a_member' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses without a session cookie or with an invalid session', async () => {
    jar = {};
    expect(await selectActiveWorkspace('ws_a')).toEqual({ ok: false, reason: 'unauthenticated' });

    jar = { lumitra_session: 'bad' };
    mockVerifySession.mockResolvedValueOnce(null);
    expect(await selectActiveWorkspace('ws_a')).toEqual({ ok: false, reason: 'unauthenticated' });

    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('verifySession failed: 400', 400));
    expect(await selectActiveWorkspace('ws_a')).toEqual({ ok: false, reason: 'unauthenticated' });

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('reports an auth-brain outage as auth_unavailable and writes nothing', async () => {
    mockVerifySession.mockRejectedValueOnce(new AuthBrainNetworkError(new Error('down')));
    expect(await selectActiveWorkspace('ws_a')).toEqual({ ok: false, reason: 'auth_unavailable' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('a workspace the user was just removed from can no longer be selected', async () => {
    mockVerifySession.mockResolvedValue(multiSession(['ws_a']));
    expect(await selectActiveWorkspace('ws_b')).toEqual({ ok: false, reason: 'not_a_member' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('sets secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await selectActiveWorkspace('ws_a');
      expect(mockSet.mock.calls[0][2]).toMatchObject({ secure: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('safeEditorReturnPath', () => {
  it.each([
    ['/projects', '/projects'],
    ['/projects/site_1', '/projects/site_1'],
    ['/projects/0b6f-uuid/preview', '/projects/0b6f-uuid/preview'],
    ['https://evil.example/projects', '/projects'],
    ['//evil.example', '/projects'],
    ['/projects/../admin', '/projects'],
    ['/projects/x/edit', '/projects'],
    ['/projects?x=1', '/projects'],
    [null, '/projects'],
    [42, '/projects'],
  ])('%s -> %s', (input, expected) => {
    expect(safeEditorReturnPath(input)).toBe(expected);
  });
});
