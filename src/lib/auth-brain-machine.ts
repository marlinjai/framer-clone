import 'server-only';

import { createAuthBrainClient } from '@marlinjai/auth-brain-sdk';

// The auth-brain client the machine door (src/lib/auth-machine.ts) verifies
// company API keys with. Separate from the shared client in ./auth-brain on
// purpose:
//
//   - every request carries a deadline (AbortSignal.timeout): the SDK's own
//     fetch has none, so a hanging auth-brain would otherwise keep the socket
//     and the request open. An aborted fetch makes verifyApiKey throw
//     AuthBrainNetworkError, which the door answers as `unavailable` (503);
//   - no session cache and no OpenFGA settings: it only ever calls verifyApiKey.
//
// Same base URL and build-time fallback as ./auth-brain.

/** How long one verify request to auth-brain may take before it is aborted. */
export const MACHINE_VERIFY_FETCH_TIMEOUT_MS = 5_000;

/** fetch with a deadline; a caller's own signal still applies. */
export function fetchWithDeadline(timeoutMs: number, base?: typeof fetch): typeof fetch {
  return (input, init) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    // The global fetch is looked up per call, never captured at module load.
    return (base ?? globalThis.fetch)(input, { ...init, signal });
  };
}

export const machineAuthBrainClient = createAuthBrainClient({
  baseUrl: process.env.AUTH_BRAIN_URL ?? 'https://auth.lumitra.co',
  cookieName: 'lumitra_session',
  cacheTtlMs: 0,
  fetch: fetchWithDeadline(MACHINE_VERIFY_FETCH_TIMEOUT_MS),
});
