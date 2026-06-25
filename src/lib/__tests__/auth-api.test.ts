// Unit tests for the request-level auth guards in src/lib/auth-api.ts.
//
// The auth-brain SDK client is mocked so these assert the GUARD behaviour
// (cookie parse -> verifySession -> workspace check) and the fail-closed
// outcomes (401 missing/invalid session, 403 missing workspace access) without
// any network.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { authenticateRequest, authenticateAccountRequest } from '@/lib/auth-api';

function reqWithCookie(cookie?: string): Request {
  const headers = new Headers();
  if (cookie !== undefined) headers.set('cookie', cookie);
  return new Request('https://framer.lumitra.co/api/sites/abc', { headers });
}

beforeEach(() => {
  mockVerifySession.mockReset();
  mockCan.mockReset();
});

describe('authenticateRequest()', () => {
  it('401s when no lumitra_session cookie is present', async () => {
    const res = await authenticateRequest(reqWithCookie(), 'ws-1');
    expect(res).toEqual({ authenticated: false, error: 'Unauthorized', status: 401 });
    expect(mockVerifySession).not.toHaveBeenCalled();
  });

  it('401s when the session cookie is invalid/expired (verify returns null)', async () => {
    mockVerifySession.mockResolvedValue(null);
    const res = await authenticateRequest(reqWithCookie('lumitra_session=stale'), 'ws-1');
    expect(res).toEqual({ authenticated: false, error: 'Unauthorized', status: 401 });
  });

  it('403s when the session is valid but the user lacks workspace access', async () => {
    mockVerifySession.mockResolvedValue({ user: { id: 'user-1' } });
    mockCan.mockResolvedValue(false);
    const res = await authenticateRequest(reqWithCookie('lumitra_session=good'), 'ws-1', 'editSite');
    expect(res).toEqual({ authenticated: false, error: 'Forbidden', status: 403 });
  });

  it('authenticates and authorizes a valid session with workspace access', async () => {
    mockVerifySession.mockResolvedValue({ user: { id: 'user-1' } });
    mockCan.mockResolvedValue(true);
    const res = await authenticateRequest(reqWithCookie('lumitra_session=good'), 'ws-1', 'editSite');
    expect(res).toEqual({ authenticated: true, userId: 'user-1' });
    // editSite maps to the admin requirement
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', {
      type: 'workspace',
      id: 'ws-1',
      workspaceId: 'ws-1',
    });
  });

  it('defaults to the stricter editSite check when no action is passed', async () => {
    mockVerifySession.mockResolvedValue({ user: { id: 'user-1' } });
    mockCan.mockResolvedValue(true);
    await authenticateRequest(reqWithCookie('lumitra_session=good'), 'ws-1');
    expect(mockCan).toHaveBeenCalledWith('user-1', 'workspace.admin', expect.anything());
  });

  it('parses the session cookie even when other cookies precede it', async () => {
    mockVerifySession.mockResolvedValue({ user: { id: 'user-1' } });
    mockCan.mockResolvedValue(true);
    await authenticateRequest(
      reqWithCookie('theme=dark; lumitra_session=good; tz=UTC'),
      'ws-1',
    );
    expect(mockVerifySession).toHaveBeenCalledWith('good');
  });

  it('fails CLOSED (403) when the workspace check throws', async () => {
    mockVerifySession.mockResolvedValue({ user: { id: 'user-1' } });
    mockCan.mockRejectedValue(new Error('openfga down'));
    const res = await authenticateRequest(reqWithCookie('lumitra_session=good'), 'ws-1');
    expect(res).toEqual({ authenticated: false, error: 'Forbidden', status: 403 });
  });
});

describe('authenticateAccountRequest()', () => {
  it('401s without a session', async () => {
    const res = await authenticateAccountRequest(reqWithCookie());
    expect(res).toEqual({ authenticated: false, error: 'Unauthorized', status: 401 });
  });

  it('authenticates a valid session without a per-resource check', async () => {
    mockVerifySession.mockResolvedValue({ user: { id: 'user-9' } });
    const res = await authenticateAccountRequest(reqWithCookie('lumitra_session=good'));
    expect(res).toEqual({ authenticated: true, userId: 'user-9' });
    expect(mockCan).not.toHaveBeenCalled();
  });
});
