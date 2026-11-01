// src/server/commerce/jobs/__tests__/policy.test.ts
//
// The parts of the job engine that need no database: the backoff schedule, the policy check, and the empty production
// registries (nothing runs on the engine until the slices that move work onto it). The engine itself is proved
// against real Postgres in jobs.itest.ts.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { COMMERCE_CONSUMERS, JOB_KINDS } from '../consumers';
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
  it('run nothing yet: no kind and no consumer', () => {
    expect(JOB_KINDS).toEqual({});
    expect(Object.values(COMMERCE_CONSUMERS).flat()).toEqual([]);
  });
});
