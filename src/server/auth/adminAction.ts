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
