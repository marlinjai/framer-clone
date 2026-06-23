/**
 * auth.ts -- the session-read shim for framer-clone, backed by auth-brain.
 *
 * Exposes a single `auth()` that reads the `lumitra_session` cookie and returns
 * `{ user: { id, email, name, image } } | null`. framer-clone owns no identity:
 * the session is verified against auth-brain, never against a local users table.
 *
 * This is the server-component / route-handler read path. The middleware
 * (src/middleware.ts) is the coarse edge gate that redirects unauthenticated
 * editor traffic to the auth-brain login; this helper is the fine read used
 * inside an already-gated request to get the current user.
 */

import { cookies } from 'next/headers';
import { authBrainClient } from './auth-brain';

export interface CompatSession {
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
  };
}

/**
 * Resolve the current session from the `lumitra_session` cookie. Returns null
 * when there is no cookie or the session is invalid/expired (the SDK maps a 401
 * and any timeout/5xx to null -- fail-closed).
 */
export async function auth(): Promise<CompatSession | null> {
  const jar = await cookies();
  const cookie = jar.get('lumitra_session')?.value;
  if (!cookie) return null;

  const session = await authBrainClient.verifySession(cookie);
  if (!session) return null;

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? null,
      image: session.user.picture ?? null,
    },
  };
}
