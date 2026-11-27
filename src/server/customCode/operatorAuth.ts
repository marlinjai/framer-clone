import 'server-only';

// src/server/customCode/operatorAuth.ts
//
// The gate of the custom code takedown route, POST /api/internal/custom-code/block (plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, "Abuse handling", and D116): editor host only (404
// elsewhere), and a bearer token equal to CUSTOM_CODE_OPERATOR_TOKEN compared in constant time (401
// otherwise). No token configured (or one shorter than 32 characters) answers 503
// custom_code_operator_not_configured: never an open endpoint.
//
// Its own token, not the host timers' CUSTOM_DOMAIN_SYNC_TOKEN: that one lives in systemd units on the shared
// server and is presented every few minutes, so whoever reads it there could otherwise take down any site's
// code or switch a site's custom code off. Only the comparison is shared (bearerMatches).

import { jsonError } from '@/lib/api/respond';
import { isEditorHost } from '@/lib/editorHost';
import { bearerMatches } from '@/server/domains/internalAuth';

export const CUSTOM_CODE_OPERATOR_TOKEN_ENV = 'CUSTOM_CODE_OPERATOR_TOKEN';
export const CUSTOM_CODE_OPERATOR_NOT_CONFIGURED = 'custom_code_operator_not_configured';
const MIN_OPERATOR_TOKEN_LENGTH = 32;
let warnedUnconfigured = false;

/** Null when the request may proceed, else the ready error response. */
export function checkCustomCodeOperatorRequest(req: Request): Response | null {
  if (!isEditorHost(req.headers.get('host'))) return jsonError('not_found', 'not found', 404);
  const expected = process.env[CUSTOM_CODE_OPERATOR_TOKEN_ENV]?.trim() ?? '';
  if (expected.length < MIN_OPERATOR_TOKEN_LENGTH) {
    // Once per process: the token is unset on purpose until custom code is switched on, and every probe of the
    // route would otherwise write the same line.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.error(`[custom code] ${CUSTOM_CODE_OPERATOR_TOKEN_ENV} is not set (or too short); the takedown route is off`);
    }
    return jsonError(CUSTOM_CODE_OPERATOR_NOT_CONFIGURED, 'the custom code takedown route is not configured', 503);
  }
  if (!bearerMatches(req, expected)) return jsonError('unauthorized', 'authentication required', 401);
  return null;
}
