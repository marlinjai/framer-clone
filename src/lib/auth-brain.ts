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

export const authBrainClient = createAuthBrainClient({
  baseUrl: authBrainUrl,
  cookieName: 'lumitra_session',
  // 30s cache on session verify: the hot path for authenticated requests
  // (middleware + every guarded route). The SDK maps timeouts and 5xx to null
  // on verifySession (fail-closed) and throws on can() errors (also treated as
  // a deny by every caller in this codebase).
  cacheTtlMs: 30_000,
  openfgaUrl: process.env.OPENFGA_API_URL,
  openfgaStoreId: process.env.OPENFGA_STORE_ID,
});
