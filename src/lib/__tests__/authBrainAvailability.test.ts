// @vitest-environment node
//
// src/lib/__tests__/authBrainAvailability.test.ts
//
// "Not signed in" versus "auth-brain could not answer": null and a 4xx cookie
// rejection are signed out; a network error, a 5xx, 408, 429 or an unreadable
// body is an outage (AuthUnavailableError), which routes turn into JSON 503.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AuthBrainError, AuthBrainNetworkError } from '@marlinjai/auth-brain-sdk';

const mockVerifySession = vi.fn();
vi.mock('../auth-brain', () => ({
  authBrainClient: { verifySession: (...a: unknown[]) => mockVerifySession(...a) },
}));

import {
  AuthUnavailableError,
  isAuthServiceFailure,
  verifySessionOrThrowUnavailable,
  withAuthAvailability,
} from '../authBrainAvailability';

beforeEach(() => vi.clearAllMocks());

describe('isAuthServiceFailure', () => {
  it.each([
    [new AuthBrainNetworkError(new Error('x')), true],
    [new AuthBrainError('x', 500), true],
    [new AuthBrainError('x', 503), true],
    [new AuthBrainError('x', 408), true],
    [new AuthBrainError('x', 429), true],
    [new AuthBrainError('x'), true],
    [new SyntaxError('bad json'), true],
    [new AuthBrainError('x', 400), false],
    [new AuthBrainError('x', 403), false],
  ])('%s -> %s', (err, expected) => {
    expect(isAuthServiceFailure(err)).toBe(expected);
  });
});

describe('verifySessionOrThrowUnavailable', () => {
  it('returns the session, or null for a 401', async () => {
    mockVerifySession.mockResolvedValueOnce({ user: { id: 'u' } });
    expect(await verifySessionOrThrowUnavailable('c')).toEqual({ user: { id: 'u' } });
    mockVerifySession.mockResolvedValueOnce(null);
    expect(await verifySessionOrThrowUnavailable('c')).toBeNull();
  });

  it('maps a 4xx cookie rejection to null (signed out)', async () => {
    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('x', 400));
    expect(await verifySessionOrThrowUnavailable('c')).toBeNull();
  });

  it('throws AuthUnavailableError for an outage', async () => {
    mockVerifySession.mockRejectedValueOnce(new AuthBrainError('x', 502));
    await expect(verifySessionOrThrowUnavailable('c')).rejects.toBeInstanceOf(AuthUnavailableError);
  });
});

describe('withAuthAvailability', () => {
  it('turns AuthUnavailableError into JSON 503 with Retry-After', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = withAuthAvailability(async () => {
      throw new AuthUnavailableError(new Error('down'));
    });
    const res = await handler();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect((await res.json()).error.code).toBe('auth_unavailable');
  });

  it('passes other errors and normal responses through', async () => {
    await expect(withAuthAvailability(async () => { throw new Error('boom'); })()).rejects.toThrow('boom');
    const ok = await withAuthAvailability(async () => new Response('ok'))();
    expect(await ok.text()).toBe('ok');
  });
});
