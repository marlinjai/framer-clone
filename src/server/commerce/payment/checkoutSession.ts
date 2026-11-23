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
//      expired: open answers its page, complete applies the success under `session:<id>`, expired closes, and a session
//      Stripe does not know on its pinned account (an answered 404) closes too.
//
// Two clicks can overlap, and a create can be in flight while another click (or an outdated order) closes the payment.
// So every close decided here re-reads the stored session under the payment's row lock and reads that session instead
// of closing (`requireNoSession`), and a session is stored only on a payment that is still pending: one Stripe answered
// after the payment closed is expired at Stripe at once, so the buyer is never sent to a page that could still take money
// for a closed order (the database refuses storing it too, BK018). A create is also sent only while the margin plus the
// click's own wait for Stripe remains, so an answer that comes back still lands before the margin.
//
// The session's account is pinned with it (`session_account_id`): it is read and expired where it was made, even after the
// company connected another account.

import { sql, type Kysely, type RawBuilder } from 'kysely';

import { toJsonb } from '@/server/books/snapshots';

import type { CommerceDB } from '../db-types';
import { readBuyer, sameBuyer, type Buyer } from './buyer';
import { handlePaymentEvent, UnknownPaymentError, type PaymentDeps, type PaymentOutcome, type PaymentStatus } from './payments';
import type { ProviderId, SessionRef } from './provider';
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
/** How long a click waits for Stripe before it answers that Stripe did not answer (the pay route's abort signal). */
export const STRIPE_CALL_TIMEOUT_MS = 20 * 1000;
/** When the expiry job asks again about a session that is still open. */
export const SESSION_RECHECK_MS = 5 * MINUTE_MS;
/**
 * How long a session made by the build before B7 lives past its payment window (that build's end: the window plus 31
 * minutes), so a payment pinned over one keeps its hold past it.
 */
const EARLIER_SESSION_MS = 31 * MINUTE_MS;
/** How long past the hold the expiry job waits for Stripe to answer before it closes the payment anyway. */
export const STRIPE_WAIT_PAST_HOLD_MS = 60 * MINUTE_MS;

/** The event ids of the closes and successes decided here (payment_event records each once). */
export const SESSION_EVENT = {
  /** A complete session applied as the success, by a later click or the expiry job; a webhook has its own id. */
  success: (sessionId: string) => `session:${sessionId}`,
  expired: (sessionId: string) => `session-expired:${sessionId}`,
  unconfirmed: (orderId: string) => `session-unconfirmed:${orderId}`,
  refused: (orderId: string) => `session-refused:${orderId}`,
  /** A stored session Stripe does not know on the pinned account (an answered 404). */
  missing: (sessionId: string) => `session-missing:${sessionId}`,
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
  /** The connected account the session is made on. */
  accountId: string;
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
  | { ok: false; reason: 'window_over' }
  /** The company has no account that can take payments: nothing is pinned, the order keeps waiting. */
  | { ok: false; reason: 'no_account' }
  /** Stripe did not answer about the account: nothing is pinned, and trying again is safe. */
  | { ok: false; reason: 'stripe_unavailable' };

/**
 * Pin the order's checkout session for `buyer` and `returnUrl`, or answer the pin it already has. Only a pending payment
 * whose window is open at `now` is pinned (the same check as a close by our clock, from the other side). `buyer` must
 * already be one the shop can invoice (invoiceable.ts): the pin fixes it. `account` names the account a new session is
 * made on; it is asked only when the payment is not pinned yet, and outside the row lock, since it may ask Stripe.
 */
export async function pinCheckoutSession(
  db: Kysely<CommerceDB>,
  companyId: string,
  orderId: string,
  buyer: Buyer,
  returnUrl: string,
  now: Date,
  account: () => Promise<string | null>,
): Promise<PinAnswer> {
  const before = await db
    .selectFrom('order_payment')
    .select(['status', 'session_account_id'])
    .where('tenant_id', '=', companyId)
    .where('order_id', '=', orderId)
    .executeTakeFirst();
  if (!before) throw new UnknownPaymentError(orderId);
  let accountId: string | null = before.session_account_id;
  if (accountId === null && before.status === 'pending') {
    try {
      accountId = await account();
    } catch (err) {
      if (!(err instanceof StripeApiError)) throw err;
      const log = err.answered ? console.error : console.warn;
      log(`[payments] order ${orderId}: the Stripe account could not be read before the pin (${err.status} ${err.stripeCode ?? 'no code'})`);
      return { ok: false, reason: 'stripe_unavailable' };
    }
  }

  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('order_payment')
      .select(['status', 'buyer', 'provider_session_id', 'session_return_url', 'session_account_id'])
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
      if (!row.session_return_url || !row.session_account_id) {
        throw new Error(`the checkout session of order ${orderId} is pinned without its return address or account`);
      }
      return {
        ok: true,
        pin: {
          sessionId: row.provider_session_id,
          endsAt: Number(row.endsAt),
          returnUrl: row.session_return_url,
          accountId: row.session_account_id,
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
    if (!accountId) return { ok: false, reason: 'no_account' };

    // The hold: past the pinned session's end. For a payment whose session the build before made, also past that session's
    // end (its payment window plus its 31 minutes, plus the grace), so the stock is not released while it can be paid.
    const hold = sql<Date>`${utc(now)} + make_interval(secs => ${(SESSION_LIFETIME_MS + HOLD_GRACE_MS) / 1000})`;
    const pinned = await trx
      .updateTable('order_payment')
      .set((eb) => ({
        ...(row.earlierSession ? {} : { buyer: toJsonb(buyer) }),
        session_expires_at: sql<Date>`${utc(now)} + make_interval(secs => ${SESSION_LIFETIME_MS / 1000})`,
        session_return_url: returnUrl,
        session_account_id: accountId,
        expires_at: row.earlierSession
          ? sql<Date>`greatest(${hold}, ${sql.ref('expires_at')} + make_interval(secs => ${(EARLIER_SESSION_MS + HOLD_GRACE_MS) / 1000}))`
          : hold,
        version: eb('version', '+', 1),
        updated_at: now,
      }))
      .where('tenant_id', '=', companyId)
      .where('order_id', '=', orderId)
      .returning(epochSeconds('session_expires_at').as('endsAt'))
      .executeTakeFirstOrThrow();
    return {
      ok: true,
      pin: { sessionId: null, endsAt: Number(pinned.endsAt), returnUrl, accountId, buyer: fixedBuyer, earlierSession: row.earlierSession },
    };
  });
}

/** What a click on Pay ends in, once the session is pinned. */
export type CheckoutAnswer =
  | { kind: 'redirect'; url: string }
  /** The session was paid (its webhook may still be on the way): the success is applied. */
  | { kind: 'paid'; outcome: PaymentOutcome }
  /**
   * The payment no longer waits: usually closed here (the session expired, its answer was lost past the margin, or Stripe
   * refused the create), but `status` says how it stands, which can be paid or refunded when something else got there first.
   */
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

/**
 * Close the payment for a reason decided here (not by our clock, so not `requireDue`: the hold may not be over yet).
 * `requireNoSession`: only while no session is stored, decided under the row lock; with one stored, that session is read
 * instead, on `account`.
 */
async function closeFor(
  deps: PaymentDeps,
  order: CheckoutOrder,
  close: { type: 'checkout_expired' | 'checkout_cancelled'; eventId: string; failureCode: string },
  opts: { requireNoSession?: { account: string; signal?: AbortSignal } } = {},
): Promise<CheckoutAnswer> {
  const outcome = await handlePaymentEvent(deps, {
    provider: 'stripe',
    eventId: close.eventId,
    type: close.type,
    tenantId: order.tenantId,
    orderId: order.orderId,
    failureCode: close.failureCode.slice(0, 100),
    ...(opts.requireNoSession ? { requireNoSession: true as const } : {}),
  });
  if (outcome.sessionStored && opts.requireNoSession) {
    const { account, signal } = opts.requireNoSession;
    return readSession(deps, order, { sessionId: outcome.sessionStored, accountId: account, signal });
  }
  return { kind: 'closed', status: outcome.status };
}

/** Ask Stripe how the stored session stands and act on it. */
async function readSession(deps: PaymentDeps, order: CheckoutOrder, ref: SessionRef): Promise<CheckoutAnswer> {
  const provider = deps.provider('stripe');
  if (!provider.retrieveSession) throw new Error('the Stripe provider cannot read a checkout session');
  let state: Awaited<ReturnType<NonNullable<typeof provider.retrieveSession>>>;
  try {
    state = await provider.retrieveSession(ref);
  } catch (err) {
    // Stripe's answer or none: nothing changed and the click may be repeated. Anything else is a fault and surfaces.
    if (!(err instanceof StripeApiError)) throw err;
    if (sessionMissing(err)) {
      // On the account it was made on, so it never existed there or is gone: nothing can pay it.
      console.error(`[payments] order ${order.orderId}: Stripe does not know checkout session ${ref.sessionId}; closed`);
      return closeFor(deps, order, { type: 'checkout_expired', eventId: SESSION_EVENT.missing(ref.sessionId), failureCode: 'session_missing' });
    }
    const log = err.answered ? console.error : console.warn;
    log(`[payments] order ${order.orderId}: checkout session ${ref.sessionId} could not be read from Stripe (${err.status} ${err.stripeCode ?? 'no code'})`);
    return { kind: 'unavailable' };
  }
  switch (state.status) {
    case 'open':
      if (!state.url) throw new Error(`Stripe answered no page for the open checkout session of order ${order.orderId}`);
      return { kind: 'redirect', url: state.url };
    case 'complete': {
      if (!state.paid) return { kind: 'processing' };
      const outcome = await applySessionSuccess(deps, order.tenantId, order.orderId, ref.sessionId, state);
      return { kind: 'paid', outcome };
    }
    case 'expired':
      return closeFor(deps, order, { type: 'checkout_expired', eventId: SESSION_EVENT.expired(ref.sessionId), failureCode: 'session_expired' });
  }
}

/** Stripe answered that it does not know the session (on the account it was asked on). */
function sessionMissing(err: StripeApiError): boolean {
  return err.answered && err.status === 404 && err.stripeCode === 'resource_missing';
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
 * The order's stored session, read on its pinned account: for a caller that found one where it meant to close (the pay
 * route's outdated order). Throws when none is stored.
 */
export async function readStoredSession(deps: PaymentDeps, order: CheckoutOrder, signal?: AbortSignal): Promise<CheckoutAnswer> {
  const row = await deps.db
    .selectFrom('order_payment')
    .select(['provider_session_id', 'session_account_id'])
    .where('tenant_id', '=', order.tenantId)
    .where('order_id', '=', order.orderId)
    .executeTakeFirstOrThrow();
  if (!row.provider_session_id || !row.session_account_id) throw new Error(`order ${order.orderId} has no stored checkout session to read`);
  return readSession(deps, order, { sessionId: row.provider_session_id, accountId: row.session_account_id, signal });
}

/** End a session Stripe made for a payment that closed meanwhile; best effort, and loud when it fails. */
async function expireOrphan(deps: PaymentDeps, order: CheckoutOrder, ref: SessionRef): Promise<void> {
  const provider = deps.provider('stripe');
  try {
    if (!provider.expireSession) throw new Error('the Stripe provider cannot expire a checkout session');
    await provider.expireSession(ref);
    console.warn(`[payments] order ${order.orderId}: checkout session ${ref.sessionId} came back after the payment closed; expired at Stripe`);
  } catch (err) {
    console.error(
      `[payments] order ${order.orderId}: checkout session ${ref.sessionId} came back after the payment closed and could NOT be expired at Stripe; ` +
        'it stays payable until its own end, and a payment there takes the late path:',
      err,
    );
  }
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
  const account = pin.accountId;
  if (pin.sessionId) return readSession(deps, order, { sessionId: pin.sessionId, accountId: account, signal: opts.signal });
  // Its end differs from the pinned one, so Stripe would refuse the request; and closing at the margin would release the
  // stock while that session may still be paid. The buyer pays there, or the hold ends the payment (section 2.1, Cutover).
  if (pin.earlierSession) return { kind: 'key_conflict' };

  const onlyWithoutSession = { requireNoSession: { account, signal: opts.signal } };
  // The margin plus this click's own wait: an answer that comes back is stored before any other click may close.
  if (pin.endsAt * 1000 - opts.now.getTime() <= CREATE_MARGIN_MS + STRIPE_CALL_TIMEOUT_MS) {
    console.warn(`[payments] order ${order.orderId}: its checkout session was never confirmed and the margin is over; closing`);
    return closeFor(
      deps,
      order,
      { type: 'checkout_expired', eventId: SESSION_EVENT.unconfirmed(order.orderId), failureCode: 'session_unconfirmed' },
      onlyWithoutSession,
    );
  }

  const provider = deps.provider('stripe');
  let started: Awaited<ReturnType<typeof provider.start>>;
  try {
    // Only the create is in here: the account is pinned, so start asks Stripe nothing else.
    started = await provider.start(
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
        connectedAccountId: account,
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
    console.error(`[payments] order ${order.orderId}: Stripe refused the checkout session (${err.status} ${err.stripeCode ?? 'no code'}); closing`);
    return closeFor(
      deps,
      order,
      { type: 'checkout_cancelled', eventId: SESSION_EVENT.refused(order.orderId), failureCode: err.stripeCode ?? `stripe_${err.status}` },
      onlyWithoutSession,
    );
  }
  if (!started.redirectUrl) throw new Error(`Stripe answered no checkout page for order ${order.orderId}`);
  const sessionId = started.providerPaymentId;

  // Stored only on a payment still pending: a close may have landed while the create was in flight.
  const stored = await deps.db
    .updateTable('order_payment')
    .set((eb) => ({ provider_session_id: sessionId, version: eb('version', '+', 1), updated_at: opts.now }))
    .where('tenant_id', '=', order.tenantId)
    .where('order_id', '=', order.orderId)
    .where('status', '=', 'pending')
    .where('provider_session_id', 'is', null)
    .executeTakeFirst();
  if (stored.numUpdatedRows > BigInt(0)) return { kind: 'redirect', url: started.redirectUrl };

  const now = await deps.db
    .selectFrom('order_payment')
    .select(['status', 'provider_session_id'])
    .where('tenant_id', '=', order.tenantId)
    .where('order_id', '=', order.orderId)
    .executeTakeFirstOrThrow();
  // A concurrent click stored the same session (the same request under the same key): its page is this one.
  if (now.provider_session_id === sessionId && now.status === 'pending') return { kind: 'redirect', url: started.redirectUrl };
  if (now.provider_session_id !== null && now.provider_session_id !== sessionId) {
    throw new Error(`order ${order.orderId} holds checkout session ${now.provider_session_id}, Stripe answered ${sessionId}`);
  }
  const status = now.status as PaymentStatus;
  // The payment closed while Stripe was making the session: it must not stay payable. A paid payment was paid through
  // this very session (no other can exist under the key), so there is nothing to end.
  if (status !== 'paid' && status !== 'refunded') await expireOrphan(deps, order, { sessionId, accountId: account, signal: opts.signal });
  return { kind: 'closed', status };
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
    .select(['status', 'provider', 'provider_session_id', 'session_account_id'])
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
  if (!row.session_account_id) throw new Error(`the checkout session of order ${orderId} is stored without its account`);
  const waitLeftMs = Number(row.waitLeftMs);

  let state: Awaited<ReturnType<NonNullable<typeof provider.retrieveSession>>>;
  try {
    state = await provider.retrieveSession({ sessionId, accountId: row.session_account_id, signal });
  } catch (err) {
    // Not on the account it was made on: nothing can pay it, so the hold ends as without a session.
    if (err instanceof StripeApiError && sessionMissing(err)) {
      console.error(`[payments] order ${orderId}: Stripe does not know checkout session ${sessionId}; closed`);
      return { kind: 'close' };
    }
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
