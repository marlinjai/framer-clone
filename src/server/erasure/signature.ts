// src/server/erasure/signature.ts
//
// The HMAC check of auth-brain's erasure webhook (plan docs/plans/2026-11-05-company-erasure-consumer.md).
// auth-brain signs `sha256=<hex>`, HMAC-SHA256 over the EXACT raw request body, and sends it in
// `x-lumitra-erasure-signature` beside `x-lumitra-erasure-event-id` (its sending side:
// packages/app/src/lib/erasure/webhook-signature.ts; the same scheme as the social-planner and receipt-ocr
// consumers). The body is verified as the bytes received, never re-serialized: auth-brain fixes the field
// order so the signature matches the transmitted bytes, and a re-serialization would break on any field it
// adds later. Neither the secret nor the signature is ever logged.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The shared secret's environment variable (Infisical, project framer-clone, env prod). */
export const ERASURE_SECRET_ENV = 'SITES_ERASURE_WEBHOOK_SECRET';

/** Header carrying auth-brain's HMAC over the raw delivery body. */
export const ERASURE_SIGNATURE_HEADER = 'x-lumitra-erasure-signature';

/** Header carrying the delivery's event id (the same value as the body's `event_id`). */
export const ERASURE_EVENT_ID_HEADER = 'x-lumitra-erasure-event-id';

const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

/** HMAC-SHA256 of `body` under `secret`, in the header's form (`sha256=<hex>`). */
export function signErasureBody(body: Uint8Array | string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * True only when `header` is `sha256=<64 hex>` and equals the HMAC of the raw `body` under `secret`.
 * A missing, malformed or wrong signature, or an empty secret, is false. The comparison runs in constant
 * time over equal-length digests.
 */
export function verifyErasureSignature(body: Uint8Array, header: string | null | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const match = SIGNATURE.exec(header.trim());
  if (!match) return false;
  const provided = Buffer.from(match[1].toLowerCase(), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
