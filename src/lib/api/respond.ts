// src/lib/api/respond.ts
//
// Shared HTTP response helpers for the src/app/api/* route handlers. The
// error envelope matches the precedent set by the AI route
// (src/app/api/ai/edit/route.ts, the bad_json / bad_body branches): every
// error is `{ error: { code, message, ...extra } }` with the matching HTTP
// status. New routes use these helpers instead of hand-rolling Response.json
// so the envelope stays uniform across the whole api surface.

import type { ZodType } from 'zod';

/**
 * Build the canonical error envelope `{ error: { code, message, ...extra } }`
 * with the given HTTP status. `extra` is spread into the error object for
 * route-specific detail (for example zod `issues`).
 */
export function jsonError(
  code: string,
  message: string,
  status: number,
  extra?: Record<string, unknown>,
): Response {
  return Response.json(
    { error: { code, message, ...(extra ?? {}) } },
    { status },
  );
}

/**
 * Parse and validate a JSON request body against a zod schema. Returns a
 * discriminated result: `{ ok: true, data }` on success, or
 * `{ ok: false, response }` carrying a ready-to-return 400 error envelope
 * (bad_json for unparseable bodies, bad_body for schema failures).
 */
export async function parseBody<T>(
  req: Request,
  schema: ZodType<T>,
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: jsonError('bad_json', 'invalid JSON body', 400),
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError('bad_body', 'invalid request body', 400, {
        issues: parsed.error.issues,
      }),
    };
  }

  return { ok: true, data: parsed.data };
}
