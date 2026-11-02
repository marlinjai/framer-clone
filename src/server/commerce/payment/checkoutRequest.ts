import 'server-only';

// src/server/commerce/payment/checkoutRequest.ts
//
// A hosted checkout's request, fixed by the first start (028_checkout_request; the money review of 2026-11-02,
// finding 5). Stripe answers a repeated idempotency key with the same session only when the request is the same, and
// refuses it otherwise. So the first Pay click on a Stripe order keeps what it sent (the buyer's email and the return
// address; the session's end follows from the payment window, stripe/connect.ts), and every later click sends exactly
// that. The buyer is fixed with it, by the database too (BK018): the session is made out to them, so the receipt is.
//
// fixCheckoutRequest writes the buyer and the request in one conditional update, so two clicks at once agree on one: the
// click that loses the race reads the winner's request and sends it.

import { z } from 'zod';
import type { Kysely } from 'kysely';

import { toJsonb } from '@/server/books/snapshots';

import type { CommerceDB } from '../db-types';
import { buyerSchema, readBuyer, type Buyer } from './buyer';

const checkoutRequestSchema = z
  .object({
    buyerEmail: z.string().min(1),
    returnUrl: z.string().url(),
  })
  .strict();

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** The stored request, or null before the first start. A stored value that does not parse is a fault, never ignored. */
export function readCheckoutRequest(stored: unknown): CheckoutRequest | null {
  if (stored === null || stored === undefined) return null;
  return checkoutRequestSchema.parse(stored);
}

/** Whether two buyers are the same for the invoice: compared after the schema's own normalisation. */
export function sameBuyer(a: Buyer, b: Buyer): boolean {
  const canonical = (buyer: Buyer) => {
    const parsed = buyerSchema.parse(buyer) as Record<string, unknown>;
    return JSON.stringify(Object.keys(parsed).sort().map((key) => [key, parsed[key] ?? null]));
  };
  return canonical(a) === canonical(b);
}

export type FixedCheckout =
  | { ok: true; request: CheckoutRequest; buyer: Buyer }
  /** A request is fixed for another buyer: this click may not change who the open session is made out to. */
  | { ok: false; reason: 'buyer_fixed' }
  /** The payment stopped waiting meanwhile (paid, closed): nothing is started. */
  | { ok: false; reason: 'not_pending' };

/**
 * The request this click sends: the stored one, or `candidate` fixed now together with `buyer`. A click that names
 * another buyer than the one a stored request was made for is refused, and the stored buyer stays.
 */
export async function fixCheckoutRequest(
  db: Kysely<CommerceDB>,
  companyId: string,
  orderId: string,
  buyer: Buyer,
  candidate: CheckoutRequest,
): Promise<FixedCheckout> {
  const fixed = await db
    .updateTable('order_payment')
    .set({ buyer: toJsonb(buyer), checkout_request: toJsonb(candidate), updated_at: new Date() })
    .where('tenant_id', '=', companyId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'pending')
    .where('checkout_request', 'is', null)
    .executeTakeFirst();
  if (fixed.numUpdatedRows > BigInt(0)) return { ok: true, request: candidate, buyer };

  const row = await db
    .selectFrom('order_payment')
    .select(['status', 'buyer', 'checkout_request'])
    .where('tenant_id', '=', companyId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
  const request = readCheckoutRequest(row.checkout_request);
  if (!request) return { ok: false, reason: 'not_pending' };
  const stored = readBuyer(row.buyer as Record<string, unknown>);
  if (!stored || !sameBuyer(stored, buyer)) return { ok: false, reason: 'buyer_fixed' };
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
  return { ok: true, request, buyer: stored };
}
