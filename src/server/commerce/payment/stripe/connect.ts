import 'server-only';

// src/server/commerce/payment/stripe/connect.ts
//
// A company's Stripe account (Stripe Connect, direct charges; docs/plans/2026-10-25-catalogue-design.md,
// "Checkout, payment and receipt", items 2 and 3) and the Stripe payment provider built on it.
//
//   - Hosted onboarding: a new Standard account (a full-dashboard account the business owns; Stripe bills it
//     directly), then an Account Link to Stripe's own onboarding pages.
//   - Connecting an existing Stripe account: Stripe's OAuth (the platform's Connect client id), the state
//     bound to the company and checked on return.
//   - Readiness: `pending` until Stripe reports the account can take charges, then `ready`; asked of Stripe
//     on return from onboarding and whenever a payment starts on an account not ready yet.
//   - The provider: a Checkout Session as a direct charge on the company's account with the 1% platform fee
//     as `application_fee_amount`, expiring with the payment window; a full refund returns the fee too.
//
// UNPROVEN against Stripe itself (no Stripe account yet): every path is tested against a fake StripeApi.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';

import type { CommerceDB } from '../../db-types';
import type { PaymentProvider } from '../provider';
import type { StripeApi, StripeConfig } from './client';

/** Stripe's shortest Checkout Session lifetime (30 minutes), plus a minute for the clocks. */
const MIN_SESSION_MS = 31 * 60 * 1000;

export type AccountStatus = 'not_connected' | 'pending' | 'ready' | 'restricted';

export interface CompanyPaymentAccount {
  status: AccountStatus;
  accountId: string | null;
}

/** The company's Stripe account as stored. */
export async function readAccount(db: Kysely<CommerceDB>, tenantId: string): Promise<CompanyPaymentAccount> {
  const row = await db
    .selectFrom('payment_account')
    .select(['account_id', 'status'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', 'stripe')
    .executeTakeFirst();
  return row ? { status: row.status as AccountStatus, accountId: row.account_id } : { status: 'not_connected', accountId: null };
}

function statusFrom(flags: { charges_enabled: boolean }, previous: AccountStatus): AccountStatus {
  if (flags.charges_enabled) return 'ready';
  return previous === 'ready' || previous === 'restricted' ? 'restricted' : 'pending';
}

/** Ask Stripe how the company's account stands and store it. */
export async function refreshAccount(db: Kysely<CommerceDB>, api: StripeApi, tenantId: string): Promise<CompanyPaymentAccount> {
  const current = await readAccount(db, tenantId);
  if (!current.accountId) return current;
  const account = await api.retrieveAccount(current.accountId);
  const status = statusFrom(account, current.status);
  await db
    .updateTable('payment_account')
    .set({
      status,
      charges_enabled: account.charges_enabled,
      details_submitted: account.details_submitted,
      updated_at: new Date(),
    })
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', 'stripe')
    .execute();
  return { status, accountId: current.accountId };
}

async function storeAccount(db: Kysely<CommerceDB>, tenantId: string, accountId: string): Promise<void> {
  await db
    .insertInto('payment_account')
    .values({ tenant_id: tenantId, provider: 'stripe', account_id: accountId, updated_at: new Date() })
    .onConflict((oc) => oc.columns(['tenant_id', 'provider']).doNothing())
    .execute();
  const stored = await readAccount(db, tenantId);
  if (stored.accountId !== accountId) {
    // The company connected another account in the meantime: the stored one stands (the id is fixed, BK020).
    throw new Error(`company ${tenantId} is already connected to another Stripe account`);
  }
}

/**
 * Start (or resume) hosted onboarding: create the company's Standard account when it has none, then an
 * Account Link to Stripe's onboarding pages. Answers the URL to send the owner to.
 */
export async function startOnboarding(
  db: Kysely<CommerceDB>,
  api: StripeApi,
  args: { tenantId: string; email?: string; country: string; refreshUrl: string; returnUrl: string },
): Promise<{ url: string }> {
  let { accountId } = await readAccount(db, args.tenantId);
  if (!accountId) {
    const account = await api.createAccount({ email: args.email, country: args.country });
    await storeAccount(db, args.tenantId, account.id);
    accountId = account.id;
  }
  return api.createAccountLink({ accountId, refreshUrl: args.refreshUrl, returnUrl: args.returnUrl });
}

// --- connecting an existing account (OAuth) ---------------------------------------------------------------

/** The OAuth state: the company and an expiry, signed with the platform's secret so it cannot be forged. */
export function oauthState(config: StripeConfig, tenantId: string, nowMs = Date.now()): string {
  const payload = `${tenantId}.${nowMs + 15 * 60 * 1000}`;
  const sig = createHmac('sha256', config.secretKey).update(`stripe-oauth:${payload}`).digest('hex');
  return `${payload}.${sig}`;
}

/** The company a returned OAuth state names, or null for a forged, foreign or expired one. */
export function readOauthState(config: StripeConfig, state: string, nowMs = Date.now()): string | null {
  const parts = state.split('.');
  if (parts.length !== 3) return null;
  const [tenantId, expires, sig] = parts;
  const expected = createHmac('sha256', config.secretKey).update(`stripe-oauth:${tenantId}.${expires}`).digest('hex');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!(Number(expires) > nowMs)) return null;
  return tenantId;
}

export function oauthUrl(config: StripeConfig, state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.connectClientId,
    scope: 'read_write',
    state,
    redirect_uri: redirectUri,
  });
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

/** Finish OAuth: the code becomes the company's connected account. */
export async function completeOauth(
  db: Kysely<CommerceDB>,
  api: StripeApi,
  tenantId: string,
  code: string,
): Promise<CompanyPaymentAccount> {
  const { stripeUserId } = await api.oauthToken(code);
  await storeAccount(db, tenantId, stripeUserId);
  return refreshAccount(db, api, tenantId);
}

/** The company's account id, refreshed from Stripe when it is not ready yet; null when it cannot take charges. */
export async function chargeableAccount(db: Kysely<CommerceDB>, api: StripeApi, tenantId: string): Promise<string | null> {
  let account = await readAccount(db, tenantId);
  if (account.accountId && account.status !== 'ready') account = await refreshAccount(db, api, tenantId);
  return account.status === 'ready' ? account.accountId : null;
}

// --- the provider -------------------------------------------------------------------------------------------

/**
 * The Stripe payment provider for one company. `start` creates the hosted Checkout Session (the outcome
 * arrives later through the webhook, never through `emit`); `refund` refunds in full on the company's
 * account, the application fee included.
 */
export function stripeProvider(
  api: StripeApi,
  ctx: { db: Kysely<CommerceDB>; tenantId: string; tenantGroupId: string },
): PaymentProvider {
  return {
    id: 'stripe',
    async start(args) {
      const accountId = args.connectedAccountId ?? (await chargeableAccount(ctx.db, api, ctx.tenantId));
      if (!accountId) throw new Error(`company ${ctx.tenantId} has no Stripe account that can take payments`);
      if (!args.returnUrl) throw new Error('a hosted checkout needs a return address');
      const session = await api.createCheckoutSession({
        accountId,
        orderId: args.orderId,
        orderNumber: args.orderNumber,
        tenantGroupId: ctx.tenantGroupId,
        tenantId: ctx.tenantId,
        amount: args.amount,
        currency: args.currency,
        applicationFeeAmount: args.applicationFeeAmount,
        customerEmail: args.buyerEmail,
        successUrl: `${args.returnUrl}${args.returnUrl.includes('?') ? '&' : '?'}checkout=paid&order=${encodeURIComponent(args.orderId)}`,
        cancelUrl: `${args.returnUrl}${args.returnUrl.includes('?') ? '&' : '?'}checkout=cancelled&order=${encodeURIComponent(args.orderId)}`,
        // Stripe keeps a session open at least 30 minutes; one that outlives the payment window and is paid
        // late goes through the late-success path (the stock reserved again, or a full refund).
        expiresAt: Math.floor(Math.max(args.expiresAt?.getTime() ?? 0, Date.now() + MIN_SESSION_MS) / 1000),
        // One session per order: a retried start answers the same session.
        idempotencyKey: `checkout:${args.orderId}`,
      });
      return { providerPaymentId: session.id, redirectUrl: session.url };
    },
    async refund({ providerPaymentId, connectedAccountId }) {
      const accountId = connectedAccountId ?? (await readAccount(ctx.db, ctx.tenantId)).accountId;
      if (!accountId) throw new Error(`company ${ctx.tenantId} has no Stripe account to refund on`);
      const refund = await api.createRefund({ accountId, paymentIntentId: providerPaymentId, idempotencyKey: `refund:${providerPaymentId}` });
      return { refundId: refund.id };
    },
  };
}
