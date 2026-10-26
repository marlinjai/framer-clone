import 'server-only';

// src/server/commerce/payment/stripe/client.ts
//
// The slice of Stripe's API the platform uses, behind an interface so every test runs against a fake
// (docs/plans/2026-10-25-catalogue-design.md, slice 5). Plain HTTPS with form-encoded bodies, as Stripe's API
// takes them; no SDK. Direct charges: every call about a company's money carries its connected account in
// the `Stripe-Account` header, so the charge, the refund and the fee are on the company's own account.
//
// UNPROVEN against Stripe itself: no Stripe account exists yet (checked 2026-10-26); the keys in Infisical are
// placeholders. Configuration with placeholders or unset keys reads as "Stripe not configured" and the shop
// keeps the demo provider.

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** The platform's Connect client id (for connecting an existing Stripe account through OAuth). */
  connectClientId: string;
}

const PLACEHOLDER = 'PLACEHOLDER_REPLACE_ME';

/** The Stripe configuration, or null while it is missing or still the placeholders. */
export function stripeConfig(env: Record<string, string | undefined> = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  const connectClientId = env.STRIPE_CONNECT_CLIENT_ID;
  const real = (v: string | undefined): v is string => typeof v === 'string' && v.trim() !== '' && v !== PLACEHOLDER;
  if (!real(secretKey) || !real(webhookSecret) || !real(connectClientId)) return null;
  return { secretKey, webhookSecret, connectClientId };
}

export interface StripeAccount {
  id: string;
  charges_enabled: boolean;
  details_submitted: boolean;
}

export interface StripeCheckoutSession {
  id: string;
  url: string;
}

/** What the platform asks of Stripe. */
export interface StripeApi {
  createAccount(args: { email?: string; country: string }): Promise<StripeAccount>;
  retrieveAccount(accountId: string): Promise<StripeAccount>;
  createAccountLink(args: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;
  /** Exchange an OAuth code for the connected account id (connecting an existing account). */
  oauthToken(code: string): Promise<{ stripeUserId: string }>;
  createCheckoutSession(args: {
    accountId: string;
    orderId: string;
    orderNumber: string;
    tenantGroupId: string;
    tenantId: string;
    amount: number;
    currency: string;
    applicationFeeAmount: number;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    /** Unix seconds; Stripe expires the session then (checkout.session.expired). */
    expiresAt: number;
    idempotencyKey: string;
  }): Promise<StripeCheckoutSession>;
  createRefund(args: { accountId: string; paymentIntentId: string; idempotencyKey: string }): Promise<{ id: string }>;
}

/** A Stripe API error, with Stripe's own code when it sent one (never the request body). */
export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly stripeCode: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

/** Flatten an object into Stripe's form encoding (`a[b][c]=v`). */
export function formEncode(params: Record<string, unknown>, prefix = ''): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object' && item !== null) parts.push(...formEncode(item as Record<string, unknown>, `${name}[${i}]`));
        else parts.push(`${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === 'object') {
      parts.push(...formEncode(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

/** The HTTPS client. `fetchImpl` is injectable for its own unit test. */
export function httpStripeApi(config: StripeConfig, fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a)): StripeApi {
  async function call<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { params?: Record<string, unknown>; account?: string; idempotencyKey?: string; base?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${config.secretKey}` };
    if (opts.account) headers['stripe-account'] = opts.account;
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    let body: string | undefined;
    if (method === 'POST') {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = formEncode(opts.params ?? {}).join('&');
    }
    const res = await fetchImpl(`${opts.base ?? 'https://api.stripe.com'}${path}`, { method, headers, body });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; type?: string } };
    if (!res.ok) {
      throw new StripeApiError(res.status, json.error?.code ?? json.error?.type ?? null, json.error?.message ?? `Stripe answered ${res.status}`);
    }
    return json as T;
  }

  return {
    createAccount: ({ email, country }) =>
      call<StripeAccount>('POST', '/v1/accounts', { params: { type: 'standard', email, country } }),
    retrieveAccount: (accountId) => call<StripeAccount>('GET', `/v1/accounts/${encodeURIComponent(accountId)}`),
    createAccountLink: ({ accountId, refreshUrl, returnUrl }) =>
      call<{ url: string }>('POST', '/v1/account_links', {
        params: { account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding' },
      }),
    oauthToken: async (code) => {
      const token = await call<{ stripe_user_id: string }>('POST', '/oauth/token', {
        params: { grant_type: 'authorization_code', code },
        base: 'https://connect.stripe.com',
      });
      return { stripeUserId: token.stripe_user_id };
    },
    createCheckoutSession: (args) =>
      call<StripeCheckoutSession>('POST', '/v1/checkout/sessions', {
        account: args.accountId,
        idempotencyKey: args.idempotencyKey,
        params: {
          mode: 'payment',
          customer_email: args.customerEmail,
          success_url: args.successUrl,
          cancel_url: args.cancelUrl,
          expires_at: args.expiresAt,
          client_reference_id: args.orderId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: args.currency.toLowerCase(),
                unit_amount: args.amount,
                product_data: { name: `Order ${args.orderNumber}` },
              },
            },
          ],
          metadata: { order_id: args.orderId, tenant_id: args.tenantId, tenant_group_id: args.tenantGroupId },
          payment_intent_data: {
            application_fee_amount: args.applicationFeeAmount,
            metadata: { order_id: args.orderId, tenant_id: args.tenantId, tenant_group_id: args.tenantGroupId },
          },
        },
      }),
    createRefund: ({ accountId, paymentIntentId, idempotencyKey }) =>
      call<{ id: string }>('POST', '/v1/refunds', {
        account: accountId,
        idempotencyKey,
        params: { payment_intent: paymentIntentId, refund_application_fee: true },
      }),
  };
}
