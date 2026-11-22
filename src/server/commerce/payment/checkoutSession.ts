import 'server-only';

// src/server/commerce/payment/checkoutSession.ts
//
// The hosted checkout session of a Stripe order, pinned once (docs/plans/2026-11-02-shop-backbone.md, section 2.1 and
// slice B7; migration 031_checkout_session).
//
// Stripe answers a repeated idempotency key with its first answer only for the very same request, refuses the key with
// any other parameter, and replays a create it answered with an error (all proven in the sandbox on 2026-11-23, section
// 2.5). So the session is handled in three steps, each safe to repeat:
//
//   1. Pin (pinCheckoutSession). Under the payment's row lock, once: a pending payment whose window is still open gets
//      its session's end (now plus 45 minutes, so a retry still clears Stripe's 30-minute floor), its return address and
//      its buyer fixed, and its hold moved to the session's end plus 5 minutes, so the stock is held while the session
//      can be paid. The database keeps all of it fixed from then on (BK018). A later click with another buyer is refused.
//   2. Create (openCheckoutSession, no stored id). Stripe is asked with the pinned values under `checkout:<orderId>`, so
//      every attempt sends the same bytes; the session id is stored after. An attempt whose answer was lost runs again
//      with the same request while the session's end is more than 31 minutes away; past that Stripe would refuse the
//      end, and a new key could open a second payable session, so the payment closes and the buyer starts again. A create
//      Stripe answered with an error closes it too: Stripe replays that refusal for the key's lifetime. Not so a rate
//      limit (429), a concurrent use of the key (409) or no answer at all, which Stripe did not store: the payment waits
//      and the buyer may try again. A key Stripe holds for other parameters (`idempotency_error`) means a session already
//      exists that this build did not make (a payment pending across the deploy of slice B7): it may still be paid, so
//      the payment is not closed, and its hold ends it (section 2.1, "Cutover"). When the build before confirmed that
//      session (`checkout_request`, 028, read only for this), Stripe is not asked at all, and its buyer stays fixed.
//   3. Read (openCheckoutSession with a stored id, and the expiry job through sessionAtExpiry). A session's state is
//      read only by retrieving it, never from a replayed create, which answers the first "open" even after the session
//      expired: open answers its page, complete applies the success under `session:<id>`, expired closes.

import { sql, type Kysely, type RawBuilder } from 'kysely';

import { toJsonb } from '@/server/books/snapshots';

import type { CommerceDB } from '../db-types';
import { readBuyer, sameBuyer, type Buyer } from './buyer';
import { handlePaymentEvent, UnknownPaymentError, type PaymentDeps, type PaymentOutcome, type PaymentStatus } from './payments';
import type { ProviderId } from './provider';
import { StripeApiError } from './stripe/client';

const MINUTE_MS = 60 * 1000;

/** How long a pinned session lives at Stripe, from the pin. */
export const SESSION_LIFETIME_MS = 45 * MINUTE_MS;
/** How long the hold outlasts the session, so Stripe's own end and its webhook come before ours. */
export const HOLD_GRACE_MS = 5 * MINUTE_MS;
/**
 * A create is sent only while the pinned end is more than this away: Stripe refuses an end under 30 minutes from its own
 * clock, plus a minute for the clocks.
 */
export const CREATE_MARGIN_MS = 31 * MINUTE_MS;
/** When the expiry job asks again about a session that is still open. */
export const SESSION_RECHECK_MS = 5 * MINUTE_MS;
/** How long past the hold the expiry job waits for Stripe to answer before it closes the payment anyway. */
export const STRIPE_WAIT_PAST_HOLD_MS = 60 * MINUTE_MS;

/** The event ids of the closes and successes decided here (payment_event records each once). */
export const SESSION_EVENT = {
  /** A complete session applied as the success, by a later click or the expiry job; a webhook has its own id. */
  success: (sessionId: string) => `session:${sessionId}`,
  expired: (sessionId: string) => `session-expired:${sessionId}`,
  unconfirmed: (orderId: string) => `session-unconfirmed:${orderId}`,
  refused: (orderId: string) => `session-refused:${orderId}`,
} as const;

/** `at` as the UTC timestamp the columns store, whatever the process's time zone. */
function utc(at: Date): RawBuilder<Date> {
  return sql<Date>`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** A stored timestamp as unix seconds, whole: what Stripe's `expires_at` takes. */
function epochSeconds(column: 'session_expires_at'): RawBuilder<number | null> {
  return sql<number | null>`floor(extract(epoch from ${sql.ref(column)}))::float8`;
}

export interface PinnedSession {
  /** The Checkout Session id once Stripe answered a create; null before. */
  sessionId: string | null;
  /** When the session ends, unix seconds, as Postgres stored it. */
  endsAt: number;
  returnUrl: string;
  /** Who the session is made out to. */
  buyer: Buyer;
  /**
   * The build before this one opened a session for the order under the same key (its confirmed `checkout_request`, 028)
   * that nothing here can read. Stripe refuses every pinned request under that key, so none is sent; the hold ends it.
   */
  earlierSession: boolean;
}

export type PinAnswer =
  | { ok: true; pin: PinnedSession }
  /** The session is pinned to other buyer details: this click changes nothing and starts nothing. */
  | { ok: false; reason: 'buyer_fixed' }
  /** The payment stopped waiting meanwhile (paid, closed). */
  | { ok: false; reason: 'not_pending' }
  /** The payment's window is over: no session opens for it, and its close follows. */
  | { ok: false; reason: 'window_over' };

/**
 * Pin the order's checkout session for `buyer` and `returnUrl`, or answer the pin it already has. Only a pending payment
 * whose window is open at `now` is pinned (the same check as a close by our clock, from the other side). `buyer` must
 * already be one the shop can invoice (invoiceable.ts): the pin fixes it.
 */
export async function pinCheckoutSession(
  db: Kysely<CommerceDB>,
  companyId: string,
  orderId: string,
  buyer: Buyer,
  returnUrl: string,
  now: Date,
): Promise<PinAnswer> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('order_payment')
      .select(['status', 'buyer', 'provider_session_id', 'session_return_url'])
      .select(sql<boolean>`coalesce((${sql.ref('checkout_request')} ->> 'confirmed')::boolean, false)`.as('earlierSession'))
      .select(epochSeconds('session_expires_at').as('endsAt'))
      .select(sql<boolean>`${sql.ref('expires_at')} > ${utc(now)}`.as('open'))
      .where('tenant_id', '=', companyId)
      .where('order_id', '=', orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new UnknownPaymentError(orderId);
    if (row.status !== 'pending') return { ok: false, reason: 'not_pending' };

    if (row.endsAt !== null) {
      const pinned = readBuyer(row.buyer as Record<string, unknown>);
      if (!pinned || !sameBuyer(pinned, buyer)) return { ok: false, reason: 'buyer_fixed' };
      if (!row.session_return_url) throw new Error(`the checkout session of order ${orderId} is pinned without its return address`);
      return {
        ok: true,
        pin: {
          sessionId: row.provider_session_id,
          endsAt: Number(row.endsAt),
          returnUrl: row.session_return_url,
          buyer: pinned,
          earlierSession: row.earlierSession,
        },
      };
    }
    if (!row.open) return { ok: false, reason: 'window_over' };

    // A payment pending across the deploy of slice B7 whose session the build before confirmed: that build fixed the buyer
    // already (028's trigger refuses a change), so another one is refused here as it was there, and the stored one is kept.
    let fixedBuyer = buyer;
    if (row.earlierSession) {
      const earlier = readBuyer(row.buyer as Record<string, unknown>);
      if (!earlier || !sameBuyer(earlier, buyer)) return { ok: false, reason: 'buyer_fixed' };
      fixedBuyer = earlier;
    }

    const pinned = await trx
      .updateTable('order_payment')
      .set({
        ...(row.earlierSession ? {} : { buyer: toJsonb(buyer) }),
        session_expires_at: sql<Date>`${utc(now)} + make_interval(secs => ${SESSION_LIFETIME_MS / 1000})`,
        session_return_url: returnUrl,
        expires_at: sql<Date>`${utc(now)} + make_interval(secs => ${(SESSION_LIFETIME_MS + HOLD_GRACE_MS) / 1000})`,
        updated_at: now,
      })
      .where('tenant_id', '=', companyId)
      .where('order_id', '=', orderId)
      .returning(epochSeconds('session_expires_at').as('endsAt'))
      .executeTakeFirstOrThrow();
    return { ok: true, pin: { sessionId: null, endsAt: Number(pinned.endsAt), returnUrl, buyer: fixedBuyer, earlierSession: row.earlierSession } };
  });
}

/** What a click on Pay ends in, once the session is pinned. */
export type CheckoutAnswer =
  | { kind: 'redirect'; url: string }
  /** The session was paid (its webhook may still be on the way): the success is applied. */
  | { kind: 'paid'; outcome: PaymentOutcome }
  /** The payment closed: the session expired, its answer was lost past the margin, or Stripe refused the create. */
  | { kind: 'closed'; status: PaymentStatus }
  /** The session is complete and its money still on the way (a slower method). */
  | { kind: 'processing' }
  /** Stripe did not answer, or asked to wait: nothing changed, and trying again is safe. */
  | { kind: 'unavailable' }
  /** Stripe holds the key for another request: a session this build did not make may still be open. */
  | { kind: 'key_conflict' };

/** The order's fixed figures, as the payment holds them. */
export interface CheckoutOrder {
  tenantId: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  currency: string;
  applicationFeeAmount: number;
}

async function storedSessionId(db: Kysely<CommerceDB>, tenantId: string, orderId: string): Promise<string | null> {
  const row = await db
    .selectFrom('order_payment')
    .select('provider_session_id')
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .executeTakeFirstOrThrow();
  return row.provider_session_id;
}

/** Close the payment for a reason decided here (not by our clock, so not `requireDue`: the hold may not be over yet). */
async function closeFor(
  deps: PaymentDeps,
  order: CheckoutOrder,
  type: 'checkout_expired' | 'checkout_cancelled',
  eventId: string,
  failureCode: string,
): Promise<CheckoutAnswer> {
  const outcome = await handlePaymentEvent(deps, {
    provider: 'stripe',
    eventId,
    type,
    tenantId: order.tenantId,
    orderId: order.orderId,
    failureCode: failureCode.slice(0, 100),
  });
  return { kind: 'closed', status: outcome.status };
}

/** Ask Stripe how the stored session stands and act on it. */
async function readSession(
  deps: PaymentDeps,
  order: CheckoutOrder,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<CheckoutAnswer> {
  const provider = deps.provider('stripe');
  if (!provider.retrieveSession) throw new Error('the Stripe provider cannot read a checkout session');
  let state: Awaited<ReturnType<NonNullable<typeof provider.retrieveSession>>>;
  try {
    state = await provider.retrieveSession(sessionId, signal);
  } catch (err) {
    // Stripe's answer or none: nothing changed and the click may be repeated. Anything else is a fault and surfaces.
    if (!(err instanceof StripeApiError)) throw err;
    const log = err.answered ? console.error : console.warn;
    log(`[payments] order ${order.orderId}: checkout session ${sessionId} could not be read from Stripe (${err.status} ${err.stripeCode ?? 'no code'})`);
    return { kind: 'unavailable' };
  }
  switch (state.status) {
    case 'open':
      if (!state.url) throw new Error(`Stripe answered no page for the open checkout session of order ${order.orderId}`);
      return { kind: 'redirect', url: state.url };
    case 'complete': {
      if (!state.paid) return { kind: 'processing' };
      const outcome = await applySessionSuccess(deps, order.tenantId, order.orderId, sessionId, state);
      return { kind: 'paid', outcome };
    }
    case 'expired':
      return closeFor(deps, order, 'checkout_expired', SESSION_EVENT.expired(sessionId), 'session_expired');
  }
}

/** A complete, paid session's success, under the session's own event id, with what Stripe says it charged. */
function applySessionSuccess(
  deps: PaymentDeps,
  tenantId: string,
  orderId: string,
  sessionId: string,
  state: { amount: number | null; currency: string | null; providerPaymentId: string | null },
): Promise<PaymentOutcome> {
  if (state.amount === null || state.currency === null || state.providerPaymentId === null) {
    throw new Error(`the paid checkout session of order ${orderId} carries no amount, currency or PaymentIntent`);
  }
  return handlePaymentEvent(deps, {
    provider: 'stripe',
    eventId: SESSION_EVENT.success(sessionId),
    type: 'payment_succeeded',
    tenantId,
    orderId,
    amount: state.amount,
    currency: state.currency,
    providerPaymentId: state.providerPaymentId,
  });
}

/**
 * The Pay click on a pinned Stripe order: read the stored session, or create it with the pinned values (see the top of
 * this file). Errors that are faults (a database failure, an answer that breaks the contract) are thrown.
 */
export async function openCheckoutSession(
  deps: PaymentDeps,
  order: CheckoutOrder,
  pin: PinnedSession,
  opts: { now: Date; signal?: AbortSignal },
): Promise<CheckoutAnswer> {
  if (pin.sessionId) return readSession(deps, order, pin.sessionId, opts.signal);
  // Its end differs from the pinned one, so Stripe would refuse the request; and closing at the margin would release the
  // stock while that session may still be paid. The buyer pays there, or the hold ends the payment (section 2.1, Cutover).
  if (pin.earlierSession) return { kind: 'key_conflict' };

  if (pin.endsAt * 1000 - opts.now.getTime() <= CREATE_MARGIN_MS) {
    // A concurrent click may have stored the session since this one read its pin: then it is read, not given up.
    const stored = await storedSessionId(deps.db, order.tenantId, order.orderId);
    if (stored) return readSession(deps, order, stored, opts.signal);
    console.warn(`[payments] order ${order.orderId}: its checkout session was never confirmed and the margin is over; closed`);
    return closeFor(deps, order, 'checkout_expired', SESSION_EVENT.unconfirmed(order.orderId), 'session_unconfirmed');
  }

  let started: Awaited<ReturnType<ReturnType<PaymentDeps['provider']>['start']>>;
  try {
    started = await deps.provider('stripe').start(
      {
        tenantId: order.tenantId,
        orderId: order.orderId,
        orderNumber: order.orderNumber,
        amount: order.amount,
        currency: order.currency,
        applicationFeeAmount: order.applicationFeeAmount,
        buyerEmail: pin.buyer.email,
        returnUrl: pin.returnUrl,
        sessionExpiresAt: pin.endsAt,
        signal: opts.signal,
      },
      async () => {},
    );
  } catch (err) {
    // Anything but Stripe's own answer, or a request it got none to, is a fault here: it surfaces as one.
    if (!(err instanceof StripeApiError)) throw err;
    if (!err.answered || err.status === 429 || err.status === 409) {
      console.warn(`[payments] order ${order.orderId}: Stripe gave no answer to the checkout session; the buyer may try again:`, err);
      return { kind: 'unavailable' };
    }
    if (err.stripeType === 'idempotency_error' || err.stripeCode === 'idempotency_error') {
      console.error(`[payments] order ${order.orderId}: Stripe holds its checkout key for another request; the payment waits for its hold`);
      return { kind: 'key_conflict' };
    }
    console.error(`[payments] order ${order.orderId}: Stripe refused the checkout session (${err.status} ${err.stripeCode ?? 'no code'}); closed`);
    return closeFor(deps, order, 'checkout_cancelled', SESSION_EVENT.refused(order.orderId), err.stripeCode ?? `stripe_${err.status}`);
  }
  if (!started.redirectUrl) throw new Error(`Stripe answered no checkout page for order ${order.orderId}`);

  const stored = await deps.db
    .updateTable('order_payment')
    .set({ provider_session_id: started.providerPaymentId, updated_at: opts.now })
    .where('tenant_id', '=', order.tenantId)
    .where('order_id', '=', order.orderId)
    .where('provider_session_id', 'is', null)
    .executeTakeFirst();
  if (stored.numUpdatedRows === BigInt(0)) {
    const earlier = await storedSessionId(deps.db, order.tenantId, order.orderId);
    if (earlier !== started.providerPaymentId) {
      throw new Error(`order ${order.orderId} holds checkout session ${earlier}, Stripe answered ${started.providerPaymentId}`);
    }
  }
  return { kind: 'redirect', url: started.redirectUrl };
}

/** What the expiry job does about a pinned session when the hold may be over (expiryJob.ts). */
export type ExpiryDecision =
  /** Close by our clock (`requireDue`), as without a session: nothing to ask, or Stripe says it is over. */
  | { kind: 'close' }
  /** Stripe took the money and the webhook did not arrive: the success is applied. */
  | { kind: 'paid'; outcome: PaymentOutcome }
  /** The session is still open: ask again then. */
  | { kind: 'recheck'; at: Date }
  /** Stripe did not answer: retry after `delayMs`, never later than the wait past the hold allows. */
  | { kind: 'retry'; delayMs: number };

/**
 * Before the expiry job closes a payment, a stored session is asked about (section 2.1, step 6): a hold ending with its
 * session could otherwise close a payment Stripe took whose webhook was lost. A payment that is not due, not pending or
 * without a stored session is not asked about: closing by our clock decides it as before.
 */
export async function sessionAtExpiry(
  deps: PaymentDeps,
  tenantId: string,
  orderId: string,
  signal: AbortSignal | undefined,
): Promise<ExpiryDecision> {
  const now = (deps.now ?? (() => new Date()))();
  const row = await deps.db
    .selectFrom('order_payment')
    .select(['status', 'provider', 'provider_session_id'])
    .select(sql<boolean>`${sql.ref('expires_at')} <= ${utc(now)}`.as('due'))
    .select(
      sql<number>`(extract(epoch from (${sql.ref('expires_at')} + make_interval(secs => ${STRIPE_WAIT_PAST_HOLD_MS / 1000})) - ${utc(now)}) * 1000)::float8`.as(
        'waitLeftMs',
      ),
    )
    .where('tenant_id', '=', tenantId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!row) throw new UnknownPaymentError(orderId);
  if (row.status !== 'pending' || !row.due || !row.provider_session_id) return { kind: 'close' };
  const provider = deps.provider(row.provider as ProviderId);
  if (!provider.retrieveSession) return { kind: 'close' };
  const sessionId = row.provider_session_id;
  const waitLeftMs = Number(row.waitLeftMs);

  let state: Awaited<ReturnType<NonNullable<typeof provider.retrieveSession>>>;
  try {
    state = await provider.retrieveSession(sessionId, signal);
  } catch (err) {
    // Whatever kept the answer away (Stripe down, the account gone, a fault), the hold must not depend on it for more
    // than the wait: it is logged as an error unless Stripe simply gave no answer, and the payment closes after the wait.
    if (!(err instanceof StripeApiError) || err.answered) {
      console.error(`[payments] order ${orderId}: checkout session ${sessionId} could not be read:`, err);
    }
    if (waitLeftMs <= 0) {
      console.error(`[payments] order ${orderId}: Stripe stayed unreachable an hour past the hold; closed without its word:`, err);
      return { kind: 'close' };
    }
    console.warn(`[payments] order ${orderId}: checkout session ${sessionId} could not be read from Stripe; asking again:`, err);
    return { kind: 'retry', delayMs: Math.min(SESSION_RECHECK_MS, waitLeftMs) };
  }
  switch (state.status) {
    case 'open':
      // The session ends before the hold, so an open one here means the clocks disagree: bounded by the same wait.
      if (waitLeftMs <= 0) return { kind: 'close' };
      return { kind: 'recheck', at: new Date(now.getTime() + Math.min(SESSION_RECHECK_MS, waitLeftMs)) };
    case 'complete':
      // Complete with the money still on the way (a slower method, section 2.4): the hold ends as it would without a
      // session, and a success that comes later takes the late path.
      if (!state.paid) return { kind: 'close' };
      return { kind: 'paid', outcome: await applySessionSuccess(deps, tenantId, orderId, sessionId, state) };
    case 'expired':
      return { kind: 'close' };
  }
}
