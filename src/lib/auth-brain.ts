import { createAuthBrainClient } from '@marlinjai/auth-brain-sdk';

// The shared auth-brain SDK client for framer-clone (the consuming app).
//
// framer-clone models NO identity of its own: no users, memberships, or
// sessions tables. Identity, sessions, and the tenant_group -> tenant ->
// workspace membership graph all live in auth-brain. This module is the single
// point where the app talks to that brain.
//
// Build-time safety: this module is evaluated when `next build` collects page
// data for any route that imports it. The Docker build has no runtime env, so a
// hard throw on a missing AUTH_BRAIN_URL would break the build. We fall back to
// the public auth-brain host -- the same default the middleware uses -- so the
// build stays green. Prod injects AUTH_BRAIN_URL (and the OPENFGA_* vars) at
// runtime via Infisical; this default only governs build-time evaluation.
const authBrainUrl = process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co';

// An empty or whitespace-only value counts as unset: an empty Bearer token or
// model id must never be sent to OpenFGA.
function optionalEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export const authBrainClient = createAuthBrainClient({
  baseUrl: authBrainUrl,
  cookieName: 'lumitra_session',
  // 30s cache on session verify: the hot path for authenticated requests
  // (every guarded route). verifySession returns null only for a 401 and
  // THROWS on timeouts and non-OK statuses; callers go through
  // src/lib/authBrainAvailability.ts so an outage is never mistaken for a
  // signed-out user. can() returns false only for a real deny; it THROWS when
  // OpenFGA cannot answer, and src/lib/permissions.ts turns that throw into
  // AuthzUnavailableError (a 503 `authz_unavailable`, never a 403).
  cacheTtlMs: 30_000,
  openfgaUrl: process.env.OPENFGA_API_URL,
  openfgaStoreId: process.env.OPENFGA_STORE_ID,
  // The suite's OpenFGA runs with a pre-shared key: without this Bearer token
  // every check answers 401. Unset for a local OpenFGA that runs without a key
  // (src/instrumentation.ts warns at start when the URL is set but this is not).
  openfgaToken: optionalEnv('OPENFGA_API_TOKEN'),
  // Pins checks to one authorization model instead of the store's latest.
  openfgaModelId: optionalEnv('OPENFGA_AUTHORIZATION_MODEL_ID'),
});
