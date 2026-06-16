// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  INTERIM_ADMIN_SECRET_ENV,
  INTERIM_WORKSPACE_ID,
  can,
  getPrincipal,
  requireAdmin,
  type Principal,
} from '../guard';

// The guard reads the interim secret from process.env (Infisical-injected in
// production). Tests set it explicitly per-case and restore the prior value so
// no literal secret leaks into source and runs stay isolated.
const SECRET = 'test-interim-secret-value';

let previous: string | undefined;

beforeEach(() => {
  previous = process.env[INTERIM_ADMIN_SECRET_ENV];
  process.env[INTERIM_ADMIN_SECRET_ENV] = SECRET;
});

afterEach(() => {
  if (previous === undefined) delete process.env[INTERIM_ADMIN_SECRET_ENV];
  else process.env[INTERIM_ADMIN_SECRET_ENV] = previous;
});

function reqWithHeader(value: string): Request {
  return new Request('http://localhost/api/cms/page', {
    method: 'POST',
    headers: { 'x-admin-secret': value },
  });
}

function reqWithCookie(value: string): Request {
  return new Request('http://localhost/api/cms/page', {
    method: 'POST',
    headers: { cookie: `other=1; admin_secret=${value}; trailing=2` },
  });
}

function reqWithNothing(): Request {
  return new Request('http://localhost/api/cms/page', { method: 'POST' });
}

describe('requireAdmin', () => {
  it('correct secret -> { ok: true, principal } with isAdmin + constant workspace', () => {
    const result = requireAdmin(reqWithHeader(SECRET));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.isAdmin).toBe(true);
      expect(result.principal.workspaceId).toBe(INTERIM_WORKSPACE_ID);
      expect(typeof result.principal.userId).toBe('string');
    }
  });

  it('accepts the secret via cookie as well as header', () => {
    const result = requireAdmin(reqWithCookie(SECRET));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.principal.isAdmin).toBe(true);
      expect(result.principal.workspaceId).toBe(INTERIM_WORKSPACE_ID);
    }
  });

  it('missing secret -> 401 envelope (error surfaces, never swallowed)', async () => {
    const result = requireAdmin(reqWithNothing());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = (await result.response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('unauthorized');
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  });

  it('wrong secret -> 403 envelope (error surfaces, never swallowed)', async () => {
    const result = requireAdmin(reqWithHeader('not-the-secret'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = (await result.response.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe('forbidden');
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  });

  it('does NOT silently pass when the env secret is unset (misconfig -> 403)', () => {
    delete process.env[INTERIM_ADMIN_SECRET_ENV];
    const result = requireAdmin(reqWithHeader(SECRET));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});

describe('getPrincipal', () => {
  it('returns the admin principal for a correct secret', () => {
    const principal = getPrincipal(reqWithHeader(SECRET));
    expect(principal).not.toBeNull();
    expect(principal?.isAdmin).toBe(true);
    expect(principal?.workspaceId).toBe(INTERIM_WORKSPACE_ID);
  });

  it('returns null for a missing secret', () => {
    expect(getPrincipal(reqWithNothing())).toBeNull();
  });

  it('returns null for a wrong secret', () => {
    expect(getPrincipal(reqWithHeader('nope'))).toBeNull();
  });
});

describe('can() is auth-brain-shaped', () => {
  const admin: Principal = {
    userId: 'interim-admin',
    workspaceId: INTERIM_WORKSPACE_ID,
    isAdmin: true,
  };

  it('takes the (principal, action, resource) 3-arg signature', () => {
    // Matches the future auth.can(principal, action, resource) shape so the
    // later swap is an adapter change, not a rewrite.
    expect(can.length).toBe(3);
  });

  it('grants an admin every action on every resource', () => {
    expect(can(admin, 'create', 'cms.page')).toBe(true);
    expect(can(admin, 'delete', 'commerce.product')).toBe(true);
  });

  it('denies a non-admin principal', () => {
    expect(can({ ...admin, isAdmin: false }, 'create', 'cms.page')).toBe(false);
  });
});
