// src/server/commerce/jobs/consumers.ts
//
// The one registry of what the shop does after a change: each event's consumers, and every job kind this build can
// run. The mail and the refunds join as their slices move them onto the engine (docs/plans/2026-11-02-shop-backbone.md,
// section 5). `receipt.issued` has no consumer until the mail does (B5).

import { PAYMENT_EXPIRY_KIND, paymentExpiryConsumer, paymentExpiryKind } from '../payment/expiryJob';
import { RECEIPT_ISSUE_KIND, receiptIssueConsumer, receiptIssueKind } from '../payment/receiptJob';
import type { ConsumerRegistry, JobKindRegistry } from './types';

export const COMMERCE_CONSUMERS: ConsumerRegistry = {
  'order.placed': [paymentExpiryConsumer],
  'payment.paid': [receiptIssueConsumer],
  'payment.stock_gone': [],
  'payment.refunded': [],
  'receipt.issued': [],
};

export const JOB_KINDS: JobKindRegistry = {
  [PAYMENT_EXPIRY_KIND]: paymentExpiryKind,
  [RECEIPT_ISSUE_KIND]: receiptIssueKind,
};
