import 'server-only';

// src/server/domains/http.ts
//
// Shared response plumbing for the custom-domain routes: the "not configured"
// answer and the mapping of a thrown error to the `{ error: { code, message } }`
// envelope. A DomainError carries its own code and status; anything else is a
// logged 500 whose message names no internals.

import { jsonError } from '@/lib/api/respond';
import { readCustomDomainConfig, type CustomDomainConfig } from './config';
import { DomainError } from './service';

export const CUSTOM_DOMAINS_NOT_CONFIGURED = 'custom_domains_not_configured';

/** The platform config, or the ready 503 when custom domains are not set up. */
export function requireCustomDomainConfig():
  | { ok: true; config: CustomDomainConfig }
  | { ok: false; response: Response } {
  const result = readCustomDomainConfig();
  if (result.configured) return { ok: true, config: result.config };
  console.error(`[domains] custom domains are not configured: ${result.reason}`);
  return {
    ok: false,
    response: jsonError(
      CUSTOM_DOMAINS_NOT_CONFIGURED,
      'Custom domains are not set up on this server yet.',
      503,
    ),
  };
}

export function domainErrorResponse(err: unknown, action: string): Response {
  if (err instanceof DomainError) return jsonError(err.code, err.message, err.status);
  console.error(`[domains] ${action} failed:`, err);
  return jsonError('domain_request_failed', `Could not ${action}. Try again.`, 500);
}
