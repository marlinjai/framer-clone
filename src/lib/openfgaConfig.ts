// src/lib/openfgaConfig.ts
//
// Start-time sanity check for the OpenFGA (authorization server) wiring.
//
// The suite's OpenFGA runs with a pre-shared key: its health check answers 200
// to anyone, but every API call without `Authorization: Bearer <key>` gets a
// 401. With OPENFGA_API_URL set and OPENFGA_API_TOKEN missing, every permission
// check therefore fails, and the editor answers 503 `authz_unavailable` on every
// guarded route (seen in production on 2026-10-19 as "New project" failing).
//
// This only WARNS, it never fails the start: a local OpenFGA usually runs
// without a key, and there the token is legitimately absent. Only variable
// NAMES are logged, never a value.

type Env = Record<string, string | undefined>;

/** The warning text when OpenFGA is configured without its key, else null. */
export function openfgaTokenWarning(env: Env): string | null {
  const url = env.OPENFGA_API_URL?.trim();
  const token = env.OPENFGA_API_TOKEN?.trim();
  if (!url || token) return null;
  return (
    '[authz] OPENFGA_API_URL is set but OPENFGA_API_TOKEN is not. An OpenFGA ' +
    'running with a pre-shared key answers 401 to every permission check, so ' +
    'every guarded editor route will answer 503 authz_unavailable. Set ' +
    'OPENFGA_API_TOKEN (and OPENFGA_AUTHORIZATION_MODEL_ID), or ignore this ' +
    'warning for a local OpenFGA that runs without a key.'
  );
}

/** Log the warning once at start when it applies. Returns whether it logged. */
export function warnIfOpenfgaTokenMissing(
  env: Env = process.env,
  warn: (message: string) => void = console.warn,
): boolean {
  const message = openfgaTokenWarning(env);
  if (!message) return false;
  warn(message);
  return true;
}
