// src/server/commerce/jobs/consumers.ts
//
// The one registry of what the shop does after a change: each event's consumers, and every job kind this build can
// run. Empty until the slices that move the expiry, the receipts, the mail and the refunds onto the engine
// (docs/plans/2026-11-02-shop-backbone.md, section 5).

import type { ConsumerRegistry, JobKindRegistry } from './types';

export const COMMERCE_CONSUMERS: ConsumerRegistry = {
  'order.placed': [],
  'payment.paid': [],
  'payment.stock_gone': [],
  'payment.refunded': [],
  'receipt.issued': [],
};

export const JOB_KINDS: JobKindRegistry = {};
