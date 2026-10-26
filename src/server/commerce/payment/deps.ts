import 'server-only';

// src/server/commerce/payment/deps.ts
//
// The payment handler's wiring for one company of one tenant group: its scoped handle, the providers, and its
// receipt in the Books (the shared contacts database for the buyer's contact). Routes build it per request;
// tests build their own with fakes.

import type { Kysely } from 'kysely';

import { booksDependencies } from '@/server/books/http/dependencies';
import { booksScope } from '@/server/books/scope';
import type { CommerceDB } from '../db-types';
import type { PaymentDeps } from './payments';
import { demoProvider, type PaymentProvider, type ProviderId } from './provider';
import { ensureReceipt } from './receipt';

/** The provider for an id; Stripe is registered by its own module once configured (slice 5). */
const providers = new Map<ProviderId, PaymentProvider>([['demo', demoProvider]]);

export function registerPaymentProvider(provider: PaymentProvider): void {
  providers.set(provider.id, provider);
}

export function paymentProvider(id: ProviderId): PaymentProvider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`payment provider ${id} is not configured`);
  return provider;
}

export function paymentDeps(db: Kysely<CommerceDB>, tgId: string, companyId: string): PaymentDeps {
  return {
    db,
    tgId,
    provider: paymentProvider,
    receipt: (orderId) => {
      const { recipients, contactBook } = booksDependencies();
      return ensureReceipt(booksScope(db, tgId, companyId, { recipients }), contactBook, orderId);
    },
  };
}
