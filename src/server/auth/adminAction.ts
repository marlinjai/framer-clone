import 'server-only';

// src/server/auth/adminAction.ts
//
// Server-action flavor of the interim admin guard. The /api/cms WRITE routes
// guard mutations with `requireAdmin(req: Request)`; the CMS editing grid writes
// through server actions instead of routes, so those actions need the SAME
// contract without a Request object. `requireAdminAction()` reads the
// `admin_secret` cookie via next/headers and compares it to the same
// Infisical-injected secret (FRAMER_CLONE_ADMIN_SECRET) `requireAdmin` uses.
//
// It is secure-by-default and never silently passes: a missing, empty, or wrong
// secret THROWS, so the failure surfaces to the grid (a rejected action) rather
// than a silent no-op that looks like success.

import { cookies } from 'next/headers';
import { INTERIM_ADMIN_SECRET_ENV } from './guard';

/** The cookie the same-origin admin UI presents the interim secret through. */
const ADMIN_SECRET_COOKIE = 'admin_secret';

/**
 * Thrown when a CMS write server action is invoked without a valid admin secret.
 * Carries a typed `code` so callers can distinguish it from a data error.
 */
export class AdminActionForbiddenError extends Error {
  readonly code = 'forbidden';
  constructor(message = 'admin secret required or invalid') {
    super(message);
    this.name = 'AdminActionForbiddenError';
  }
}

/**
 * Guard a CMS write server action with the interim admin contract.
 *
 * Throws `AdminActionForbiddenError` on a missing/empty/wrong secret. A
 * misconfigured (unset/empty) expected secret matches NOTHING, so an absent env
 * value can never authorize a write.
 */
export async function requireAdminAction(): Promise<void> {
  const store = await cookies();
  const presented = store.get(ADMIN_SECRET_COOKIE)?.value ?? null;
  if (presented === null || presented.length === 0) {
    throw new AdminActionForbiddenError('admin secret required');
  }

  const expected = process.env[INTERIM_ADMIN_SECRET_ENV];
  if (expected === undefined || expected.length === 0 || presented !== expected) {
    throw new AdminActionForbiddenError('invalid admin secret');
  }
}

/**
 * Verify the interim admin secret from a `Request` object, returning a plain
 * boolean.
 *
 * This is the trust boundary for streaming API routes (the CMS content agent).
 * Unlike `requireAdminAction()`, it reads the cookie straight off the incoming
 * `Request` (NOT `next/headers`), so it is safe to call inside the synchronous
 * request phase BEFORE a detached async tool-use loop runs: `next/headers` is
 * not reliably in scope once the route has returned its `Response`. The route
 * calls this once, at the boundary, and passes the already-authorized adapter
 * into the loop so no cookie is read again mid-stream.
 *
 * Secure by default: a missing/empty/wrong secret, OR a misconfigured
 * (unset/empty) expected secret, returns `false`. It never throws and never
 * silently authorizes.
 */
export function verifyAdminCookie(req: Request): boolean {
  const cookieHeader = req.headers.get('cookie');
  if (cookieHeader === null) return false;

  let presented: string | null = null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === ADMIN_SECRET_COOKIE) {
      const value = part.slice(eq + 1).trim();
      if (value.length > 0) presented = value;
      break;
    }
  }
  if (presented === null) return false;

  const expected = process.env[INTERIM_ADMIN_SECRET_ENV];
  if (expected === undefined || expected.length === 0) return false;

  return presented === expected;
}
