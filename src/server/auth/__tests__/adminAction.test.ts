// @vitest-environment node
//
// Unit tests for requireAdminAction: the server-action flavor of the interim
// admin guard the CMS editing grid's writes go through. It must be
// secure-by-default and throw (never silently pass) on a missing/empty/wrong
// secret, matching requireAdmin's contract but reading the cookie via
// next/headers instead of a Request.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const cookiesMock = vi.fn();
vi.mock('next/headers', () => ({ cookies: () => cookiesMock() }));

import { requireAdminAction, AdminActionForbiddenError } from '../adminAction';

const SECRET = 'test-admin-secret';

function withCookie(value: string | undefined) {
  cookiesMock.mockResolvedValue({
    get: (name: string) =>
      name === 'admin_secret' && value !== undefined ? { value } : undefined,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FRAMER_CLONE_ADMIN_SECRET = SECRET;
});

describe('requireAdminAction', () => {
  it('resolves when the presented cookie matches the configured secret', async () => {
    withCookie(SECRET);
    await expect(requireAdminAction()).resolves.toBeUndefined();
  });

  it('throws AdminActionForbiddenError when no admin_secret cookie is present', async () => {
    withCookie(undefined);
    const promise = requireAdminAction();
    await expect(promise).rejects.toBeInstanceOf(AdminActionForbiddenError);
    await expect(promise).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('throws on a present-but-wrong secret (distinct from the missing case at the route layer)', async () => {
    withCookie('nope');
    await expect(requireAdminAction()).rejects.toBeInstanceOf(AdminActionForbiddenError);
  });

  it('is secure by default: an unset/empty expected secret authorizes nothing', async () => {
    withCookie('anything');
    delete process.env.FRAMER_CLONE_ADMIN_SECRET;
    await expect(requireAdminAction()).rejects.toBeInstanceOf(AdminActionForbiddenError);

    process.env.FRAMER_CLONE_ADMIN_SECRET = '';
    await expect(requireAdminAction()).rejects.toBeInstanceOf(AdminActionForbiddenError);
  });
});
