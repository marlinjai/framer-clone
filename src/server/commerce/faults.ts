import 'server-only';

// src/server/commerce/faults.ts
//
// The one way a commerce route answers a SERVER fault (a 500). The full error,
// with whatever internals it carries (connection strings, role names, hosts,
// SQL, ids), goes to the SERVER log only; the response carries a stable code
// and a generic, buyer-safe message. Anonymous storefront buyers (and editor
// users) therefore never see connection or schema details in a response body.

import { jsonError } from '@/lib/api/respond';

/**
 * Log `err` server-side under `where`, and return the 500 envelope with `code`
 * and the generic `publicMessage` (never `err.message`).
 */
export function commerceServerFault(
  code: string,
  publicMessage: string,
  where: string,
  err: unknown,
): Response {
  console.error(`[commerce] ${where} failed`, err);
  return jsonError(code, publicMessage, 500);
}
