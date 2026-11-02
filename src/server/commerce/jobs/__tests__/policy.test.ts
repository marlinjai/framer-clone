// src/server/commerce/jobs/__tests__/policy.test.ts
//
// The parts of the job engine that need no database: the backoff schedule, the policy check, and the empty production
// registries (nothing runs on the engine until the slices that move work onto it). The engine itself is proved
// against real Postgres in jobs.itest.ts.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { COMMERCE_CONSUMERS, JOB_KINDS } from '../consumers';
import { paymentExpiryConsumer } from '../../payment/expiryJob';
import { backoffMs } from '../run';
import { defineJobKind, JOB_LEASE_MS, type JobPolicy } from '../types';

const POLICY: JobPolicy = { deadlineMs: 1000, backoffMinutes: [1, 5, 15], laterMinutes: 360, giveUpAfterMs: 1000 };
const MINUTE = 60_000;

function kindWith(policy: Partial<JobPolicy>) {
  return defineJobKind({ policy: { ...POLICY, ...policy }, payload: z.object({}), run: async () => undefined });
}

describe('backoffMs', () => {
  it('follows the list by failed attempt, then stays at the later value', () => {
    expect([1, 2, 3, 4, 50].map((attempts) => backoffMs(POLICY, attempts))).toEqual([
      MINUTE,
      5 * MINUTE,
      15 * MINUTE,
      360 * MINUTE,
      360 * MINUTE,
    ]);
  });
});

describe('defineJobKind', () => {
  it('accepts a deadline under the lease and a null give-up', () => {
    expect(kindWith({ deadlineMs: JOB_LEASE_MS - 1, giveUpAfterMs: null }).policy.giveUpAfterMs).toBeNull();
  });

  it('refuses a deadline at or past the lease: it could not stop a handler before a second one starts', () => {
    expect(() => kindWith({ deadlineMs: JOB_LEASE_MS })).toThrow(/under the/);
    expect(() => kindWith({ deadlineMs: 0 })).toThrow(/under the/);
  });

  it('refuses a backoff that would spin and a give-up that could never pass', () => {
    expect(() => kindWith({ backoffMinutes: [0] })).toThrow(/backoff/);
    expect(() => kindWith({ laterMinutes: 0 })).toThrow(/backoff/);
    expect(() => kindWith({ giveUpAfterMs: 0 })).toThrow(/giveUpAfterMs/);
  });
});

describe('the production registries', () => {
  it('hold the expiry job and nothing else yet', () => {
    expect(Object.keys(JOB_KINDS)).toEqual(['payment_expiry']);
    expect(COMMERCE_CONSUMERS['order.placed']).toEqual([paymentExpiryConsumer]);
    expect(Object.values(COMMERCE_CONSUMERS).flat()).toEqual([paymentExpiryConsumer]);
  });

  it('give the expiry job the policy of section 1.8: 1, 5, 15, 60 minutes, then 6 hours, for 3 days', () => {
    expect(JOB_KINDS.payment_expiry.policy).toMatchObject({
      backoffMinutes: [1, 5, 15, 60],
      laterMinutes: 360,
      giveUpAfterMs: 3 * 24 * 60 * 60 * 1000,
    });
  });
});
