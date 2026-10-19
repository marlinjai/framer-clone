// src/lib/authBrainAvailability.ts
//
// Tell "not signed in" apart from "auth-brain could not answer".
//
// The SDK's verifySession returns null ONLY for a 401 (no valid session). A
// timeout, a refused connection or a non-OK status THROWS (AuthBrainNetworkError
// / AuthBrainError). The editor used to catch that throw and treat it as "no
// session", which sent a signed-in user to the auth-brain login during an
// auth-brain outage: the same redirect loop as the missing-workspace bug, just
// triggered by the outage instead. Now:
//
//   - null                                  -> not signed in (login / 401),
//   - an AuthBrainError with a 4xx status
//     other than 408 / 429                  -> the cookie was rejected: not
//                                              signed in either (a malformed
//                                              cookie must not pin the user to
//                                              an error page forever),
//   - anything else (network error, 5xx,
//     408, 429, an unreadable body)         -> AuthUnavailableError: pages show
//                                              "auth service unavailable, retry",
//                                              API routes answer JSON 503
//                                              `auth_unavailable`. Never a
//                                              redirect, never a login.

import { AuthBrainError, type SessionVerifyResponse } from '@marlinjai/auth-brain-sdk';
import { authBrainClient } from './auth-brain';

/** auth-brain could not be asked whether the session is valid. */
export class AuthUnavailableError extends Error {
  readonly code = 'auth_unavailable' as const;
  constructor(readonly cause: unknown) {
    super('the sign-in service (auth-brain) is unavailable');
    this.name = 'AuthUnavailableError';
  }
}

/** True when a verifySession throw means "auth-brain could not answer". */
export function isAuthServiceFailure(err: unknown): boolean {
  if (err instanceof AuthBrainError && typeof err.status === 'number') {
    const s = err.status;
    if (s >= 400 && s < 500 && s !== 408 && s !== 429) return false;
  }
  return true;
}

/**
 * Verify a session cookie. Returns the session, or null when the user is not
 * signed in. THROWS AuthUnavailableError when auth-brain could not answer, so
 * no caller can mistake an outage for a signed-out user.
 */
export async function verifySessionOrThrowUnavailable(
  cookie: string,
): Promise<SessionVerifyResponse | null> {
  try {
    return await authBrainClient.verifySession(cookie);
  } catch (err) {
    if (isAuthServiceFailure(err)) throw new AuthUnavailableError(err);
    return null;
  }
}

/**
 * OpenFGA (the authorization server behind every permission check) could not
 * be asked whether the action is allowed: a network error, a 401 because the
 * pre-shared key is missing or wrong, a 5xx, a missing store configuration.
 *
 * This is NOT a deny. A real deny is OpenFGA answering `allowed: false`, which
 * stays a 403 Forbidden. Reporting an outage as "Forbidden" sent production on
 * a wrong trail on 2026-10-19 (the editor said "Forbidden" to admins while
 * OpenFGA was rejecting the unauthenticated check), so every caller maps this
 * to a 503 `authz_unavailable` instead. Still never a grant: the guarded action
 * does not run.
 */
export class AuthzUnavailableError extends Error {
  readonly code = 'authz_unavailable' as const;
  constructor(readonly cause: unknown) {
    super('the permission service (OpenFGA) is unavailable');
    this.name = 'AuthzUnavailableError';
  }
}

/** The JSON 503 every editor API route answers when OpenFGA cannot answer. */
export function authzUnavailableResponse(): Response {
  return Response.json(
    {
      error: {
        code: 'authz_unavailable',
        message: 'the permission service is temporarily unavailable, retry shortly',
      },
    },
    { status: 503, headers: { 'retry-after': '5' } },
  );
}

/** The JSON 503 every editor API route answers during an auth-brain outage. */
export function authUnavailableResponse(): Response {
  return Response.json(
    {
      error: {
        code: 'auth_unavailable',
        message: 'the sign-in service is temporarily unavailable, retry shortly',
      },
    },
    { status: 503, headers: { 'retry-after': '5' } },
  );
}

/**
 * Wrap a route handler so an AuthUnavailableError thrown anywhere in its
 * session handling, or an AuthzUnavailableError thrown by a permission check,
 * becomes the matching JSON 503 instead of an unhandled 500 (or, worse, a 403
 * that reads as a deny). Any other error is rethrown untouched.
 */
export function withAuthAvailability<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof AuthUnavailableError) {
        console.error('[auth] auth-brain unavailable during session verify', err.cause);
        return authUnavailableResponse();
      }
      if (err instanceof AuthzUnavailableError) {
        // The cause was already logged where the check failed (permissions.can).
        return authzUnavailableResponse();
      }
      throw err;
    }
  };
}
