// src/server/books/repository/events.ts
//
// The audit trail writer (Books plan P1.5): one sales_document_event row per
// state transition and per customer assignment. Line edits of a draft are not
// records and write no event. A payload never carries a recipient's name or
// address.
//
// `created_at` is stamped here, strictly increasing within the process, instead
// of the column default: CURRENT_TIMESTAMP is frozen at transaction start, so
// the events one transaction writes (a cancellation writes three) would all
// carry the same time and "events by time" would have no order between them.

import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';

import type { CommerceDB, SalesDocEventType, SalesDocStatus } from '../../commerce/db-types';
import type { BooksScope } from '../scope';
import { toJsonb, type EventPayload } from '../snapshots';

let lastStamp = 0;

/** A Date strictly later than the previous one this process handed out (millisecond resolution). */
export function eventStamp(): Date {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp);
}

export async function insertEvent(
  trx: Transaction<CommerceDB>,
  scope: BooksScope,
  e: {
    documentId: string;
    eventType: SalesDocEventType;
    fromStatus: SalesDocStatus | null;
    toStatus: SalesDocStatus | null;
    actorUserId: string | null;
    payload: EventPayload;
  },
): Promise<void> {
  await trx
    .insertInto('sales_document_event')
    .values({
      id: randomUUID(),
      tenant_id: scope.tenantId,
      document_id: e.documentId,
      event_type: e.eventType,
      from_status: e.fromStatus,
      to_status: e.toStatus,
      actor_user_id: e.actorUserId,
      payload: toJsonb(e.payload),
      created_at: eventStamp(),
    })
    .execute();
}
