import 'server-only';

// src/server/commerce/payment/stripe/webhook.ts
//
// A Stripe webhook delivery: verify its signature, then read what it says (docs/plans/2026-10-25-catalogue-
// design.md, "Checkout, payment and receipt", item 4). Stripe signs every delivery with the endpoint's secret:
// the `Stripe-Signature` header carries a timestamp `t` and one or more `v1` HMAC-SHA256 signatures of
// `${t}.${raw body}`. A delivery is accepted only with a matching signature no older than the tolerance, so a
// forged or replayed body changes nothing.
//
// Mapped events (everything else is acknowledged and ignored):
//   payment_intent.succeeded       -> payment_succeeded (amount_received, currency, the PaymentIntent id)
//   payment_intent.payment_failed  -> payment_failed (Stripe's decline code)
//   checkout.session.expired       -> checkout_expired
// A connected account's readiness is not taken from account.updated (that event names no tenant group, and
// the platform keeps no registry outside the tenant schemas): connect.ts asks Stripe on the company's return
// from onboarding and whenever a payment starts on an account not ready yet.
// The order, company and tenant group come from the metadata the platform set when it created the checkout
// session; the connected account comes from the event itself and must be the company's own (connect.ts).

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PaymentEvent } from '../provider';

/** Stripe's default tolerance for a delivery's timestamp. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

/** Verify `header` for `rawBody`; throws StripeSignatureError on a missing, stale or wrong signature. */
export function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSeconds = Date.now() / 1000): void {
  if (!header) throw new StripeSignatureError('missing Stripe-Signature header');
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2);
    if (key === 't') timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp) || signatures.length === 0) {
    throw new StripeSignatureError('malformed Stripe-Signature header');
  }
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new StripeSignatureError('the delivery is too old (or the clocks disagree)');
  }
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'), 'utf8');
  const matches = signatures.some((sig) => {
    const given = Buffer.from(sig, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw new StripeSignatureError('no matching signature');
}

/** Sign a body the way Stripe does (tests, and a local replay of a delivery). */
export function signStripePayload(rawBody: string, secret: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

/** What a verified delivery says. */
export type StripeDelivery =
  | { kind: 'payment'; tenantGroupId: string; accountId: string | null; event: PaymentEvent }
  | { kind: 'ignored'; type: string };

interface StripeEventBody {
  id?: string;
  type?: string;
  account?: string;
  data?: { object?: Record<string, unknown> };
}

function metadataOf(object: Record<string, unknown>): Record<string, string> {
  const metadata = object.metadata;
  return metadata && typeof metadata === 'object' ? (metadata as Record<string, string>) : {};
}

/** Read a verified delivery. Throws on a payment event that lacks the platform's metadata (not ours to apply). */
export function readStripeDelivery(rawBody: string): StripeDelivery {
  const body = JSON.parse(rawBody) as StripeEventBody;
  const type = body.type ?? '';
  const object = body.data?.object ?? {};
  const mapped =
    type === 'payment_intent.succeeded'
      ? 'payment_succeeded'
      : type === 'payment_intent.payment_failed'
        ? 'payment_failed'
        : type === 'checkout.session.expired'
          ? 'checkout_expired'
          : null;
  if (!mapped) return { kind: 'ignored', type };

  const metadata = metadataOf(object);
  const { order_id: orderId, tenant_id: tenantId, tenant_group_id: tenantGroupId } = metadata;
  if (!body.id || !orderId || !tenantId || !tenantGroupId) {
    throw new Error(`Stripe ${type} ${body.id ?? '(no id)'} carries no order metadata`);
  }
  const isIntent = type.startsWith('payment_intent.');
  const lastError = object.last_payment_error as { code?: string; decline_code?: string } | undefined;
  return {
    kind: 'payment',
    tenantGroupId,
    accountId: body.account ?? null,
    event: {
      provider: 'stripe',
      eventId: body.id,
      type: mapped,
      tenantId,
      orderId,
      providerPaymentId: isIntent ? String(object.id) : undefined,
      amount:
        mapped === 'payment_succeeded'
          ? Number(object.amount_received ?? object.amount)
          : undefined,
      currency: isIntent && typeof object.currency === 'string' ? object.currency.toUpperCase() : undefined,
      failureCode: mapped === 'payment_failed' ? (lastError?.decline_code ?? lastError?.code ?? 'payment_failed') : undefined,
    },
  };
}
