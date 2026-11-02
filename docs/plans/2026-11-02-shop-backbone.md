---
type: plan
status: draft
date: 2026-11-02
title: "Shop backbone: one job table, Stripe reconciliation, a server-side checkout record and one tax computation"
summary: "The design contract every later shop slice builds on. Durable work moves into one table per tenant schema, commerce_job, claimed one row at a time with FOR UPDATE SKIP LOCKED under a lease, with no Redis. The expiry sweep, receipt retries and shop mail become consumers of it, cut over by expand, backfill, contract. A per-company job replays Stripe's event list through the existing payment handler. A checkout record prices shipping and discounts on the server before payment while guest carts stay in the browser. The order total identity stays total = subtotal + tax_amount: discounts fold into lines in exact cents, and shipping is an order line per rate. Books copies the order's line figures and refuses a receipt whose tax profile disagrees, until the VAT review. Sixteen slices: eleven need Marlin's review, four need a one-line yes for a production change, and one needs nothing."
tags: [framer-clone, commerce, outbox, jobs, stripe, checkout, tax, books]
projects: [framer-clone]
---

# Shop backbone

This is the contract for ranks 1 and 2 of the [Medusa analysis](2026-11-01-medusa-architecture-analysis.md)
(sections 3, 5.5 and 6), plus the identity and tax question of its section 6.3. It specifies, and builds nothing.
Marlin decided on 2026-11-01 that the backbone runs now and that German value-added tax (VAT) is researched first.

**Inputs.** The code on `origin/main` at `b556d0c`, the [agent fleet plan](2026-11-01-agent-fleet.md), the VAT
research in `~/software-dev/decision-pages/2026-11-01-german-vat-research.md`, and an independent review of the
first version of this contract in `~/software-dev/decision-pages/2026-11-01-shop-backbone-review.md`. The VAT
research was written by an AI assistant from public sources, a tax adviser has not reviewed it, and Marlin has not
yet reviewed it. Wherever this plan leans on it, it says so, and nothing with legal effect ships before that
review.

**Evidence marks:** **[code]** read here, **[inference]** concluded from code, **[unproven]** not established,
**[unverified Stripe]** recalled or documented Stripe behaviour that the sandbox has not confirmed (section 2.5).

Short forms: VAT (value-added tax), API (application programming interface), SQL (Structured Query Language),
JSON (JavaScript Object Notation), PDF (Portable Document Format), SEPA (Single Euro Payments Area, delayed bank
payments), B2B and B2C (business to business, business to consumer), GDPR (General Data Protection Regulation).
"Tenant group" is one `tg_<id>` database schema; "company" is `tenant_id` inside it. "Books" is the invoicing
domain in `src/server/books`.

## Decided here, say so if you disagree

1. **One table.** The analysis proposed `commerce_event`, `commerce_delivery` and `commerce_job`. A delivery and a
   timed job have the same columns and the same claim, so both are rows of `commerce_job`. `commerce_event` is
   dropped: nothing reads it, each event has one consumer today, `payment_event` already holds the payment audit
   trail, and a job row written in the caller's transaction gives the same crash safety. It comes back when
   something needs to read it.
2. **Fan-out at write time.** `emitCommerceEvent(trx, ...)` writes the event's jobs in the caller's transaction.
   An event is a name in a registry, not a row. There is no dispatcher that could fall behind.
3. **At-least-once, always.** A lease replaces any notion of exactly-once, and every handler is idempotent by a
   named mechanism (section 1.8).
4. **One claim at a time.** A lease starts when its job does. The claim stops a job that keeps killing its process.
5. **The worker runs inside the app,** one poller per process, every 30 seconds. A host timer stays as a watchdog.
6. **Cutover is expand, backfill, contract.** New code runs beside the old until the worker has picked up
   everything the old container wrote.
7. **A delay is scheduled, not swept.** An order's expiry is a job written with the order, due at `expires_at`.
8. **The webhook stops carrying the receipt.** It answers 200 once the payment commits.
9. **A late refund leaves the database transaction.** The provider call moves into a job, which follows the rule in
   section 7 of the analysis: write the intent, then call the provider with an idempotency key.
10. **Reconciliation replays Stripe's own event list** through `handlePaymentEvent`, so there is no second state
    machine. A refund or dispute made outside the platform becomes a finding for a person.
11. **The Stripe session is pinned once** (id, expiry, return address) and the stock hold is set just past it.
12. **Stock is still reserved at place, not during checkout.** An abandoned checkout holds nothing.
13. **The checkout's quote is a JSON snapshot; the order's rows stay relational.** A quote is rewritten on every
    change and read only as a whole.
14. **The identity does not change.** `total = subtotal + tax_amount` stays, with no negative lines.
15. **Books copies a shop order's line figures, and until B14 refuses a receipt when the order's tax treatment
    and Books' disagree.** Today's loud failure stays loud: no invoice with the wrong tax before the VAT review.
16. **Rounding stays per line until Marlin decides, and shipping (rank 3) waits for that decision.**
17. **The cross-company `request_id` fix has one owner:** slice B0, which needs Marlin's yes.

## 1. One outbox and job table on Postgres

No Redis, no queue library, no saga engine. The analysis (6.1) gives the reasons: a transactional write is the
property those would lack, and the shop host runs one schema per tenant group [code].

### 1.1 What is replaced

| Today | Who decides retry and timing | Weakness |
|---|---|---|
| `shop_mail` (migration 023) | `setInterval` per process, `mail/runtime.ts`, only when Lumitra Mail is configured | Reads rows, then sends: no claim, so two copies can both attempt one letter (the mail key makes that harmless) [code] |
| Receipt retry | Stripe redelivering a webhook that answered 500 (`stripe/webhook/route.ts`) | Stops when Stripe stops. A demo payment has no retry at all, since nothing redelivers it [code] |
| Expiry | Host timer (installed on `coolify-shared-host`) plus a sweep on each order and pay (`expirySweep.ts`, `payments.ts`) | The file's own comment calls it a stopgap for a job table [code] |
| Late refund | The webhook's redelivery, with the provider call inside a database transaction (`refundLatePayment`) | Holds a row lock across a network call; if the refund keeps failing, redelivery ends with the buyer charged and the order closed [code, inference] |

### 1.2 The table

It lives in every `tg_<id>` schema, added through the tenant migration set, so provisioning and `migrateAllTenants`
carry it and `pg_dump -n tg_x` still extracts one customer whole. House style as 023: bare names, ids `TEXT` minted
by the application, `TIMESTAMP(3)`, re-runnable. The SQL below uses bare names for reading; the code goes through
the scoped handle, because `check-guards` refuses bare tenant tables in raw SQL.

```sql
CREATE TABLE "commerce_job" (
  "id"                TEXT NOT NULL,
  "tenant_id"         TEXT NOT NULL,
  "kind"              TEXT NOT NULL,
  "dedupe_key"        TEXT NOT NULL,
  "event_type"        TEXT,                -- the event that wrote it, for reading a job; null when scheduled directly
  "payload"           JSONB NOT NULL,      -- ids and cursors only
  "status"            TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | dead
  "run_at"            TIMESTAMP(3) NOT NULL,             -- when due; while running, when the lease ends
  "attempts"          INTEGER NOT NULL DEFAULT 0,        -- since the last success, for backoff
  "open_claims"       INTEGER NOT NULL DEFAULT 0,        -- claims that never finished: the crash count
  "cycle_started_at"  TIMESTAMP(3) NOT NULL,             -- give-up is measured from here
  "claim_token"       TEXT,                -- fences a worker whose lease ran out
  "last_error"        TEXT,                -- at most 1000 characters, no personal data, no secrets
  "acknowledged_at"   TIMESTAMP(3),        -- a person has seen this dead job
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  "finished_at"       TIMESTAMP(3),
  CONSTRAINT "commerce_job_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "commerce_job_dedupe_key" UNIQUE ("tenant_id", "kind", "dedupe_key")
  -- tenant_id uuid CHECK; status CHECK; attempts and open_claims >= 0; jsonb_typeof(payload) = 'object';
  -- length(payload::text) <= 2000; last_error length; running needs a claim_token; dead and done need finished_at
);
CREATE INDEX "commerce_job_due_idx"  ON "commerce_job" ("run_at")                  WHERE "status" IN ('pending', 'running');
CREATE INDEX "commerce_job_dead_idx" ON "commerce_job" ("tenant_id", "created_at") WHERE "status" = 'dead';
CREATE INDEX "commerce_job_done_idx" ON "commerce_job" ("finished_at")             WHERE "status" = 'done';
```

`kind` has no CHECK. A kind is added by a registry entry rather than a migration, and the claim filters on the
kinds this build knows, so a rolled-back build leaves a newer build's jobs alone instead of killing them.

### 1.3 Writing an event in the same transaction as its data

```ts
// src/server/commerce/jobs/emit.ts
export async function emitCommerceEvent(
  trx: Transaction<CommerceDB>,      // Transaction, not Kysely: a plain handle does not type-check
  event: { tenantId: string; type: CommerceEventType; payload: EventPayload[CommerceEventType]; at: Date },
): Promise<string[]>;                // the ids of the jobs it wrote

export async function scheduleJob(trx: Transaction<CommerceDB>, job: ScheduledJob): Promise<string | null>;
```

- `emitCommerceEvent` calls each consumer's `enqueue(trx, event)` from one registry,
  `src/server/commerce/jobs/consumers.ts`. That file is the answer to "what happens when an order is paid", which
  Medusa spreads across subscribers.
- A consumer may decide to write nothing: `shop_mail` writes only while the company is connected, as today.
- Commit means the jobs exist; rollback means they do not. A worker cannot see them earlier, because claiming only
  reads committed rows.
- Jobs dedupe on a natural key (`receipt:<orderId>`), through `ON CONFLICT DO NOTHING`, so a repeated emission
  cannot double the work.
- An event is emitted only where the change that causes it really happened: inside a transition under the row
  lock, or after checking the update count. `receipt.issued` needs the second: the link's `UPDATE` has a guard, and
  an update of zero rows emits nothing.

The first catalogue:

| Event | Written in | Consumers |
|---|---|---|
| `order.placed` | `createOrder`, when a payment opens | `payment_expiry`, due at `expires_at` |
| `payment.paid` | `handlePaymentEvent`, pending or closed to paid | `receipt_issue` |
| `payment.stock_gone` | a second transaction after the late success aborted (section 1.9) | `late_refund` |
| `payment.refunded` | the `late_refund` job's commit | `shop_mail` (`late_refund`) |
| `receipt.issued` | the transaction linking the receipt | `shop_mail` (`order_confirmation`) |

Directly scheduled: `stripe_reconcile` (one recurring job per connected company) and `checkout_expire` (one per
checkout).

Changing the receipt to dispatch, which the VAT research recommends, later moves one consumer line from
`payment.paid` to `order.dispatched`.

### 1.4 Claiming

`FOR UPDATE SKIP LOCKED` lets several workers pick different rows. It does not by itself make a claim, because the
work (a PDF render, a Lumitra Mail call, a Stripe call) runs outside any transaction. So a claim is a short
transaction that takes a lease on **one** job. A lease that starts at claim would be wrong for a batch: a job run
fifteenth could start after its lease ended and be claimed a second time.

```sql
WITH due AS MATERIALIZED (
  SELECT "tenant_id", "id" FROM "commerce_job"
   WHERE "status" IN ('pending', 'running') AND "run_at" <= $now AND "kind" = ANY($knownKinds)
   ORDER BY "run_at", "id"
   LIMIT 1
   FOR UPDATE SKIP LOCKED
)
UPDATE "commerce_job" AS j
   SET "status"      = CASE WHEN j."open_claims" >= $maxOpenClaims THEN 'dead' ELSE 'running' END,
       "finished_at" = CASE WHEN j."open_claims" >= $maxOpenClaims THEN $now END,
       "last_error"  = CASE WHEN j."open_claims" >= $maxOpenClaims THEN 'claimed repeatedly without finishing' ELSE j."last_error" END,
       "claim_token" = CASE WHEN j."open_claims" >= $maxOpenClaims THEN NULL ELSE $token END,
       "attempts"    = j."attempts" + 1,
       "open_claims" = j."open_claims" + 1,
       "run_at"      = $now + $lease,
       "updated_at"  = $now
  FROM due
 WHERE j."tenant_id" = due."tenant_id" AND j."id" = due."id"
 RETURNING j.*;
```

The `MATERIALIZED` keeps the planner from re-evaluating a `LIMIT` subquery.

- **The lease.** `$lease` is one constant, 10 minutes. `run_at` carries it on purpose: a claimed job is simply one
  whose next run is when its lease ends, so a crashed worker's job becomes due again with no reaper and one index.
- **Crashes.** `open_claims` rises at claim and returns to 0 at any finish, success or failure. A process that dies
  in a handler never finishes, so `$maxOpenClaims` (3) sends a job that keeps killing its process to `dead` from
  the claim itself. The failure path could not do this, because a crashing process never reaches it. A worker
  discards a row returned as `dead`, and logs it.
- **The fence.** Finishing is conditional on the token, so a worker that outlived its lease changes nothing. Zero
  rows updated is logged. Its side effect is safe by section 1.8.

```sql
UPDATE "commerce_job" SET ... WHERE "tenant_id" = $t AND "id" = $id AND "claim_token" = $token;
```

- **Real deadlines.** A handler gets an `AbortSignal` that fires before the lease ends, and it has to reach the
  network. `StripeApi`'s `fetch` and the Lumitra Mail client take no signal today [code], so B7 and B5 add one.
  `ensureReceipt` cannot be aborted partway, so a receipt relies on the lease being far longer than a render. If
  that fails, a second run can delete the first's draft; the partial unique index still prevents two invoices, so
  the cost is a failed attempt and an orphaned PDF, not money [code, inference].
- **`runJobNow(db, jobId)`** is the same claim narrowed to one id, used for the first attempt after a commit. It and
  the poller cannot both run one job.

### 1.5 Retries, backoff and dead letters

The registry gives each kind a policy:

```ts
interface JobPolicy {
  deadlineMs: number;               // under the lease
  backoffMinutes: number[];         // past the list, laterMinutes
  laterMinutes: number;
  giveUpAfterMs: number | null;     // from cycle_started_at; null means a transient error never kills it
}
```

A handler ends in one of four ways:

| Outcome | Effect |
|---|---|
| Returns | `done` |
| Returns `{ rerunAt, payload? }` | Back to `pending`; `attempts` 0, `cycle_started_at` now: a recurring job, or a date that moved |
| Throws `JobRetryLater(reason, delayMs?)`, or anything else | `pending` with backoff, or `dead` once past `giveUpAfterMs` |
| Throws `JobRefused(reason)` | `dead` at once: only a person can change the outcome |

Give-up counts from the last success, not from `created_at`. Otherwise a recurring job created in January would die
on its first transient failure in March.

`dead` means "a person must look":

- `last_error` goes through `receiptFailure` (`payments.ts`), which keeps a stable code or an error name, so an
  arbitrary exception message cannot carry personal data. Handlers that already build safe reasons pass those.
- It is logged once with `[commerce-job]`, the kind, the company and the id.
- It counts on the health route (section 1.7), and the company's owner sees it where failed mail already appears
  (`connection.ts`). The order list (rank 4) adds a per-order view.
- `requeueJob(tenantId, id)` sets `pending` with fresh counters. `acknowledgeJob(tenantId, id)` sets
  `acknowledged_at`, for a job nobody should retry. The internal route exposes both; a button comes with the order
  list.

### 1.6 Tenant scoping

- A job is claimed through `commerceTenantDb(tgId)`, the same scoped handle every repository uses. That isolates
  tenant groups. `check-guards` covers the schema boundary and reads new tables from the migrations by itself;
  only the pinned count in `checkGuards.test.ts` moves.
- Isolation between **companies inside a group** has no such guard, and the claim spans companies by design. So a
  handler receives a typed context bound to `job.tenant_id`, `ctx.company`, whose helpers add the `tenant_id`
  filter, and every kind has a test with two companies in one group proving it touches only its own.
- A handler never holds the group's unfiltered handle. The state machine needs that handle and the group's id, so the
  worker builds `PaymentDeps` in `jobs/run.ts` and hands over `ctx.payments`, whose `handleEvent` takes no `tenantId`:
  the company comes from the job. A later slice that needs more of `PaymentDeps` adds a bound method there, and never
  a handle.
- A payload holds ids only and is parsed by a per-kind schema at claim. One that does not parse is `JobRefused`.

### 1.7 Running with one or several app copies

How many replicas run is not established (`rateLimit.ts` says one container today; the analysis found nothing in
`deploy/`). Under the lease it does not matter: any number of pollers is safe, and one is enough.

- **Driver.** `startCommerceWorker()` in `src/server/commerce/jobs/runtime.ts`, started from
  `src/instrumentation.node.ts`, replacing `startShopMailSweep`. One timer per process, guarded on `globalThis`
  against dev reloads, `unref`'d, no overlap with itself. A failure to start is logged and never fails the server,
  as the mail sweep does.
- **Why in the app, given what `deploy/README.md` says for the host timer.** That timer was chosen for one caller
  and nothing during `next build`. The lease removes the need for one caller, and `register()` does not run during a
  build. A poller also works on every deploy with nothing to install on the host.
- **One pass.** Read tenant groups from `public.tenant_groups`, the runner's registry, not from `site`: a group
  whose last site was deleted can still have a late refund queued. For each group, with at most 4 at a time, claim
  and run up to 20 jobs one by one. A group failing never stops the others; a group without its schema or table is
  skipped with the checks `expirySweep.ts` and `runtime.ts` already use.
- **Interval.** 30 seconds, down from the mail sweep's 60, because expiry now depends on it.
- **First attempt.** After a commit, the caller starts `runJobNow` for the jobs it wrote. Mail is not awaited.
  Section 1.9 covers receipts. A buyer never waits on the poller.
- **Hourly duties,** in the pass: delete `done` jobs older than 90 days, at most 500 per group (a dedupe key concerns
  one order or checkout, so nothing old can recur), and run the backfills of section 1.10.
- **Watchdog.** `POST /api/internal/commerce/jobs/run`, behind `checkInternalRequest`, runs one pass and answers
  `{ tenantGroups, ran, failed, deadUnacknowledged, findingsOpen, oldestDueSeconds }`. It answers 500 only when a pass
  failed or the oldest due job is over 10 minutes late. Dead jobs are a count, not a failure: a dead row persists,
  so turning red on one would keep the monitor red and hide the next real failure across all tenants. New systemd
  units next to the expiry ones call it every 5 minutes, so a dead poller still gets its work done and the journal
  shows it. An Uptime Kuma monitor on the same route is what reaches Marlin.

**Known limit.** One indexed query per tenant group per pass, per process. At 1,000 groups that is seconds of a 30
second interval [inference, not measured]. Each pass logs its duration. When a pass exceeds 20 seconds, the fix is a
small platform-level table of groups with due work. It is not built now, because there is no demand for it and it
would add a write across schemas to every transaction.

### 1.8 Idempotency per kind

A claim can run twice, so each handler names why that is safe. A handler with no network call has nothing for its
signal to reach, so `ctx.payments` passes the kind's `deadlineMs` to the payment transaction as its `lock_timeout`: a job
blocked on a payment row becomes an ordinary retry, not an open claim that ends in a false `dead`.

| Kind | Dedupe key | Why a repeat is harmless | Backoff, give up | Dead means |
|---|---|---|---|---|
| `payment_expiry` | `expiry:<orderId>` | `payment_event` records `expiry:<orderId>` once under the payment's row lock [code] | 1, 5, 15, 60 minutes, then 6 hours; 3 days | Stock held past its window |
| `receipt_issue` | `receipt:<orderId>` | `ensureReceipt` answers an issued receipt; a partial unique index allows one per order [code] | Same; 30 days, since a company may set up its Books late | A paid order with no receipt |
| `shop_mail` | `mail:<orderId>:<kind>` | Lumitra Mail's key, and the frozen letter [code] | Same as today; 3 days | A letter that could not go out |
| `late_refund` | `refund:<orderId>` | Stripe's idempotency key while it lasts, then `charge_already_refunded` (section 1.9). The database does **not** refuse this: `order_payment_guard` lets `refunded` to `refunded` pass and allows `paid` to `refunded` [code], so the job's check under the lock is the protection | Same; 30 days | A buyer charged who may not be refunded |
| `stripe_reconcile` | `reconcile:<provider>` | Replays dedupe on `payment_event`; findings dedupe on their key | Recurring every 15 minutes; `giveUpAfterMs` null | Crashed repeatedly: reconciliation stopped for the company |
| `checkout_expire` | `checkout:<checkoutId>` | It acts only when due, under the row lock (section 3.2) | Same; 3 days | Buyer data kept too long |

`payment_event` stays: inbound dedupe is a separate concern from outbound work.

A `receipt_issue` job on a payment that is no longer `paid` is `done`, not a failure: a refund that overtook it needs
no receipt, and retrying `NOT_PAID` for 30 days would end in a false alarm.

### 1.9 How the private versions are absorbed

**Expiry.**

- `createOrder` emits `order.placed` in its transaction, so the expiry job exists from the moment the hold does.
- `PaymentEvent` gains `requireDue: true`, set by the job and both sweeps. Under the row lock and **before**
  `recordEvent`, `handlePaymentEvent` then checks `status = 'pending'` and `expires_at <= now`, and otherwise returns
  with nothing written. Today's check comes after `recordEvent` and there is none on the date [code], so a race with
  a pay click could close a payment whose session just opened, and a sweep reaching a paid order would write a false
  `checkout_expired` row into the append-only `payment_event`. Stripe's own `checkout.session.expired` has no
  `requireDue`.
- If `expires_at` has moved, the job returns `{ rerunAt }`.
- With a stored Stripe session the job asks Stripe first (section 2.1). Without one it closes.
- The per-company `sweepExpiredPayments` before an order stays, for payments with no session: it stops an expired hold
  reading as a shortage in the seconds before the poller reaches it. A payment with a session waits for its job,
  because a sweep in a buyer's request should not call Stripe per row. The pay route narrows to this order.

**Receipts.**

- `payment.paid` writes `receipt_issue` in the transaction that marks the payment paid. A receipt can no longer be
  forgotten.
- The handler is `ensureReceipt`, then the link and `receipt.issued` in one transaction. On failure it still writes
  `receipt_error`, because the owner surface reads it, and rethrows for the retry. `TOTALS_MISMATCH` and
  `TAX_PROFILE_MISMATCH` are `JobRefused`.
- `handlePaymentEvent` returns the ids it wrote. The demo pay route awaits `runJobNow`, so its answer keeps its
  `receipt` field. The webhook does not wait: it starts the attempt and answers, because a PDF render should not hold
  a Stripe delivery open.
- A webhook no longer answers 500 `receipt_pending`.

**Mail.**

- `shop_mail` keeps what is about the letter: `letter`, `mailing_id` and `status` (`sent`, `blocked`, `failed`,
  `pending`), with the frozen-letter rule untouched.
- Scheduling moves to the job. `deliverShopMail` keeps its body and loses its own bookkeeping: `MailRetryLater` becomes
  `JobRetryLater`, `MailRefused` writes `failed` and throws `JobRefused`, and `blocked` is `done` because Lumitra Mail
  decided and a person cannot change it here.
- `sweepShopMail`, `startShopMailSweep` and `nextAttemptDelayMs` go in B5; the backfill covers the gap.
- `attempts`, `next_attempt_at` and `last_error` are dropped by B9, once the old build is gone.

**Late refund.** A late success with the stock gone must abort its transaction, to undo any partial re-reservation
(`LateStockGoneError`). So the intent needs a **second** transaction, as `refundLatePayment` has today:

1. Re-lock the payment; if another delivery decided it, stop. Record the event, store `event.providerPaymentId` (an
   expired row usually has none, and the job needs it), emit `payment.stock_gone`. The status stays closed.
2. The job reads the row. It goes on only if the status is `failed`, `cancelled` or `expired`, with no `refund_id`.
3. It calls `refund`, outside any transaction, with the key `refund:<providerPaymentId>`. Stripe keeps an idempotency
   key for about a day and replays a first server error for that period [unverified Stripe], so early retries may
   repeat a stale failure, and backoff carries past it. After the key is gone a retry gets
   `charge_already_refunded` [unverified Stripe]: that is success, and a new `StripeApi.listRefunds` finds the refund
   id. Anything else from a retry keeps retrying.
4. Under the lock, if the status is still closed: set `refunded`, emit `payment.refunded`. If not, the provider
   refunded and our state moved: a finding, `refund_state_conflict`.

The key is full-refund only: rank 6 must change it, as the VAT research also says.

### 1.10 Cutover: expand, backfill, contract

The migration runs in the new container while the old one still takes shop traffic [code, `deploy/README.md`]. A
migration's backfill therefore misses what the old build writes afterwards, and it could not see rows that the old
code path never made into jobs. So no backfill lives in a migration. `jobs/backfills.ts` holds idempotent
`INSERT ... SELECT ... ON CONFLICT DO NOTHING` statements that the worker itself runs, per group, on its first pass
and then hourly:

| Backfill | From | Added in | Removed in |
|---|---|---|---|
| `payment_expiry` | `order_payment` where `status = 'pending'` | B3 | B3R |
| `receipt_issue` | `status = 'paid'` and `receipt_document_id` is null | B4 | B9 |
| `shop_mail` | `shop_mail` rows `pending` | B5 | B9 |
| `stripe_reconcile` | `payment_account` for Stripe, first cursor per section 2.2 | B8 | stays until the fleet of accounts is seeded, then B9 |

The receipt backfill is needed even with no gap: a paid order without a receipt relied on Stripe redelivery, and
after B4 a repeat delivery is a `duplicate` that writes no job, so it would otherwise stay without a receipt, silently.

Removal needs its own deploy: B3 keeps the old expiry route, sweep and timer running beside the job. The route stays
until the installed timer is gone, because otherwise the unit fails on a 404. B3R removes them and is one line for
Marlin, since the units are installed on `coolify-shared-host`.

## 2. Stripe reconciliation

BusBasis needed this because lost webhooks left orders captured on Stripe and unpaid in its shop (analysis 3.5).
framer-clone compares nothing with Stripe today [code]. The risk is real here too, and sharper now that
`PaymentMismatchError` on a webhook is answered 200 and only logged [code].

### 2.1 A defect to fix first: the session is not pinned

Read from the code; the independent review confirmed the first three:

- **The session id is thrown away.** The pay route ignores `started.providerPaymentId` (a Checkout Session id), and
  `provider_payment_id` stays empty until a webhook sets it, to a PaymentIntent id [code].
- **The idempotency key does not hold.** `start` sends `checkout:<orderId>` with
  `expires_at = max(window, now + 31 minutes)` [code]. Once a session exists, `now + 31 minutes` wins, so it differs on
  every call. Stripe refuses a key repeated with other parameters [unverified Stripe]. So a buyer who returns from
  Stripe and presses pay again gets a server fault, the opposite of what the comment there promises.
- **The hold ends before the session does.** The hold is 30 minutes from the order; the session lasts 31 from the pay
  click. A buyer who pays in the gap reaches the late path [inference].
- **A declined card closes the order while its session is open.** `payment_intent.payment_failed` fires per attempt
  and the buyer can retry on the same page [unverified Stripe], yet the code releases the stock at once [code]. A retry
  that succeeds then takes the late path and may be refunded.

**Decision.** `order_payment` gains `provider_session_id`, `session_expires_at` and `session_return_url`, added to the
set-once rule in `order_payment_guard` (BK018). The guard also refuses a change of `buyer` once a session is pinned,
so the email cannot break the key in the six slices before the buyer is fixed at place.

1. **Pin.** On the first pay, a short transaction under the row lock checks `status = 'pending'` and
   `expires_at > now` (the same check as `requireDue`, from the other side), then fixes `session_expires_at` at now plus
   45 minutes, fixes `session_return_url`, and sets `expires_at` to `session_expires_at` plus 5 minutes of grace. Stripe
   requires an expiry at least 30 minutes after creation [unverified Stripe], and a retry must still satisfy that,
   hence 45 rather than 31.
2. **Create.** Stripe is called with the stored values and the key; the id is stored after.
3. **Retry with no stored id.** The same values again, while `session_expires_at` is more than 31 minutes away. Past
   that, the stored value would be refused and a new key could open a second payable session (a second success on a
   paid order is silently kept [code]), so the payment closes and the buyer starts again.
4. **A later pay** uses a new `retrieveCheckoutSession`, by status:
   - `open`: answer its URL.
   - `complete`: apply the success (below) and answer that the order is paid.
   - `expired`: close the payment.
5. **A declined attempt.** While the pinned session is open, `payment_failed` records the event and keeps the failure
   code, and the payment stays `pending`. The session's end closes it. The demo provider has no session and closes at
   once as today.
6. **The expiry job** retrieves the session before closing, because a hold ending with its session could otherwise
   close a payment Stripe took whose webhook was lost, with reconciliation up to 15 minutes behind:
   - `complete`: apply `payment_succeeded` with `eventId: session:<id>` and the session's amount and PaymentIntent. A
     later real delivery has another id and finds the payment already paid.
   - `expired`: close, with `requireDue`.
   - `open`: rerun in 5 minutes.
   - Stripe unreachable: `JobRetryLater`, and after 60 minutes past `expires_at` close anyway, since the late path and
     reconciliation recover it and a hold should not depend on Stripe being up.

A hold can last about 80 minutes at worst, up from 30. That is the price of not refunding a good payment, and an
abandoned checkout before the pay click holds nothing at all once B13 lands.

**Cutover.** A payment pending at deploy with an old session and no stored id gets pinned parameters under the same
key, which Stripe refuses. That buyer's pay fails until the hold ends, for at most about an hour. This is accepted: a
new key namespace would open a second payable session.

### 2.2 The job

`stripe_reconcile` is one recurring job per company with a Stripe account, written when the account is stored and by
the backfill for existing accounts. Every 15 minutes it:

1. **Lists a whole window.** A new `StripeApi.listEvents({ accountId, types, createdGte, startingAfter })`,
   `GET /v1/events` with the `Stripe-Account` header. The list is newest first and `starting_after` walks toward older
   events [unverified Stripe], so a saved page cursor cannot move forward between runs. The job pages back to
   `createdGte` and holds the window before applying anything. Types: `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created`.
2. **Reads each** through `readStripeEvent`, extracted from `readStripeDelivery`, so a webhook and a replay parse one
   way.
3. **Binds the account from the job's own context,** not from the event, since listed events may not carry `account`
   [unverified Stripe] and that check is the isolation check.
4. **Skips events without platform metadata.** A Standard account can take payments outside the platform; the webhook
   already ignores those [code].
5. **Applies in a fixed order.** For one order, a `payment_intent.succeeded` in the window wins: failures and expiries
   of that order in the window are skipped. Otherwise oldest first. A failure followed by a success would otherwise
   close the order, release its stock and enter the late path, which can refund a good payment. Payment outcomes pass
   to `handlePaymentEvent` under Stripe's own event id, so a later real delivery dedupes on `payment_event`, and
   everything downstream (receipt, mail, late path) is the normal flow.
6. **Records findings** per section 2.3.
7. **Advances only when the whole window finished:** `{ rerunAt, payload: { createdGte: runStart minus 1 hour } }`. A
   failed page repeats the run from the old cursor, which `payment_event` makes harmless.

**First cursor.** A new account starts at now. The backfill for existing accounts starts 3 days back, Stripe's usual
redelivery reach [unverified Stripe], and not at the 30-day limit, because a month-old success on a closed order would
go down the late path by itself. Older losses are a one-off operator check.

**Failure.** A transient error never kills the job (`giveUpAfterMs` null). An account Stripe says is gone or
disconnected ends it `done` with a finding `account_disconnected`. Connecting again reactivates the row, because the
dedupe key would otherwise block a new one: `scheduleJob` for this kind updates a `done` row back to `pending`.

Stripe lists events back 30 days [unverified Stripe], so a cursor older than 25 days raises a finding.

### 2.3 Findings

| Case | Action |
|---|---|
| Stripe paid, we are pending or closed | Applied, through the state machine |
| Stripe failed or expired, we are pending | Applied, under the rule of section 2.1 step 5 |
| Amount or currency differs (`PaymentMismatchError`) | Finding, nothing changes. The webhook writes the same finding |
| Platform metadata names another company, or no payment row exists | Finding |
| `charge.refunded` matching our `refund_id`, or a refund our `late_refund` job is working on | Nothing: our own refund |
| Other `charge.refunded` on a payment of ours | Finding. A Standard account has a full Stripe dashboard, so an owner can refund there without the platform [inference] |
| `charge.dispute.created` | Finding, resolved to the order through its PaymentIntent, since a dispute may carry no metadata [unverified Stripe] |
| A refund or dispute whose PaymentIntent matches no payment here | Skipped: not the platform's |

```sql
CREATE TABLE "payment_finding" (
  "tenant_id", "id", "provider", "provider_ref", "kind", "order_id", "detail" TEXT,  -- no personal data
  "created_at", "resolved_at",
  UNIQUE ("tenant_id", "provider", "provider_ref", "kind"),
  FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order" ("tenant_id", "id")      -- order_id nullable
);
```

Findings surface like dead jobs: a count on the health route and to the owner. Acting on a dashboard refund belongs to
rank 6, because it touches Books.

### 2.4 Not covered

`processing` payments (SEPA and Klarna) stay rank 8; the job handles only what the webhook handles today.
Reconciliation does not compare payouts or fees. The demo provider has nothing to reconcile.

### 2.5 What the sandbox must prove first

Everything marked [unverified Stripe] is recalled or read from documentation, not tested here. The operator session
proves these in Stripe's sandbox as the first step of the slice, before its code is written, because workers do not
hold the keys. A result that differs changes this contract before the code is built.

| Before | To prove |
|---|---|
| B7 | A repeated key with other parameters is refused. `expires_at` under 30 minutes is refused. `payment_intent.payment_failed` fires per attempt and the session stays open. `retrieveCheckoutSession` statuses. A second refund's error code. How long an idempotency key lasts, and whether a first error is replayed |
| B8 | List order and `starting_after` direction. The `Stripe-Account` header on `GET /v1/events`. Whether listed events carry `account`. Event shape against the webhook's at the account's API version. How far back the list reaches. What a dispute's object carries. The error for a disconnected account. Stripe's redelivery reach |

B6 depends on the B7 proof, so B7 runs first.

## 3. A checkout record

The browser cart stays as it is: `src/lib/commerce/cart.tsx`, `localStorage`, no server write, a list of intentions. A
checkout row exists only once a buyer starts checkout, so browsing costs nothing and no anonymous row exists per
visitor.

### 3.1 Why now

Beyond the analysis's reason, that shipping and discounts need a server price before payment, findings force it:

- **An order is priced before the buyer is known.** `route.ts` allows the buyer to arrive at the pay step, so tax cannot
  follow the destination (VAT research, summary 3).
- **The buyer never confirms a total.** The cart shows a display figure and the server decides at order creation [code].
- **`request_id` comes from the client.** B0 scopes it; a server-minted key then closes the client side.

### 3.2 The table

```sql
CREATE TABLE "checkout" (
  "tenant_id"          TEXT NOT NULL,
  "id"                 TEXT NOT NULL,
  "site_id"            TEXT,
  "status"             TEXT NOT NULL DEFAULT 'open',   -- open | placed | expired
  "token_hash"         TEXT NOT NULL,      -- SHA-256 of the buyer's capability, the token itself is never stored
  "revision"           INTEGER NOT NULL DEFAULT 0,
  "currency_code"      TEXT NOT NULL,
  -- inputs
  "lines"              JSONB NOT NULL,     -- [{ variantId, quantity }]
  "buyer"              JSONB NOT NULL,     -- the billing party, buyerSchema, {} until given
  "delivery"           JSONB NOT NULL,     -- the delivery address, {} until given; tax follows this one
  "shipping_option_id" TEXT,               -- rank 3
  "codes"              JSONB NOT NULL,     -- rank 5, [] until then
  -- derived, keyed to the inputs
  "quote"              JSONB,
  "quote_key"          TEXT,
  "quoted_at"          TIMESTAMP(3),
  -- result
  "order_id"           TEXT,
  "retried_into"       TEXT,               -- makes retry idempotent
  "placed_at"          TIMESTAMP(3),
  "wiped_at"           TIMESTAMP(3),
  "expires_at"         TIMESTAMP(3) NOT NULL,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "checkout_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "checkout_order_fkey" FOREIGN KEY ("tenant_id", "order_id") REFERENCES "order" ("tenant_id", "id")
  -- CHECKs: status set; JSON shapes; placed needs order_id; open has none
);
```

Delivery and billing are separate from the start. The research is firm that tax follows where transport ends, and
`buyer.ts` has one address [code].

**Access.** An anonymous buyer holds a 32-byte random token, sent in a header, never in a URL. The tenant comes from the
request host, as on every storefront route. A wrong token answers the same 404 as a missing id. Creating a checkout goes
through the bounded `SlidingWindow` from `src/server/forms/rateLimit.ts`, per IP address.

**Personal data.** An open checkout expires after 24 hours, extended by each change. One `checkout_expire` job serves
the whole life of a row:

- Open and past `expires_at`: set `expired`, empty `buyer` and `delivery`, set `wiped_at`.
- Open and not due: `{ rerunAt: expires_at }`.
- Placed: `{ rerunAt: placed_at + 7 days }` until then, and then empty the same two columns, since the order and payment
  hold what must be kept.

A company erasure removes its checkouts, like `form_submission`.

### 3.3 One pricing path

`createOrder` steps 2 to 4 (price, snapshot, tax) become `priceCart(db, input)`, read-only and callable on a handle or a
transaction. The quote and the order both call it, so they cannot diverge. It uses `priceDocument` (section 4).

The quote is what the buyer sees: lines with amounts, shipping lines, per-rate buckets, totals, tax note.

`quote_key` is the SHA-256 of the canonical JSON of the inputs and the computed quote together. So:

- a change of price, tax rate or tax status flips the key, with no input changed;
- the same inputs and the same catalogue give the same key.

The second point is the counter-case the stateful flow standard requires: going back and changing nothing keeps
everything, and costs no revision.

### 3.4 Routes

All are on the storefront host, strict zod bodies, intentions only.

| Route | Does |
|---|---|
| `POST /api/commerce/checkouts` `{ lines }` | Creates, prices. 201 `{ checkoutId, token, revision, quote, quoteKey }` |
| `GET /api/commerce/checkouts/<id>` | Reprices and answers. A stored quote is never trusted |
| `PUT /api/commerce/checkouts/<id>` `{ revision, lines?, buyer?, delivery?, shippingOptionId?, codes? }` | Writes inputs, reprices, bumps `revision` if anything changed. 409 `revision_conflict` when `revision` is stale |
| `POST /api/commerce/checkouts/<id>/place` `{ revision, quoteKey }` | Section 3.5 |
| `POST /api/commerce/checkouts/<id>/retry` | From a placed checkout whose payment closed: section 3.6 |

`POST /api/commerce/orders` goes when the storefront has moved. Pre-launch rules allow that, and two write seams would be
a defect. `POST .../pay` keeps its job, minus `buyer`, which is fixed at place because tax depends on it.

### 3.5 Place

First, outside the lock, the per-company sweep of section 1.9, as the orders route does today. Then in one
`READ COMMITTED` transaction, on the existing path:

1. Lock the checkout `FOR UPDATE`. Placed with this key: answer its order (a double click). `expired`, or past
   `expires_at`: 410.
2. `revision` stale: 409. No complete `buyer`: 422 `buyer_required`, since the pay route no longer takes one.
3. `priceCart` again, in the transaction. If the key differs from `quoteKey`: 409 `quote_changed` with the new quote.
   Nothing is reserved, and the buyer confirms the new total.
4. The order path as today, under `request_id = checkout:<id>`: insert order and lines, reserve, open the payment, emit
   `order.placed`.
5. Set `placed`, `placed_at` and `order_id`.

A shortage aborts everything, as today, and answers 409 with `shortages`, leaving the checkout open, so the buyer can
change quantities and go on.

`createOrder`'s body becomes `placeOrderInTransaction(trx, tgId, cart)` so step 4 runs inside this transaction.

The buyer goes to `order_payment.buyer`. Delivery goes to a new `order_payment.delivery` JSONB column, added in B12, not
into `buyer`: `buyerSchema` is `.strict()` and `readBuyer` throws on an unknown key [code], so a `delivery` key there would
fail every receipt and letter of those orders. Rank 3's shipping rows replace the column's use.

### 3.6 The rule for derived state

Per `knowledge-base/standards/stateful-flow-testing.md`, what depends on an input is keyed to it:

- **A changed input** reprices everything. A shipping option no longer offered for the new country clears
  `shipping_option_id`; a code that no longer applies is removed. Both are stated in the answer's `notices`, so nothing
  vanishes silently.
- **Resume.** The browser keeps `{ checkoutId, token }` per site, in `localStorage` in a try/catch. On load it sends
  `GET`. An expired or missing checkout starts fresh from the cart: its typing is gone by design. A browser cart that
  differs from `lines` is sent by `PUT`: the cart is the buyer's truth for what they want. A lost token only means a new
  checkout.
- **Re-entry.** A placed or expired checkout is never reopened. After a failed or expired payment the client calls
  `retry`, which keeps the buyer's typing and reprices. It answers `retried_into` if already called, so it is idempotent.
  It refuses while the order's payment is `pending` or `paid`: that buyer goes back to pay, because two payable orders
  must never exist. It refuses a wiped checkout. The browser cart stays until a payment succeeds, as it does now.

## 4. The order total identity and one tax computation

### 4.1 The identity

For an order `O` with lines `L`, money in integer cents:

```
L.list_amount     = L.unit_price * L.quantity
L.discount_amount in [0, L.list_amount]
L.subtotal, L.tax_amount from priceDocument, on base = L.list_amount - L.discount_amount
O.subtotal        = sum(L.subtotal)
O.tax_amount      = sum(L.tax_amount)
O.total           = O.subtotal + O.tax_amount          -- order_total_sum_check, unchanged
order_payment.amount = O.total                         -- when O.total > 0
```

`order_line_item` gains `line_kind` (`item` or `shipping`, default `item`) and `discount_amount` (default 0, with a CHECK
against the line's amount computed in `bigint`, since `unit_price * quantity` can overflow an integer). The accounting
identity and every money floor stay, and no negative amount appears. Under `gross` the base is gross and `computeLineTax`
extracts the tax, as it does now.

- **A discount folds into lines, in exact cents.** The research's rule: no negative lines, and order-level or line-level
  makes no legal difference while the per-rate result is right. This also tells a refund exactly what each line sold for,
  which rank 6 needs.
- **Shipping is an order line, one per rate.** `line_kind = 'shipping'`, quantity 1, no variant, no stock. It must carry an
  explicit rate: with a null `tax_class`, `resolveLineRate` would silently give 19 percent [code]. The existing
  `reservedStock` query does not see it, since no stock movement points at it.
- **Order of application** (research, discount rule 6): line discounts, cart discount, shipping allocation, tax.
- **The split** uses largest remainder, so parts sum exactly. The research recommends gross value of shipped lines after
  discount. In a net shop tax comes after allocation, so those weights need a provisional tax; `priceCart` computes them
  and passes plain weights. That is one function argument, stored on the order in rank 3, and its adviser question stays
  open.

A deferred constraint trigger (BK021, at commit, like 002's transfer balance) checks that the lines sum to the order.
Today only `total = subtotal + tax_amount` is enforced by the database; nothing ties the header to the lines [code].

**What actually detects an error.** `total = subtotal + tax_amount` always holds because `total` is built as that sum,
under any rounding rule, so it cannot catch a wrong figure. The checks that can are `total` against the quote the buyer
confirmed (`quote_key`), the per-rate buckets against Books (section 4.3), and BK021.

### 4.2 One function

```ts
// src/server/tax/priceDocument.ts: pure, no database, beside germanVat.ts
export type PriceLineInput = {
  ref: string;
  listAmount: number;       // in the document's basis
  discountAmount: number;
} & (
  | { kind: 'item'; taxClass: 'standard' | 'reduced' | 'zero' | null; explicitRate?: number }
  | { kind: 'shipping'; explicitRate: number }            // never defaulted
);
export interface PricedDocument {
  lines: Array<{ ref: string; net: number; tax: number; gross: number; rate: number; treatment: TaxTreatment }>;
  buckets: Array<{ rate: number; treatment: TaxTreatment; net: number; tax: number }>;
  subtotal: number;
  taxAmount: number;
  total: number;
}
export function priceDocument(lines: PriceLineInput[], ctx: LineTaxContext): PricedDocument;
export function allocateLargestRemainder(amount: number, weights: number[]): number[];
```

`priceCart` and Books' `deriveLine` plus `summarize` both go through it, keeping the "one semantic, one implementation"
rule of `germanVat.ts`.

**Rounding.** It starts per line, exactly as today, so the slice that introduces it changes no figure. The research
recommends per rate with allocation to lines, because the European e-invoice standard (EN 16931) calculates per rate and a
line carries no tax amount there, and a customer can recompute it from the printed totals. Under that rule the identity
above still holds, because allocation makes line taxes sum to the document's. Whichever is chosen, it is one rule in this
function and not a per-company option. Issued documents are frozen, so it affects only new ones.

**Rank 3 is gated on this decision.** The two rules differ on ordinary carts, and separate shipping lines make it likelier:

| Case | Per line | Per rate |
|---|---|---|
| Research's example with a 10.00 code, 7 percent bucket (goods 16.00 plus shipping 1.96, gross) | 1.05 + 0.13 = 1.18 | 1.17 |
| Same, 19 percent bucket (24.00 plus 2.94) | 3.83 + 0.47 = 4.30 | 4.30 |
| Same, total tax | 5.48 | 5.47 |
| Net shop, 3 lines of 1.33 at 19 percent, total tax | 0.75, gross 4.74 | 0.76, gross 4.75 |

Per-line rounding printed against the research's own table disagrees by a cent, and in a net shop the buyer's total itself
changes. So shipping does not start until Marlin has decided (research decision 3, after adviser question 3), and the
research recommends switching in the same change. A gross-advertised shipping price in a net shop can also miss by a cent,
because some gross amounts cannot occur at 19 percent under the net rule (3.91, 3.98, 4.98). Rank 3 must say which price is
stored.

### 4.3 Books copies a shop order

The research's table of what must agree:

| Item | Rule | From |
|---|---|---|
| Gross total | Equal to the cent, equal to the payment | B11 |
| Net and tax per (rate, treatment) | Equal, compared at receipt | B11 |
| Rate on each line | Copied from the order, never re-derived | B11 |
| Shipping lines and discount amounts | Copied | B11 |
| Tax profile | Decided once, at checkout, passed to Books | B14 |

Today `receipt.ts` re-derives from `tax_class`, re-resolves the profile from the buyer, and compares only the total [code].

**B11:**

- `sales_document_line` gains `discount_amount` (cents), beside `discount_bp`, with a CHECK that a line uses at most one.
  `discount_bp` cannot express an allocated amount. The research adds that this also serves roadmap item 8c, the
  whole-invoice discount.
- `ensureReceipt` copies each line's rate, discount and amounts, shipping lines included.
- The check becomes total and per-rate buckets. A mismatch stays `TOTALS_MISMATCH`, a `JobRefused`: it will not heal.
- **The profile is compared, not copied.** Before B14 the order is a poor source: the route never sets `customerType` or
  `vatId`, so it always says `b2c` with no VAT id, while `customerFor` builds a `b2b` customer [code]. So Books resolves
  its profile as today, and `ensureReceipt` compares the two by effect: `reverseCharge`, `kleinunternehmer` and
  `supported`, not by key, so a German business buyer still gets a receipt. A disagreement is `TAX_PROFILE_MISMATCH`, a
  `JobRefused`, with a stable code.
- This keeps today's loud failure. If Books simply copied the order's German profile, an Austrian business buyer who fails
  today would get an invoice with German VAT, wrong under the research's finding 1, and a Swiss buyer one that is unverified
  for an export.
- The printed note stays from settings: `order.tax_note` holds the constant `KLEINUNTERNEHMER_NOTICE`, not the company's
  `exemptionNote` [code], so copying it would change a small business's invoice.

**B14** then makes the order the source: `createDraft`, `issue` and `syncDraftTaxState` use the order's frozen profile for
a document with `source_order_id`, in place of `profileFor(settings, customer)`.

`priceCart` must apply `convertUnitPrice` as Books does: `createOrder` charges a gross price unchanged under reverse charge
[code]. That path is unreachable today, so B10 changes no figure.

### 4.4 The tax profile at checkout

In B14, `shopTaxProfile` becomes `checkoutTaxProfile(db, companyId, { buyer, delivery })`, which calls `resolveTaxProfile`
with the delivery country. The result lands in the quote and on the order (`customer_type`, `vat_id`, `reverse_charge`,
`kleinunternehmer`, `tax_note`), from which Books takes it, and `order.tax_region` becomes the delivery country instead of
the constant `DE`. Until this switch every order stays `DE`, because it is taxed as German.

The research establishes why this has to happen, and why it is not enough alone:

- **Live fault** (read, not reproduced): a regular-taxed company selling to an Austrian business with a VAT id charges German
  VAT, then `ensureReceipt` throws `TOTALS_MISMATCH`, and a Swiss buyer ends in `TAX_CASE_UNSUPPORTED`. Either way the money
  is taken and no invoice exists. Until B14 these end as dead `receipt_issue` jobs a person can see.
- **`resolveTaxProfile`'s reverse-charge branch is wrong for goods.** A parcel to an EU business is a tax-free
  intra-Community supply, with its own note, proof and reporting, not paragraph 13b reverse charge. So the shop must not reach
  that branch for goods. The treatments needed belong to rank 12.

**Decision, subject to Marlin.** B14 takes the research's recommendation: delivery to Germany only, by default, so the quote
refuses any other country with `destination_not_supported`, before payment. A buyer delivering to Germany who gives a foreign
VAT id is treated as domestic, because place of supply follows delivery [inference, adviser question 7]. B14 waits for
Marlin's review. Everything else in sections 3 and 4 is indifferent to the answer, because no figure changes while every order
is domestic.

### 4.5 What is left to the rank plans

Shipping rates, discount computation, `payment_refund` rows, the order discount snapshot and receipt-at-dispatch are specified
in the research's section 8 and belong to ranks 3 to 7. This backbone gives them `line_kind`, `discount_amount`,
`allocateLargestRemainder`, one registry line for the receipt trigger, and the checkout columns.

## 5. Slices

Sixteen, not the four the fleet plan assumed. Every change here touches money or a migration, so they run in series, which
adds about 12 slices to the fleet's total of about 70.

Every slice: branch from `origin/main`, the suite green before and after, a tenant migration takes the next free number, is
registered in `migrations/tenant/index.ts`, and updates `db-types.ts`, `provision.itest.ts` and, for a new table,
`checkGuards.test.ts`. New SQLSTATEs start at BK021. Slices touching a route run `pnpm test:integration`.
`shared_state: [migrations, docs-shop]` keeps them serial. Every slice that adds a job kind tests it with two companies in one
group.

Test plans name the four paths of the stateful flow standard: **F** forward, **B** backtrack and revise, **R** resume, **E**
re-entry after completion or failure.

**Needs Marlin** follows the fleet plan: only money, security and production. Those slices also get the fleet's review.
Eleven need his review (B3 to B8 without B3R, B10 to B14), four a one-line yes (B0, B2's timer, B3R, B9), and B1 nothing.

### B0: scope order keys to the company

- **Files:** a migration, `db-types.ts`, `repository/order.ts`, `repository/storefront.ts`, `order/createOrder.ts`,
  `api/commerce/orders/route.ts`, `order/__tests__/createOrder.isolation.itest.ts`.
- **Does:** `order_request_id_key` is on `request_id` alone, and `findByRequestId` and `readOrderTotal` have no `tenant_id`
  filter [code]. A request reusing another company's key in the same tenant group is answered with that company's order id,
  number and total [inference, not reproduced]. Keys are random (`CheckoutButton.tsx`), so someone would need another buyer's
  key, but it is a read across companies. Both reads filter, and the index becomes `(tenant_id, request_id)`.
  `isOrderRequestIdConflict` matches the new name.
- **F:** a repeat within a company answers the same order.
- **B:** two companies using one key each get their own order.
- **R:** a concurrent duplicate within a company still resolves to the winner.
- **E:** a foreign key never returns a foreign id or total; the migration is re-runnable.
- **Needs Marlin:** yes, as tenant isolation and a production migration. One line, with backup and rollback stated. Runs
  first, and blocks nothing else.

### B1: the job table and engine

- **Files:** `migrations/tenant/025_commerce_job.ts`, `index.ts`, `db-types.ts`,
  `src/server/commerce/jobs/{types,emit,claim,run,consumers}.ts`, `jobs/__tests__/`, `checkGuards.test.ts`, `provision.itest.ts`.
- **Does:** sections 1.2 to 1.6, with one test kind. Nothing calls it.
- **F:** emit in a transaction, claim, run, `done`.
- **B:** a rolled-back transaction leaves no job; a repeated dedupe key writes one job.
- **R:** two concurrent claimers on real Postgres never get one job. A killed worker's job is claimed again after its lease. A
  stale token changes nothing. An unknown kind is left alone.
- **E:** a job past give-up goes `dead`; give-up counts from `cycle_started_at`, so an old recurring job survives one failure;
  three unfinished claims go `dead` from the claim; `requeueJob` and `acknowledgeJob` work.
- **Needs Marlin:** no.

### B2: the worker and its watchdog

- **Files:** `jobs/runtime.ts`, `jobs/backfills.ts`, `src/instrumentation.node.ts`,
  `src/app/api/internal/commerce/jobs/run/route.ts`, `deploy/commerce/framer-clone-commerce-jobs.{service,timer}`,
  `deploy/README.md`.
- **Does:** section 1.7, beside the existing sweeps.
- **F:** a pass runs due jobs across two tenant groups, including one with no site left.
- **B:** a group whose table is missing is skipped; a failing group stops no other.
- **R:** overlapping passes run a job once; a pass after a restart picks up what was due; a job started late has a fresh lease.
- **E:** the route answers 500 on a late job and a failed pass, and 200 with a count on a dead one.
- **Needs Marlin:** no for the code. Installing the timer is a production machine change: one line.

### B3: expiry job, beside the old sweep

- **Files:** `order/createOrder.ts`, `payment/payments.ts`, `payment/provider.ts`, `payment/expiryJob.ts`, `jobs/consumers.ts`,
  `jobs/backfills.ts`, `orders/[orderId]/pay/route.ts`.
- **F:** order placed, job written, window passes, stock released.
- **B:** a rolled-back order leaves no job; paying before the window makes the job do nothing; `requireDue` writes no
  `payment_event` on a paid order, proven against the race with a concurrent pay.
- **R:** the backfill covers an order the old build wrote; a job failing keeps the stock held and retries.
- **E:** a late success after expiry still takes its path; a closed payment's job is a no-op.
- **Needs Marlin:** yes, it releases stock.

### B3R: remove the old expiry path

- **Files:** Removed: `payment/expirySweep.ts`, `internal/commerce/expired-payments/`, the two systemd units, and the expiry
  backfill. `deploy/README.md`.
- **F:** expiry runs on jobs alone.
- **B:** n/a, removal only.
- **R:** a deploy after this has no gap, because B3 has been live and the backfill has run: wait for one hourly backfill
  after the old container is gone, since it is what covers an order that container placed after the worker's first pass.
- **E:** the watchdog still reports lateness.
- **Needs Marlin:** yes, one line: uninstall the units on `coolify-shared-host` first, then deploy, so the unit does not fail
  on a 404.

### B4: receipts become a job

- **Files:** `payment/payments.ts`, `payment/receiptJob.ts`, `payment/deps.ts`, `jobs/consumers.ts`, `jobs/backfills.ts`,
  `api/payments/stripe/webhook/route.ts`, `orders/[orderId]/pay/route.ts`, `payment/__tests__/`.
- **F:** paid, job written with the status change, receipt, `receipt.issued`.
- **B:** a failed status transaction leaves no job.
- **R:** the Books down at first attempt: the webhook still answers 200, the job issues later, `paid_on` stays the payment's
  day; the backfill picks up a paid order with no receipt from before this slice.
- **E:** repeat delivery on a paid order writes no second job; `TOTALS_MISMATCH` is `dead` and visible; a job on a payment no
  longer `paid` is `done`; a link updating zero rows emits nothing; a demo pay response still carries `receipt`.
- **Needs Marlin:** yes, it changes the webhook's answer and `handlePaymentEvent`.

### B5: mail becomes a consumer

- **Files:** `mail/outbox.ts`, `mail/runtime.ts`, `mail/lumitraMail.ts`, `mail/connection.ts`, `payment/payments.ts`,
  `src/instrumentation.node.ts`, `jobs/consumers.ts`, `jobs/backfills.ts`, `mail/__tests__/shopMail.itest.ts`.
- **F:** `receipt.issued` writes letter and job, sent.
- **B:** a company not connected writes neither.
- **R:** Lumitra Mail down retries with the same frozen letter and key; a letter the old build wrote gets a job from the
  backfill.
- **E:** a reconnect to another workspace rebuilds as today; `blocked` is `done`; a refusal is `failed` and `dead`; owner
  failures still count on the payments page.
- **Needs Marlin:** yes under the fleet plan, because it edits `payments.ts`, though only at call sites.

### B7: pin the Stripe session

Runs before B6: B6 needs its sandbox proof.

- **Files:** migration on `order_payment` and its guard, `db-types.ts`, `payment/stripe/client.ts`, `payment/stripe/connect.ts`,
  `payment/provider.ts`, `payment/payments.ts`, `orders/[orderId]/pay/route.ts`, `payment/expiryJob.ts`,
  `stripe/__tests__/stripe.test.ts`.
- **Does:** sections 2.1 and 2.5. The sandbox proof comes first, reproducing the key refusal.
- **F:** first pay pins, stores, redirects.
- **B:** a buyer back from Stripe gets the same session and URL; a declined attempt keeps the payment pending and the session
  payable; a buyer change after pinning is refused.
- **R:** a crash between pin and store sends identical parameters, proven by comparing request bodies, also after 5 minutes,
  and past the margin the payment closes rather than opening a second session.
- **E:** a `complete` session on a later pay and in the expiry job applies the success; an expired one closes; the job follows
  the moved date; Stripe unreachable delays the close at most 60 minutes; a pin on a payment past `expires_at` is refused.
- **Needs Marlin:** yes. The operator proves it with a sandbox purchase, including going back and paying again.

### B6: the late refund leaves the transaction

- **Files:** `payment/payments.ts`, `payment/lateRefundJob.ts`, `payment/stripe/client.ts`, `jobs/consumers.ts`,
  `payment/__tests__/`.
- **F:** a late success with no stock: second transaction, job, refund, `refunded`, letter.
- **B:** stock available: `reserveAgain` wins and no job is written; a partial re-reservation is undone.
- **R:** a crash after the provider call repeats with the same key and one refund, proven against a fake that counts calls; the
  id from the event is on the row.
- **E:** a concurrent delivery that decided it first; provider failure retries; `charge_already_refunded` is success and finds
  the refund; a status that moved raises a finding; a provider that keeps refusing is `dead`.
- **Needs Marlin:** yes.

### B8: Stripe reconciliation

- **Files:** migration for `payment_finding`, `db-types.ts`, `checkGuards.test.ts`, `payment/stripe/client.ts`,
  `payment/stripe/webhook.ts`, `payment/reconcileJob.ts`, `payment/stripe/connect.ts`, `jobs/consumers.ts`, `jobs/backfills.ts`,
  `api/payments/stripe/webhook/route.ts`, tests.
- **Does:** sections 2.2, 2.3 and 2.5. The sandbox proof comes first.
- **F:** a succeeded event with no webhook is applied, then a receipt follows.
- **B:** an amount mismatch or foreign metadata writes one finding and changes nothing; a failure then a success in one window
  ends paid with no refund; an event without platform metadata and our own refund write nothing.
- **R:** the cursor moves only after the whole window; a failed page repeats it; overlap re-reads harmlessly; a transient error
  never kills the job.
- **E:** a real webhook after a replay is a duplicate, and the reverse; a stale cursor raises its finding; a disconnected account
  ends it, and connecting again restarts it.
- **Needs Marlin:** yes. The operator proves it on a connected sandbox account, with a delivery deliberately missed.

### B9: drop mail's old columns and the backfills

- **Files:** a migration, `db-types.ts`, `mail/outbox.ts`, `mail/connection.ts`, `jobs/backfills.ts`.
- **Does:** removes `attempts`, `next_attempt_at`, `last_error` and their index after B5 has been deployed. The owner surface
  reads the job's reason instead. Removes the receipt, mail and reconcile backfills.
- **F:** letters flow after the drop.
- **B:** n/a, a schema change only.
- **R:** the migration is re-runnable.
- **E:** owner failure counts read the job's reason.
- **Needs Marlin:** yes, destructive on production: one line, with backup and rollback stated.

### B10: `priceDocument` and the identity columns

- **Files:** `src/server/tax/priceDocument.ts`, its tests, `order/createOrder.ts`, `order/priceCart.ts`, `books/totals.ts`, a
  migration for `line_kind`, `discount_amount` and BK021, `db-types.ts`.
- **Does:** sections 4.1 and 4.2 with per-line rounding. No figure changes.
- **F:** every existing `createOrder` and Books total test passes unchanged, plus property tests of the identity on random
  carts in both bases.
- **B:** a line edited in a Books draft recomputes through the function.
- **R:** BK021 refuses a commit whose lines do not sum, with the correct order passing.
- **E:** allocation sums exactly for zero weights, one line and many lines; a zero-rate line; a small business; a shipping line
  without a rate does not type-check; the `bigint` CHECK at the largest quantity.
- **Needs Marlin:** yes.

### B11: Books copies a shop order's lines

- **Files:** a migration for `sales_document_line.discount_amount`, `books/repository/lines.ts`, `books/totals.ts`,
  `payment/receipt.ts`, `payment/receiptJob.ts`, `render/` where a line's discount prints, tests.
- **Does:** section 4.3, B11 part.
- **F:** a receipt with a shop-supplied line discount and shipping line equals the order per rate.
- **B:** an editor invoice is untouched, and `discount_bp` still works; a German business buyer still gets a receipt.
- **R:** an Austrian business and a Swiss buyer stay refused, now `TAX_PROFILE_MISMATCH`, and no invoice is issued.
- **E:** a tampered total is `TOTALS_MISMATCH`; a small business keeps its own note; a retry rebuilds a left-over draft.
- **Needs Marlin:** yes, it changes what an invoice shows.

### B12: the checkout record, server side

- **Files:** a migration for `checkout` and `order_payment.delivery`, `db-types.ts`, `checkGuards.test.ts`,
  `src/server/commerce/checkout/{repository,quote,place,expireJob}.ts`, `order/createOrder.ts`,
  `src/app/api/commerce/checkouts/**`, `jobs/consumers.ts`, company erasure.
- **Does:** section 3, beside the existing orders route, with the tax profile as today.
- **F:** create, set buyer, place, pay with the existing route, and a receipt for that order, with delivery on its own column.
- **B:** a changed quantity or address changes quote and key; the same input keeps both and the revision; an option or code that
  no longer applies is cleared with a notice; a stale revision is 409.
- **R:** `GET` after a price change reprices; place with the old key is `quote_changed`, reserving nothing; place after
  `expires_at` is 410; a wrong token is 404; expiry wipes buyer data of an open checkout, and of a placed one 7 days later.
- **E:** double place answers one order; place with no buyer is 422; a shortage leaves the checkout open; `retry` after a failed
  payment makes one new checkout however often it is called; `retry` on a pending or paid order and on a wiped checkout is refused;
  a placed checkout refuses `PUT`.
- **Needs Marlin:** yes, it writes orders.

### B13: the storefront moves, the old route goes

- **Files:** `src/lib/renderer/commerce/CheckoutButton.tsx`, `src/lib/commerce/payment/storefrontGateway.ts`, a client checkout
  module, `orders/[orderId]/pay/route.ts`. Removed: `api/commerce/orders/route.ts`, with `middleware.ts`, `storefrontTenant.ts`
  comments and its tests moved.
- **Does:** POST checkout, PUT changes, POST place. The confirmation shows the quote's total. `buyer` leaves the pay route.
- **F:** browser cart to paid order, demo and sandbox.
- **B:** back from the payment step, change a quantity, the total changes, and the old `placedRef` logic is gone.
- **R:** a reload at each step restores it; a cart changed in another tab wins.
- **E:** a declined payment offers retry with the buyer's typing kept; a finished order clears the cart, and a new checkout starts
  clean.
- **Needs Marlin:** yes. The operator proves it on production with a test purchase after deploy.

### B14: tax follows the destination

- **Files:** `payment/shopTax.ts` (renamed `checkoutTax.ts`), `checkout/quote.ts`, `books/repository/documents.ts`, `books/issue.ts`,
  `payment/receipt.ts`, tests.
- **Does:** section 4.4 on Marlin's answer, and the order's frozen profile from section 4.3. The refusal of B11 ends here.
- **F:** a German delivery prices as today.
- **B:** changing the country to one not offered refuses before payment, and changing it back recovers.
- **R:** a saved checkout for a country no longer offered is refused on resume; a company's tax status changed between order and
  receipt keeps the order's profile.
- **E:** a German delivery with a foreign VAT id gets a receipt that matches.
- **Needs Marlin:** yes, and it waits for the VAT review.

### Order

B0 first. Then B1, B2, B3, B3R, B4, B5, B7, B6, B8, then B10 to B13, then B14. B9 runs once B5 and B8 have been live for a while. B3R
waits one deploy after B3. B10 and B11 can run while B6 to B8 wait for review, since they touch other files. Rank 3 stays behind
Marlin's rounding decision, and ranks 5 and 6 behind the VAT review.

## 6. Open questions

**For Marlin** (each has a default in the text):

1. **B0's yes.** The tenant filter and index change: one line, as a production migration.
2. **The live fault, now.** A foreign VAT id or address today means money taken and no invoice. The research recommends a small
   immediate fix: refuse such a buyer at the pay route for regular-taxed companies, independent of this plan, since the backbone
   reaches it only at B14. It is one small slice. Its urgency depends on whether real payments run: the last purchases on record
   were sandbox ones (`stripe/client.ts`), and I did not check which keys production holds.
3. **Delivery countries at launch** (research decision 1, assumed by B14): Germany only by default.
4. **Per-rate rounding** (research decision 3, section 4.2): when, after the adviser. Rank 3 waits for it.
5. **Receipt at dispatch or payment** (research decision 2): one registry line plus a service date, and it ties ranks 3 and 4
   together.
6. **The research itself.** It lists 14 questions for a tax adviser. Shipping split, cart discount and rounding are the three this
   plan's identity leans on most, though the identity holds under any answer.
7. **How he hears about dead jobs.** A count on the route, a log line and the owner page. With the route no longer red on a dead
   job, nothing pushes it to him. A second monitor on that count is the simple answer if he wants one.

**Unproven:**

8. **All Stripe behaviour in section 2.5,** until the sandbox proof.
9. **The cross-company read in B0** is read from the code, and the review confirmed the code, but nobody has reproduced it.
10. **Scale of the per-group pass,** section 1.7. Estimated, not measured.
11. **Replica count.** Irrelevant to safety under the lease, but `SlidingWindow` limits are per process, so several copies would
    loosen the checkout rate limit.
12. **The planner behaviour behind `MATERIALIZED`.** Adopted as the safe form, not observed.

**Deliberately left out:**

13. **A free order.** `createOrder` opens no payment when `total` is 0, and the amount CHECK forbids one, so a 100 percent discount
    would have no payment, receipt or mail [code]. Rank 5 must decide; nothing reaches it today.
14. **Disputes and dashboard refunds** only raise findings until rank 6.
15. **After a deploy rollback,** jobs of a kind the older build does not know stay pending by design, and the watchdog's lateness
    warning fires until the newer build is back.
16. **Who reads findings and dead jobs for a company.** Until the order list exists, an owner sees counts on the payments page.
17. **Losses older than the first cursor** (section 2.2) are a one-off operator check, not automatic.

## Review findings not adopted

All of H1 to H8, M1 to M14 and the low findings are in the text, except where stated here. H4, H7, H8, M5, M6, M9 and M10 were
checked against the code and hold. Findings about Stripe behaviour are adopted and marked unverified.

- **H2, `maxAttempts` in the policy.** Replaced, not ignored. A count of all attempts cannot separate a crash from an ordinary
  failure: a receipt legitimately retries about 120 times in 30 days, so that limit would allow 120 app restarts, and a lower one
  would cut the retries the policy wants. `open_claims` counts only claims that never finished, and the claim enforces it, which
  is the review's actual requirement.
- **H4, a separate removal deploy for the mail sweep.** Not needed. `sweepShopMail` goes in B5 itself: running it beside the jobs
  would have two owners of one row's schedule, and the backfill covers what the old build writes. Expiry does get B3R, because its
  removal includes an installed host unit.
- **H3, a timeout for `ensureReceipt`.** Provider calls get a real signal. `ensureReceipt` does not: it spans Books transactions
  and a PDF render, and aborting it partway is riskier than the outcome the review itself prices at a failed attempt and an orphaned
  PDF. The lease is long enough that this needs a stall of minutes.
- **M4, a new key namespace.** Rejected, as the review itself does: it opens a second payable session.
- **M12.** Moot: with `commerce_event` gone, no new table is append-only, so `APPEND_ONLY_TABLES` and `provision.ts` are untouched.
- **M1, the final status.** Adopted, with one narrowing: the final close of such a payment is `expired`, not `failed`, with
  the failure code kept, since the session's end is what closed it.

## Reality

- 2026-11-02: contract only, no product code. Read against `origin/main` at `e98a306`.
- 2026-11-02: revised after the independent review, rebased on `b556d0c`. Operator decisions applied: `commerce_event` dropped, B11
  keeps refusing on a profile disagreement until B14, rank 3 gated on the rounding decision, one slice owns the tenant fix, Stripe
  recollection marked unverified, reviews only for money, security and production. The expiry timer is installed on production. A
  roadmap line comes from the operator when this is decided.
- 2026-11-01: B1 built: `commerce_job` (migration 025) and `src/server/commerce/jobs`, nothing calling it. Three additions to the text. `runJobNow`
  takes the tenant id as well (`runJobNow(db, tenantId, jobId)`), because the primary key leads with `tenant_id` and a lookup by id alone would scan the
  table. A handler that ignores its signal is abandoned when its lease ends, so it cannot stall a worker for good; it then counts as an open claim. Both
  registries take an injected value and stay empty in production, so the one test kind lives in the tests.
- 2026-11-01: B2 built: `jobs/runtime.ts`, `jobs/backfills.ts`, the watchdog route and the host units, beside the existing sweeps. The mail sweep stays until
  B5, although section 1.7 says the worker replaces it. Corrections to the text: `commerce_app` could not read `public.tenant_groups`, so the start step now
  grants it `SELECT (id)`, and a failed grant warns instead of failing the start. Decided: the pass covers every status, because `suspended` stops provisioning
  and not a selling shop. The route's answer gains `skipped`, and `findingsOpen` is 0 until B8. A signal stops the claiming, but Next exits without waiting for
  a handler, so a handler in hand at shutdown is cut off and recovers through its lease, as one open claim. The timer is not installed.
- 2026-11-02: B3 built: `payment/expiryJob.ts`, `order.placed`, `requireDue`, the backfill, and the pay route narrowed to its own order, beside the old sweep, route and
  timer, which B3R removes. No tenant migration: `commerce_job` already holds everything. Additions to the text. A handler needs the tenant group's id and handle, because
  `handlePaymentEvent` and the stock writes take them, so `run.ts` builds `PaymentDeps` for `ctx.payments` (section 1.6), and `runNextJob(group, options)` and
  `runJobNow(group, tenantId, jobId, options)` take the handle and id as one `JobTenantGroup`; `jobs/types.ts`, `run.ts` and `runtime.ts` were missing from B3's file list.
  `PaymentEvent.requireDue` also bounds the lock wait (`lock_timeout`, section 1.8) and decides the date in Postgres, so it does not depend on the process running in UTC, and an
  expiry recorded on a payment still pending throws instead of finishing `done` with the stock held. `order.placed` carries
  `expiresAt`. `PaymentOutcome` gains `notDue`, because the job must tell a moved date from a closed payment and that answer has to come from under the lock. `scheduleJob`
  lives in `jobs/schedule.ts`, re-exported by `emit.ts`: a consumer importing `emit.ts` loads the registry before the consumer exists, which left `order.placed` with an
  undefined consumer. B4 must keep that in mind when `payments.ts` starts importing `emit.ts`. Until B7 no payment has a stored session, so the job closes without asking
  Stripe, as the sweep does today, and the order route's per-company sweep still takes every expired payment.
- 2026-11-02: Marlin decided that Stripe payments wait for the Books, so no paid order lacks an invoice (outside the slice list). `payment/receiptReadiness.ts`
  asks what the Issue button would refuse of the company itself (settings, the invoice number series, a sender complete for a domestic invoice); the order route
  refuses a Stripe order with 503 `payments_unavailable` before anything is reserved, the pay route refuses the same way for an order whose Books broke after it was
  placed, and the payments page names what is missing. The demo provider is unchanged. Also built: `sales_document.tax_country` (migration 027), the buyer's country
  stored on a receipt's draft and read in place of the reused customer row's, which closes the namesake case #211 left open (a paid order refused with
  `TAX_IDENTITY_MISMATCH` over the row's country). B11's profile comparison and B14's frozen profile should read the draft's `tax_country`, not the row.
- 2026-11-02: decided after the money review (finding 4), say so if you disagree: the demo checkout is for the demo company only (`payment/demoCheckout.ts`). The
  demo provider moves no money but issues real, numbered invoices, so on any other live shop a visitor could create invoices for sales that never happened. Every
  other shop without a Stripe account that can take payments refuses checkout with 503 `payments_unavailable` before anything is reserved, as it does while its Books
  cannot issue receipts, and a demo order such a shop placed before is refused at pay. The payments page tells that owner the shop takes no orders until Stripe is
  ready.
- 2026-11-02: the second Pay click on a Stripe order, from the money review (finding 5), ahead of B7. `order_payment.checkout_request` (migration 028) keeps the
  first start's email and return address, set once, and fixes the buyer with it (a separate trigger, BK018); the session's end is now the payment window plus 31
  minutes, never the clock. Every later click sends the same request under `checkout:<orderId>`, so Stripe answers the same session, and another buyer is refused
  with 409 `buyer_fixed` before Stripe is asked. B7 builds on this: `session_return_url` and `session_expires_at` become columns of their own then, and this column
  goes or stays in that slice. Cutover: a payment pending at deploy whose session was opened under the old, clock-based end fails its next click until its hold ends
  (at most about an hour), as section 2.1 accepts for B7.
- 2026-11-02: the second Pay click after the second money round (R2-3). `checkout_request` gains `confirmed`: a request is written before Stripe is asked and
  confirmed only once Stripe answered with a session. Until then a click with another buyer replaces it, so a first click that failed at Stripe locks no typo in;
  once confirmed, the request is set once and the buyer fixed (BK018), and another buyer gets 409 `buyer_fixed`. The demo refusal stays the pay route's first
  check. Left open on purpose: Stripe made the session but its answer was lost, then the buyer changed details; Stripe refuses the new request and the route
  answers 500, with nothing charged twice.
