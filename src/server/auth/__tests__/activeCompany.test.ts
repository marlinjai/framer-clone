// src/server/auth/__tests__/activeCompany.test.ts
//
// The write side of the `framer_company` selector: the cookie is written ONLY
// for a company of the verified session that holds the `sites` grant (and has
// a workspace for the user), with host-only httpOnly attributes, and the
// retired `framer_ws` cookie is deleted in the same write. A forged id, a
// company without the grant or a missing session leaves both untouched. Also
// the `next` path validation that keeps the chooser from becoming an open
// redirect.

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
import { safeEditorReturnPath, selectActiveCompany } from '../activeCompany';

/** Companies t-a and t-b have Sites; t-c does not. One workspace each. */
function multiSession(granted = ['t-a', 't-b']) {
  const ids = ['t-a', 't-b', 't-c'];
  return {
    user: { id: 'u' },
    session: {},
    tenants: ids.map((id) => ({
      id,
      group_id: `tg_${id}`,
      name: id,
      slug: id,
      app_grants: granted.includes(id) ? ['sites'] : [],
    })),
    workspaces: ids.map((id) => ({ id: `ws_${id}`, tenant_id: id, name: 'Main', slug: 'main' })),
    active_tenant: null,
    active_workspace: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jar = { lumitra_session: 'sess', framer_ws: 'ws_t-a' };
  mockVerifySession.mockResolvedValue(multiSession());
});

describe('selectActiveCompany', () => {
  it('writes the host-only, httpOnly framer_company cookie and deletes framer_ws', async () => {
    const result = await selectActiveCompany('t-b');

    expect(result).toEqual({ ok: true, companyId: 't-b' });
    expect(mockSet).toHaveBeenCalledTimes(2);
    const [name, value, options] = mockSet.mock.calls[0];
    expect(name).toBe('framer_company');
    expect(value).toBe('t-b');
    expect(options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect(options).not.toHaveProperty('domain');

    const [legacyName, legacyValue, legacyOptions] = mockSet.mock.calls[1];
    expect(legacyName).toBe('framer_ws');
    expect(legacyValue).toBe('');
    expect(legacyOptions).toMatchObject({ path: '/', maxAge: 0 });
  });

  it('refuses a company WITHOUT the sites grant and writes nothing', async () => {
    expect(await selectActiveCompany('t-c')).toEqual({ ok: false, reason: 'not_available' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a forged id and writes nothing', async () => {
    expect(await selectActiveCompany('t-foreign')).toEqual({ ok: false, reason: 'not_available' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a non-string or empty id', async () => {
    expect(await selectActiveCompany(null)).toEqual({ ok: false, reason: 'not_available' });
    expect(await selectActiveCompany('')).toEqual({ ok: false, reason: 'not_available' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses without a session cookie or with an invalid session', async () => {
    jar = {};
    expect(await selectActiveCompany('t-a')).toEqual({ ok: false, reason: 'unauthenticated' });

    jar = { lumitra_session: 'bad' };
    mockVerifySession.mockResolvedValueOnce(null);
    expect(await selectActiveCompany('t-a')).toEqual({ ok: false, reason: 'unauthenticated' });

    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('verifySession failed: 400', 400));
    expect(await selectActiveCompany('t-a')).toEqual({ ok: false, reason: 'unauthenticated' });

    expect(mockSet).not.toHaveBeenCalled();
  });

  it('reports an auth-brain outage as auth_unavailable and writes nothing', async () => {
    mockVerifySession.mockRejectedValueOnce(new AuthBrainNetworkError(new Error('down')));
    expect(await selectActiveCompany('t-a')).toEqual({ ok: false, reason: 'auth_unavailable' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('a company whose grant was just revoked can no longer be selected', async () => {
    mockVerifySession.mockResolvedValue(multiSession(['t-a']));
    expect(await selectActiveCompany('t-b')).toEqual({ ok: false, reason: 'not_available' });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('sets secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await selectActiveCompany('t-a');
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
    ['/projects/migrate-company', '/projects'],
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
