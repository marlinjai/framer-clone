// src/server/commerce/jobs/consumers.ts
//
// The one registry of what the shop does after a change: each event's consumers, and every job kind this build can
// run. The receipts, the mail and the refunds join as their slices move them onto the engine
// (docs/plans/2026-11-02-shop-backbone.md, section 5).

import { PAYMENT_EXPIRY_KIND, paymentExpiryConsumer, paymentExpiryKind } from '../payment/expiryJob';
import type { ConsumerRegistry, JobKindRegistry } from './types';

export const COMMERCE_CONSUMERS: ConsumerRegistry = {
  'order.placed': [paymentExpiryConsumer],
  'payment.paid': [],
  'payment.stock_gone': [],
  'payment.refunded': [],
  'receipt.issued': [],
};

export const JOB_KINDS: JobKindRegistry = {
  [PAYMENT_EXPIRY_KIND]: paymentExpiryKind,
};
