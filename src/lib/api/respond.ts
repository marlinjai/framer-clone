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
  options: { maxBytes?: number } = {},
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  if (options.maxBytes !== undefined) {
    const text = await readBodyText(req, options.maxBytes);
    if (!text.ok) return text;
    try {
      raw = JSON.parse(text.text);
    } catch {
      return { ok: false, response: jsonError('bad_json', 'invalid JSON body', 400) };
    }
    return validate(raw, schema);
  }
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: jsonError('bad_json', 'invalid JSON body', 400),
    };
  }

  return validate(raw, schema);
}

function validate<T>(
  raw: unknown,
  schema: ZodType<T>,
): { ok: true; data: T } | { ok: false; response: Response } {
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

/**
 * The upper bound for a project write (a whole editor snapshot): far above
 * any real project, low enough that a hostile body cannot tie up the server
 * parsing and validating it.
 */
export const PROJECT_BODY_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Read a request body as text, refusing (413 `body_too_large`) once it is
 * larger than `maxBytes`: checked against the declared length first, then
 * while streaming, so an undeclared or lying length cannot get past it.
 */
export async function readBodyText(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
  const tooLarge = () => ({
    ok: false as const,
    response: jsonError('body_too_large', `the request body is larger than ${maxBytes} bytes`, 413),
  });
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge();
  if (!req.body) return { ok: true, text: '' };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(all) };
}
