import 'server-only';

// src/server/commerce/payment/checkoutRequest.ts
//
// A hosted checkout's request (028_checkout_request; the money review of 2026-11-02, finding 5, and its second round,
// R2-3). Stripe answers a repeated idempotency key with the same session only for the same request, and refuses it
// otherwise. So a Pay click on a Stripe order sends the request the order already holds when there is one: the buyer's
// email and the return address (the session's end follows from the payment window, stripe/connect.ts).
//
// The request goes through two states:
//   - unconfirmed: written before Stripe is asked. Another click with the same buyer sends it as it is (another page
//     changes nothing), and a click with another buyer replaces it, because no session is made out to anyone yet: a
//     first click that failed at Stripe must not lock a typo in for good.
//   - confirmed: written once Stripe answered with a session. From then on it is set once and the buyer is fixed, by the
//     database too (BK018): the session is made out to them, and another buyer is refused with 409 buyer_fixed.
//
// One case stays open on purpose: Stripe made the session but its answer was lost, and the buyer then changed their
// details. Stripe refuses the new request under the same key and the route answers 500, as it did before; nothing is
// charged twice and no wrong invoice follows.

import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import { toJsonb } from '@/server/books/snapshots';

import type { CommerceDB } from '../db-types';
import { buyerSchema, readBuyer, type Buyer } from './buyer';

const checkoutRequestSchema = z
  .object({
    buyerEmail: z.string().min(1),
    returnUrl: z.string().url(),
    /** True once Stripe answered this request with a session. */
    confirmed: z.boolean(),
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

export type ChosenCheckout =
  | { ok: true; request: CheckoutRequest; buyer: Buyer }
  /** A session is confirmed for another buyer: this click may not change who it is made out to. */
  | { ok: false; reason: 'buyer_fixed' }
  /** The payment stopped waiting meanwhile (paid, closed): nothing is started. */
  | { ok: false; reason: 'not_pending' };

async function readRow(db: Kysely<CommerceDB>, companyId: string, orderId: string) {
  return db
    .selectFrom('order_payment')
    .select(['status', 'buyer', 'checkout_request'])
    .where('tenant_id', '=', companyId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
}

/**
 * The request this click sends to Stripe, written as unconfirmed with `buyer` unless the order already holds one for
 * the same buyer. `candidate` is this click's own email and return address.
 */
export async function chooseCheckoutRequest(
  db: Kysely<CommerceDB>,
  companyId: string,
  orderId: string,
  buyer: Buyer,
  candidate: Omit<CheckoutRequest, 'confirmed'>,
): Promise<ChosenCheckout> {
  const fresh: CheckoutRequest = { ...candidate, confirmed: false };
  // Two attempts: the first finds the row as it is; a concurrent click can change it once between the read and the
  // conditional write, and the second attempt reads that.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const row = await readRow(db, companyId, orderId);
    if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };
    const stored = readCheckoutRequest(row.checkout_request);
    const storedBuyer = readBuyer(row.buyer as Record<string, unknown>);
    if (stored && storedBuyer && sameBuyer(storedBuyer, buyer)) return { ok: true, request: stored, buyer: storedBuyer };
    if (stored?.confirmed) return { ok: false, reason: 'buyer_fixed' };

    // No request yet, or an unconfirmed one for another buyer: this click's, conditional on the row being as read.
    let write = db
      .updateTable('order_payment')
      .set({ buyer: toJsonb(buyer), checkout_request: toJsonb(fresh), updated_at: new Date() })
      .where('tenant_id', '=', companyId)
      .where('order_id', '=', orderId)
      .where('status', '=', 'pending');
    write = stored
      ? write
          .where(sql<boolean>`${sql.ref('checkout_request')} ->> 'buyerEmail' = ${stored.buyerEmail}`)
          .where(sql<boolean>`${sql.ref('checkout_request')} ->> 'returnUrl' = ${stored.returnUrl}`)
          .where(sql<boolean>`${sql.ref('checkout_request')} ->> 'confirmed' = 'false'`)
      : write.where('checkout_request', 'is', null);
    const written = await write.executeTakeFirst();
    if (written.numUpdatedRows > BigInt(0)) return { ok: true, request: fresh, buyer };
  }
  // Clicks racing each other with different buyers: let this one answer again rather than guess.
  throw new Error(`the hosted checkout request of order ${orderId} kept changing under concurrent clicks`);
}

/**
 * Stripe answered `request` with a session: it and `buyer` are what the session is made out to, so they are written as
 * confirmed, whatever an unconfirmed click wrote meanwhile. A request confirmed already stays as it is.
 */
export async function confirmCheckoutRequest(
  db: Kysely<CommerceDB>,
  companyId: string,
  orderId: string,
  buyer: Buyer,
  request: CheckoutRequest,
): Promise<void> {
  if (request.confirmed) return;
  await db
    .updateTable('order_payment')
    .set({ buyer: toJsonb(buyer), checkout_request: toJsonb({ ...request, confirmed: true }), updated_at: new Date() })
    .where('tenant_id', '=', companyId)
    .where('order_id', '=', orderId)
    .where('status', '=', 'pending')
    .where((eb) =>
      eb.or([
        eb('checkout_request', 'is', null),
        sql<boolean>`coalesce((${sql.ref('checkout_request')} ->> 'confirmed')::boolean, false) = false`,
      ]),
    )
    .execute();
}
