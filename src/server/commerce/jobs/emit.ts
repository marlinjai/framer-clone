import 'server-only';

// src/server/commerce/jobs/emit.ts
//
// Writing work in the same transaction as the change that needs it (docs/plans/2026-11-02-shop-backbone.md, section
// 1.3). Commit means the jobs exist, rollback means they do not, and a worker cannot see them earlier. This and
// `scheduleJob` take a Transaction, not a Kysely: a plain handle does not type-check, so a job can never be written
// beside its data.

import type { Transaction } from 'kysely';

import type { CommerceDB } from '../db-types';
import { COMMERCE_CONSUMERS } from './consumers';
import type { CommerceEvent, CommerceEventType, ConsumerRegistry } from './types';

export { scheduleJob } from './schedule';

/** Write the jobs of an event's consumers. Answers the ids it wrote, for the first attempt after the commit. */
export async function emitCommerceEvent<E extends CommerceEventType>(
  trx: Transaction<CommerceDB>,
  event: CommerceEvent<E>,
  consumers: ConsumerRegistry = COMMERCE_CONSUMERS,
): Promise<string[]> {
  const ids: string[] = [];
  for (const consumer of consumers[event.type]) {
    const id = await consumer.enqueue(trx, event);
    if (id !== null) ids.push(id);
  }
  return ids;
}
