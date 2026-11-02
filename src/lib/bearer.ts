// src/lib/bearer.ts
//
// Whether a request carries a bearer credential, and the credential itself.
//
// Deliberately dependency free: the edge middleware imports it, and the edge
// runtime cannot load the auth-brain SDK or anything marked `server-only`
// (the same reason HOME_REWRITE_SENTINEL lives in its own module). The
// verification itself is in src/lib/auth-machine.ts.
//
// The rule both sides share: an `Authorization` header with the Bearer scheme
// claims the machine door, whatever follows it. Such a request is judged by
// the bearer alone and never falls back to the `lumitra_session` cookie that
// came along, so a present but wrong or empty bearer is a refusal, never a
// silent downgrade to the browser session.

type WithHeaders = { headers: Headers };

const BEARER_SCHEME = /^\s*bearer(?:\s|$)/i;

/** True when the request's Authorization header uses the Bearer scheme (with or without a token). */
export function carriesBearer(request: WithHeaders): boolean {
  return BEARER_SCHEME.test(request.headers.get('authorization') ?? '');
}

/**
 * The presented bearer token, trimmed, or null when the request carries no
 * bearer or an empty one. Never log the return value.
 */
export function presentedBearer(request: WithHeaders): string | null {
  const header = request.headers.get('authorization') ?? '';
  if (!BEARER_SCHEME.test(header)) return null;
  const token = header.trim().replace(/^bearer/i, '').trim();
  return token === '' ? null : token;
}
