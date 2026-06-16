import 'server-only';

// src/server/auth/guard.ts
//
// The interim admin authorization seam for framer-clone. framer-clone has NO
// auth today, so v1 ships a SINGLE hard-coded admin principal gated by a shared
// secret (Infisical-injected, never a literal in source). Only mutation routes
// call requireAdmin(req); read routes (storefront, binding preview) stay
// UNAUTHENTICATED for v1 and do NOT import this module.
//
// The can(principal, action, resource) signature is deliberately shaped like
// the future auth-brain auth.can(...) so the later swap is an ADAPTER change,
// not a rewrite. Real auth-brain integration (P2 / E7), end-user auth /
// app_users (P6), and multi-workspace resolution (E7) are all out of scope:
// one constant workspace/tenant for v1.
//
// Errors surface, never swallowed: a missing secret yields a 401 envelope and
// a wrong secret yields a 403 envelope (the Track-0 jsonError shape). It never
// silently passes.

import { jsonError } from '@/lib/api/respond';

/**
 * The single constant workspace/tenant for v1. Multi-workspace resolution is
 * deferred (E7); every authorized request resolves to this one workspace.
 */
export const INTERIM_WORKSPACE_ID = 'ws_interim_default';

/**
 * The name of the env var (Infisical-injected) that holds the interim admin
 * shared secret. The Worker writes this READ; Marlin sets the VALUE in
 * Infisical (split-responsibility). The secret VALUE is NEVER a literal in
 * source and is NEVER written to a `.env` file.
 *
 * OPEN QUESTION (for Marlin): confirm this is the correct framer-clone
 * Infisical secret NAME before the manual route-guard test.
 */
export const INTERIM_ADMIN_SECRET_ENV = 'FRAMER_CLONE_ADMIN_SECRET';

/**
 * The HTTP header a client presents the interim admin secret through.
 */
const ADMIN_SECRET_HEADER = 'x-admin-secret';

/**
 * The cookie name the interim admin secret may alternatively be presented
 * through (for the same-origin admin UI).
 */
const ADMIN_SECRET_COOKIE = 'admin_secret';

/**
 * A principal is the actor a route authorizes against. Shaped to match the
 * future auth-brain principal so downstream `can()` calls do not change when
 * the real brain lands.
 */
export interface Principal {
  userId: string;
  workspaceId: string;
  isAdmin: boolean;
}

/**
 * The one hard-coded admin principal for v1. A correct interim secret resolves
 * to exactly this principal: isAdmin true, in the one constant workspace.
 */
const ADMIN_PRINCIPAL: Principal = {
  userId: 'interim-admin',
  workspaceId: INTERIM_WORKSPACE_ID,
  isAdmin: true,
};

/**
 * The authorization decision seam, shaped like the future auth-brain
 * `auth.can(principal, action, resource)`. v1 policy: the hard-coded admin may
 * perform every action on every resource. The (action, resource) arguments are
 * part of the signature so the later swap is an adapter change, not a rewrite;
 * a request for an empty action or resource is never granted.
 */
export function can(
  principal: Principal,
  action: string,
  resource: string,
): boolean {
  if (action.length === 0 || resource.length === 0) return false;
  return principal.isAdmin;
}

/**
 * Extract the secret a client presented, from the header first then the cookie.
 * Returns null when NO secret was presented at all (the 401 / missing case),
 * distinct from a presented-but-wrong secret (the 403 case).
 */
function readPresentedSecret(req: Request): string | null {
  const header = req.headers.get(ADMIN_SECRET_HEADER);
  if (header !== null && header.length > 0) return header;

  const cookieHeader = req.headers.get('cookie');
  if (cookieHeader !== null) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (name === ADMIN_SECRET_COOKIE) {
        const value = part.slice(eq + 1).trim();
        if (value.length > 0) return value;
      }
    }
  }

  return null;
}

/**
 * Resolve the principal for a request from its interim secret. Returns the
 * hard-coded admin principal when a presented secret matches the env-injected
 * value, otherwise null. Reads-only callers can use this; mutation routes use
 * requireAdmin(req), which distinguishes the missing (401) from the wrong (403)
 * case.
 */
export function getPrincipal(req: Request): Principal | null {
  const presented = readPresentedSecret(req);
  if (presented === null) return null;

  const expected = process.env[INTERIM_ADMIN_SECRET_ENV];
  // A misconfigured (unset/empty) expected secret matches NOTHING: secure by
  // default, so an absent env value can never authorize a request.
  if (expected === undefined || expected.length === 0) return null;

  return presented === expected ? ADMIN_PRINCIPAL : null;
}

/**
 * Guard a mutation route. Returns the discriminated Track-0 result:
 *   - correct secret -> { ok: true, principal } with isAdmin true + constant ws
 *   - missing secret -> { ok: false, response } carrying a 401 envelope
 *   - wrong secret   -> { ok: false, response } carrying a 403 envelope
 * The error responses are real and returned to the caller: the guard never
 * silently passes on a bad or absent secret.
 */
export function requireAdmin(
  req: Request,
):
  | { ok: true; principal: Principal }
  | { ok: false; response: Response } {
  const presented = readPresentedSecret(req);
  if (presented === null) {
    return {
      ok: false,
      response: jsonError('unauthorized', 'admin secret required', 401),
    };
  }

  const expected = process.env[INTERIM_ADMIN_SECRET_ENV];
  if (expected === undefined || expected.length === 0 || presented !== expected) {
    return {
      ok: false,
      response: jsonError('forbidden', 'invalid admin secret', 403),
    };
  }

  return { ok: true, principal: ADMIN_PRINCIPAL };
}
