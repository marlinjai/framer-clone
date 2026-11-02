// src/server/commerce/jobs/types.ts
//
// The vocabulary of the shop's durable work (docs/plans/2026-11-02-shop-backbone.md, sections 1.3 to 1.6): the event
// catalogue, the policy and handler of a job kind, and the outcomes a handler can end in. Types plus two error classes
// and one validator, so it needs no `server-only`.

import type {
  DeleteQueryBuilder,
  DeleteResult,
  Kysely,
  Selectable,
  SelectQueryBuilder,
  Transaction,
  UpdateQueryBuilder,
  UpdateResult,
} from 'kysely';
import type { ZodType } from 'zod';

import type { CommerceDB, CommerceJobTable } from '../db-types';
import type { PaymentOutcome, ReceiptAttempt } from '../payment/payments';
import type { PaymentEvent } from '../payment/provider';

/** How long a claim holds a job. `run_at` carries it, so a crashed worker's job simply becomes due again. */
export const JOB_LEASE_MS = 10 * 60 * 1000;

/**
 * Claims that never finished before the next claim kills the job instead of running it. A process that dies in a
 * handler never reaches a failure path, so only the claim can stop a job that keeps killing its process.
 */
export const MAX_OPEN_CLAIMS = 3;

/** One row of `commerce_job`. */
export type CommerceJob = Selectable<CommerceJobTable>;

// --- events --------------------------------------------------------------------

/**
 * The first event catalogue (section 1.3). An event is a name in a registry, not a row: emitting one writes its
 * consumers' jobs in the caller's transaction.
 */
export interface EventPayload {
  /** Only an order that opened a payment: `expiresAt` is when that payment's hold ends. */
  'order.placed': { orderId: string; expiresAt: Date };
  'payment.paid': { orderId: string };
  'payment.stock_gone': { orderId: string };
  'payment.refunded': { orderId: string };
  'receipt.issued': { orderId: string };
}

export type CommerceEventType = keyof EventPayload;

export interface CommerceEvent<E extends CommerceEventType = CommerceEventType> {
  tenantId: string;
  type: E;
  payload: EventPayload[E];
  at: Date;
}

/** One consumer of an event: it writes its job, or decides to write nothing (null). */
export interface EventConsumer<E extends CommerceEventType> {
  enqueue(trx: Transaction<CommerceDB>, event: CommerceEvent<E>): Promise<string | null>;
}

/** Every event with its consumers: the answer to "what happens when an order is paid". */
export type ConsumerRegistry = { readonly [E in CommerceEventType]: ReadonlyArray<EventConsumer<E>> };

/** A job written directly, or by a consumer on behalf of an event. */
export interface ScheduledJob {
  tenantId: string;
  kind: string;
  /** A natural key (`receipt:<orderId>`): a repeat within one company and kind writes nothing. */
  dedupeKey: string;
  /** Ids and cursors only, at most 2000 characters as JSON. */
  payload: Record<string, unknown>;
  runAt: Date;
  /** When this is written: the start of its first give-up cycle. */
  at: Date;
  /** The event that wrote it, for reading a job. */
  eventType?: CommerceEventType;
}

// --- kinds ---------------------------------------------------------------------

export interface JobPolicy {
  /** When the handler's signal fires. Under the lease, so a handler can stop before a second worker may start. */
  deadlineMs: number;
  /** Minutes before the next attempt, by failed attempt. Past the list, laterMinutes. */
  backoffMinutes: readonly number[];
  laterMinutes: number;
  /** From `cycle_started_at`, past which a failure is `dead`. Null: a transient error never kills it. */
  giveUpAfterMs: number | null;
}

/** Ask for another run: a recurring job, or a date that moved. Starts a new give-up cycle. */
export interface JobRerun<P> {
  rerunAt: Date;
  payload?: P;
}

/** A transient failure: back to `pending` with backoff, or `dead` once past give-up. */
export class JobRetryLater extends Error {
  constructor(
    /** A stable, personal-data-free reason: it is stored in `last_error`. */
    readonly reason: string,
    /** Overrides the policy's backoff. */
    readonly delayMs?: number,
  ) {
    super(reason);
    this.name = 'JobRetryLater';
  }
}

/** Only a person can change the outcome: `dead` at once. */
export class JobRefused extends Error {
  constructor(
    /** A stable, personal-data-free reason: it is stored in `last_error`. */
    readonly reason: string,
  ) {
    super(reason);
    this.name = 'JobRefused';
  }
}

/** The per-tenant tables that carry a company: what a handler may reach through `ctx.company`. */
export type CompanyTable = {
  [K in keyof CommerceDB]: K extends `public.${string}` ? never : CommerceDB[K] extends { tenant_id: string } ? K : never;
}[keyof CommerceDB];

/**
 * The tenant group's handle bound to one company. A claim spans every company in its group, and no guard covers
 * isolation between them, so a handler reaches tables through these helpers, which add the `tenant_id` filter.
 */
export interface CompanyContext {
  readonly tenantId: string;
  selectFrom<T extends CompanyTable>(table: T): SelectQueryBuilder<CommerceDB, T, object>;
  updateTable<T extends CompanyTable>(table: T): UpdateQueryBuilder<CommerceDB, T, T, UpdateResult>;
  deleteFrom<T extends CompanyTable>(table: T): DeleteQueryBuilder<CommerceDB, T, DeleteResult>;
  /** The same helpers on one transaction; `trx` is what `emitCommerceEvent` and `scheduleJob` require. */
  transaction<R>(work: (company: CompanyContext, trx: Transaction<CommerceDB>) => Promise<R>): Promise<R>;
}

/**
 * A tenant group's handle and id, always together: everything writes through the handle except the raw stock writes,
 * which address the schema by id, so a mismatched pair would send those to another group.
 */
export interface JobTenantGroup {
  readonly id: string;
  readonly db: Kysely<CommerceDB>;
}

/**
 * What a handler may do to a payment. The dependencies are built by the worker and stay there: a handler never holds
 * the group's unfiltered handle, and the company comes from the job, so an event cannot name another one.
 */
export interface JobPayments {
  handleEvent(event: Omit<PaymentEvent, 'tenantId'>): Promise<PaymentOutcome>;
  /** Issue and link a paid order's receipt (payments.ts issueReceipt); throws what the Books refused. */
  issueReceipt(orderId: string): Promise<ReceiptAttempt>;
}

export interface JobContext<P> {
  readonly job: Pick<CommerceJob, 'id' | 'kind' | 'attempts'>;
  readonly company: CompanyContext;
  readonly payload: P;
  /** Fires at the kind's deadline. A handler passes it to every network call. */
  readonly signal: AbortSignal;
  /** The payment state machine, bound to this job's company. */
  readonly payments: JobPayments;
}

export interface JobKind<P = unknown> {
  policy: JobPolicy;
  /** Parses the payload at claim. One that does not parse is refused. */
  payload: ZodType<P>;
  run(ctx: JobContext<P>): Promise<void | JobRerun<P>>;
}

/** The kinds a build knows. The claim filters on these names, so a kind from a newer build is left alone. */
export type JobKindRegistry = Readonly<Record<string, JobKind>>;

/** A kind, with its policy checked: a deadline past the lease could not stop a handler before a second one starts. */
export function defineJobKind<P>(kind: JobKind<P>): JobKind<P> {
  const { deadlineMs, backoffMinutes, laterMinutes, giveUpAfterMs } = kind.policy;
  if (!(deadlineMs > 0 && deadlineMs < JOB_LEASE_MS)) {
    throw new Error(`job policy: deadlineMs must be above 0 and under the ${JOB_LEASE_MS} ms lease, got ${deadlineMs}`);
  }
  if (![...backoffMinutes, laterMinutes].every((minutes) => minutes > 0)) {
    throw new Error('job policy: every backoff must be above 0 minutes');
  }
  if (giveUpAfterMs !== null && !(giveUpAfterMs > 0)) {
    throw new Error(`job policy: giveUpAfterMs must be above 0 or null, got ${giveUpAfterMs}`);
  }
  return kind;
}
