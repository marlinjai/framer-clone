import 'server-only';

// src/server/domains/internalAuth.ts
//
// The gate for the internal endpoints the host-side timers on the shared
// server call (the custom-domain hostname feed and re-check, the expired payment
// sweep and the commerce job watchdog): editor host only (404 elsewhere), and a bearer token equal to
// CUSTOM_DOMAIN_SYNC_TOKEN compared in constant time (401 otherwise). No token
// configured (or one shorter than 32 characters) means 503
// custom_domains_not_configured: never an open endpoint. These routes sit
// outside the middleware matcher on purpose: they carry no session.

import { createHash, timingSafeEqual } from 'node:crypto';
import { jsonError } from '@/lib/api/respond';
import { isEditorHost } from '@/lib/editorHost';
import { CUSTOM_DOMAINS_NOT_CONFIGURED } from './http';

const MIN_SYNC_TOKEN_LENGTH = 32;

function tokenMatches(presented: string, expected: string): boolean {
  // Hash both sides so the comparison is constant time and length-blind.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * True when the request carries `Authorization: Bearer <expected>`, compared in constant time. The core every
 * bearer-gated internal route shares; each route keeps its own token, so one leaked caller's token opens only
 * that caller's routes (the custom code takedown route uses it with its own, src/server/customCode/operatorAuth.ts).
 */
export function bearerMatches(req: Request, expected: string): boolean {
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  return presented.length > 0 && tokenMatches(presented, expected);
}

/** Null when the request may proceed, else the ready error response. */
export function checkInternalRequest(req: Request): Response | null {
  if (!isEditorHost(req.headers.get('host'))) {
    return jsonError('not_found', 'not found', 404);
  }
  const expected = process.env.CUSTOM_DOMAIN_SYNC_TOKEN?.trim() ?? '';
  if (expected.length < MIN_SYNC_TOKEN_LENGTH) {
    console.error('[domains] CUSTOM_DOMAIN_SYNC_TOKEN is not set (or too short); the internal endpoints are off');
    return jsonError(CUSTOM_DOMAINS_NOT_CONFIGURED, 'the custom-domain feed is not configured', 503);
  }
  if (!bearerMatches(req, expected)) {
    return jsonError('unauthorized', 'authentication required', 401);
  }
  return null;
}
// ci-replay touch
