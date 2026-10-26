import 'server-only';

// src/server/commerce/payment/deps.ts
//
// The payment handler's wiring for one company of one tenant group: its scoped handle, the providers (the
// demo provider always; Stripe when it is configured), and its receipt in the Books (the shared contacts
// database for the buyer's contact). Routes build it per request; tests build their own with fakes.

import type { Kysely } from 'kysely';

import { booksDependencies } from '@/server/books/http/dependencies';
import { booksScope } from '@/server/books/scope';
import type { CommerceDB } from '../db-types';
import type { PaymentDeps } from './payments';
import { demoProvider, type PaymentProvider, type ProviderId } from './provider';
import { ensureReceipt } from './receipt';
import { sendShopMailAfterPayment } from '../mail/runtime';
import { httpStripeApi, stripeConfig, type StripeApi } from './stripe/client';
import { stripeProvider } from './stripe/connect';

/** The Stripe API when Stripe is configured (real keys, not the placeholders), else null. */
export function configuredStripeApi(): StripeApi | null {
  const config = stripeConfig();
  return config ? httpStripeApi(config) : null;
}

export function paymentDeps(
  db: Kysely<CommerceDB>,
  tgId: string,
  companyId: string,
  opts: { stripe?: StripeApi | null } = {},
): PaymentDeps {
  const stripe = opts.stripe === undefined ? configuredStripeApi() : opts.stripe;
  const provider = (id: ProviderId): PaymentProvider => {
    if (id === 'demo') return demoProvider;
    if (!stripe) throw new Error('Stripe is not configured (STRIPE_SECRET_KEY and friends are unset or placeholders)');
    return stripeProvider(stripe, { db, tenantId: companyId, tenantGroupId: tgId });
  };
  return {
    db,
    tgId,
    provider,
    receipt: (orderId) => {
      const { recipients, contactBook } = booksDependencies();
      return ensureReceipt(booksScope(db, tgId, companyId, { recipients }), contactBook, orderId);
    },
    mail: (tenantId, orderId, kind) => sendShopMailAfterPayment(db, tgId, tenantId, orderId, kind),
  };
}
