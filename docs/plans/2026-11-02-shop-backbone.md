---
type: plan
status: draft
date: 2026-11-02
title: "Shop backbone: one job table, Stripe reconciliation, a server-side checkout record and one tax computation"
summary: "The design contract every later shop slice builds on. Durable work moves into two tables per tenant schema (commerce_event and commerce_job), claimed with FOR UPDATE SKIP LOCKED under a lease, with no Redis. The expiry sweep, receipt retries and shop mail become consumers of it. A per-company job replays Stripe's event list through the existing payment handler. A checkout record prices shipping and discounts on the server before payment while guest carts stay in the browser. The order total identity stays total = subtotal + tax_amount: discounts fold into lines in exact cents, shipping is an order line per rate, and Books copies the order's frozen figures. Fourteen slices, ten of which touch money or stock and need Marlin's review."
tags: [framer-clone, commerce, outbox, jobs, stripe, checkout, tax, books]
projects: [framer-clone]
---

# Shop backbone

This is the contract for ranks 1 and 2 of the [Medusa analysis](2026-11-01-medusa-architecture-analysis.md)
(sections 3, 5.5 and 6; that file reaches `main` through its own pull request), plus the identity and tax
question of its section 6.3. It specifies, and builds nothing. Marlin decided on 2026-11-01 that the backbone
runs now and that German value-added tax (VAT) is researched first.

**Inputs.** The code on `origin/main` at `e98a306`, the [agent fleet plan](2026-11-01-agent-fleet.md) (reaches
`main` through its own pull request), and the VAT research in
`~/software-dev/decision-pages/2026-11-01-german-vat-research.md`. That research was written by an AI assistant
from public sources, a tax adviser has not reviewed it, and Marlin has not yet reviewed it. Wherever this plan
leans on it, it says so, and nothing with legal effect ships before that review.

**Evidence marks**, as in the Medusa analysis: **[code]** read here, **[inference]** concluded from code,
**[unproven]** not established, and listed under open questions.

Short forms: VAT (value-added tax), API (application programming interface), SQL (Structured Query Language),
JSON (JavaScript Object Notation), PDF (Portable Document Format), SEPA (Single Euro Payments Area, delayed bank
payments), B2B and B2C (business to business, business to consumer), GDPR (General Data Protection Regulation).
"Tenant group" is one `tg_<id>` database schema; "company" is `tenant_id` inside it. "Books" is the invoicing
domain in `src/server/books`.

## Decided here, say so if you disagree

1. **Two tables, not three.** The analysis proposed `commerce_event`, `commerce_delivery` and `commerce_job`. A
   delivery and a timed job have the same columns and the same claim, so both are rows of `commerce_job`.
   `commerce_event` stays as the append-only record of what happened.
2. **Fan-out at write time.** `emitCommerceEvent(trx, ...)` writes the event and its jobs in the caller's
   transaction. There is no dispatcher that could fall behind or lose a consumer.
3. **At-least-once, always.** A lease replaces any notion of exactly-once, and every handler is idempotent by a
   named mechanism (the table in section 1.8).
4. **The worker runs inside the app,** one poller per process, every 30 seconds. The host timer stays as a
   watchdog, not as the driver.
5. **A delay is scheduled, not swept.** An order's expiry is a job written with the order, due at `expires_at`.
6. **The webhook stops carrying the receipt.** It answers 200 once the payment commits. A receipt no longer
   depends on Stripe delivering again.
7. **A late refund leaves the database transaction.** The provider call moves into a job, which follows the rule
   in section 7 of the analysis: write the intent, then call the provider with an idempotency key.
8. **Reconciliation replays Stripe's own event list** through `handlePaymentEvent`, so there is no second state
   machine. It applies payment outcomes by itself. It never applies a refund or dispute made outside the
   platform: those become findings for a person.
9. **The Stripe session is pinned once** (id, expiry, return address) and the stock hold is moved to match it.
   Section 2.1 explains the defect this closes.
10. **Stock is still reserved at place, not during checkout.** An abandoned checkout holds nothing.
11. **The checkout's quote is a JSON snapshot; the order's rows stay relational.** A quote is rewritten on every
    change and read only as a whole.
12. **The identity does not change.** `total = subtotal + tax_amount` stays, with no negative lines. This follows
    the VAT research, section 3.
13. **Books copies a shop order's figures.** A receipt takes the order's tax profile and line amounts, so the two
    cannot disagree. Books still calls the same pure function for its own invoices.
14. **Rounding stays per line until Marlin decides.** `priceDocument` makes per-rate rounding a change in one
    function, for new documents only.

## 1. One outbox and job table on Postgres

No Redis, no queue library, no saga engine. The analysis (6.1) gives the reasons: a transactional write is the
property those would lack, and the shop host runs one schema per tenant group [code].

### 1.1 What is replaced

| Today | Who decides retry and timing | Weakness |
|---|---|---|
| `shop_mail` (migration 023) | `setInterval` per process, `mail/runtime.ts`, only when Lumitra Mail is configured | Reads rows, then sends: no claim, so two copies can both attempt one letter (the mail key makes that harmless) [code] |
| Receipt retry | Stripe redelivering a webhook that answered 500 (`stripe/webhook/route.ts`) | Stops when Stripe stops. A demo payment has no retry at all, since nothing redelivers it [code] |
| Expiry | Host timer plus a sweep on each order and pay (`expirySweep.ts`, `payments.ts`) | The file's own comment calls it a stopgap for a job table [code] |
| Late refund | The webhook's redelivery, with the provider call inside a database transaction (`refundLatePayment`) | Holds a row lock across a network call; if the refund keeps failing, redelivery ends with the buyer charged and the order closed [code, inference] |

### 1.2 Tables

Both live in every `tg_<id>` schema, added through the tenant migration set, so provisioning and
`migrateAllTenants` carry them and `pg_dump -n tg_x` still extracts one customer whole. House style as 023: bare
names, ids `TEXT` minted by the application, `TIMESTAMP(3)`, re-runnable.

```sql
CREATE TABLE "commerce_event" (
  "id"          TEXT NOT NULL,
  "tenant_id"   TEXT NOT NULL,
  "type"        TEXT NOT NULL,
  "payload"     JSONB NOT NULL,             -- ids only, never personal data
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "commerce_event_pkey" PRIMARY KEY ("tenant_id", "id"),
  -- tenant_id uuid CHECK as every table; jsonb_typeof(payload) = 'object'; length(payload::text) <= 2000
);
-- append-only: trigger raising BK021 on UPDATE, DELETE, TRUNCATE, plus REVOKE from commerce_app, as payment_event

CREATE TABLE "commerce_job" (
  "id"           TEXT NOT NULL,
  "tenant_id"    TEXT NOT NULL,
  "kind"         TEXT NOT NULL,
  "dedupe_key"   TEXT NOT NULL,
  "event_id"     TEXT,                      -- the event this delivers; null for a directly scheduled job
  "payload"      JSONB NOT NULL,            -- ids and cursors only
  "status"       TEXT NOT NULL DEFAULT 'pending',   -- pending | running | done | dead
  "run_at"       TIMESTAMP(3) NOT NULL,     -- when due; while running, when the lease ends
  "attempts"     INTEGER NOT NULL DEFAULT 0,
  "claim_token"  TEXT,                      -- fences a worker whose lease ran out
  "last_error"   TEXT,                      -- at most 1000 characters, no personal data, no secrets
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  "finished_at"  TIMESTAMP(3),
  CONSTRAINT "commerce_job_pkey" PRIMARY KEY ("tenant_id", "id"),
  CONSTRAINT "commerce_job_dedupe_key" UNIQUE ("tenant_id", "kind", "dedupe_key"),
  CONSTRAINT "commerce_job_event_fkey" FOREIGN KEY ("tenant_id", "event_id")
      REFERENCES "commerce_event" ("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT
  -- status CHECK; attempts >= 0; last_error length; running needs a claim_token; dead and done need finished_at
);
CREATE INDEX "commerce_job_due_idx"  ON "commerce_job" ("run_at")                   WHERE "status" IN ('pending', 'running');
CREATE INDEX "commerce_job_dead_idx" ON "commerce_job" ("tenant_id", "created_at")  WHERE "status" = 'dead';
CREATE INDEX "commerce_job_done_idx" ON "commerce_job" ("finished_at")              WHERE "status" = 'done';
```

`kind` has no CHECK. A kind is added by a registry entry rather than a migration, and the claim filters on the
kinds this build knows (section 1.4), so a rolled-back build leaves a newer build's jobs alone instead of killing
them.

### 1.3 Writing an event in the same transaction as its data

```ts
// src/server/commerce/jobs/emit.ts
export async function emitCommerceEvent(
  trx: Transaction<CommerceDB>,      // Transaction, not Kysely: a plain handle does not type-check
  event: { tenantId: string; type: CommerceEventType; payload: EventPayload[CommerceEventType]; at: Date },
): Promise<string[]>;                // the ids of the jobs it wrote

export async function scheduleJob(trx: Transaction<CommerceDB>, job: ScheduledJob): Promise<string | null>;
```

- `emitCommerceEvent` inserts the event, then calls each consumer's `enqueue(trx, event)` from one registry,
  `src/server/commerce/jobs/consumers.ts`. That file is the answer to "what happens when an order is paid", which
  Medusa spreads across subscribers.
- A consumer may decide to write nothing: `shop_mail` writes only while the company is connected, as today.
- Commit means event and jobs exist; rollback means neither does. A worker cannot see them earlier, because
  claiming only reads committed rows.
- Jobs dedupe on a natural key (`receipt:<orderId>`), through `ON CONFLICT DO NOTHING`, so a repeated emission
  cannot double the work. Events are emitted only inside a transition the state machine guards under its row lock,
  so they do not need a dedupe key of their own.

The first catalogue:

| Event | Written in | Consumers |
|---|---|---|
| `order.placed` | `createOrder`, when a payment opens | `payment_expiry`, due at `expires_at` |
| `payment.paid` | `handlePaymentEvent`, pending or closed to paid | `receipt_issue` |
| `payment.stock_gone` | `handlePaymentEvent`, late success with the stock gone | `late_refund` |
| `payment.refunded` | the `late_refund` job's commit | `shop_mail` (`late_refund`) |
| `receipt.issued` | the transaction linking the receipt | `shop_mail` (`order_confirmation`) |

Directly scheduled, with no event: `stripe_reconcile` (one recurring job per connected company) and
`checkout_expire` (one per checkout).

Changing the receipt to dispatch, which the VAT research recommends, later moves one consumer line from
`payment.paid` to `order.dispatched`.

### 1.4 Claiming

`FOR UPDATE SKIP LOCKED` lets several workers pick different rows. It does not by itself make a claim, because
the work (a PDF render, a Lumitra Mail call, a Stripe call) must run outside any transaction. So the claim is a
short transaction that takes a lease:

```sql
UPDATE "commerce_job" AS j
   SET "status" = 'running', "attempts" = j."attempts" + 1, "claim_token" = $token,
       "run_at" = $now + $lease, "updated_at" = $now
 WHERE ("tenant_id", "id") IN (
   SELECT "tenant_id", "id" FROM "commerce_job"
    WHERE "status" IN ('pending', 'running') AND "run_at" <= $now AND "kind" = ANY($knownKinds)
    ORDER BY "run_at", "id"
    LIMIT $batch
    FOR UPDATE SKIP LOCKED
 )
 RETURNING *;
```

`run_at` carries the lease on purpose. A claimed job is simply one whose next run is when its lease ends, so a
crashed worker's job becomes due again with no reaper and one index. `attempts` rises at claim, so a job that
kills its process each time still runs out.

Finishing is conditional on the token, so a worker that outlived its lease changes nothing:

```sql
UPDATE "commerce_job" SET ... WHERE "tenant_id" = $t AND "id" = $id AND "claim_token" = $token;
```

Zero rows updated is logged. Its side effect is safe by section 1.8.

A handler runs under a deadline shorter than the lease of its kind, so a slow handler stops before a second
worker can start. `runJobNow(db, jobId)` is the same claim narrowed to one id, used for the first attempt after a
commit. It and the poller cannot both run one job.

### 1.5 Retries, backoff and dead letters

The registry gives each kind a policy:

```ts
interface JobPolicy {
  leaseMs: number;
  backoffMinutes: number[];   // past the list, laterMinutes
  laterMinutes: number;
  giveUpAfterMs: number;      // measured from created_at
}
```

A handler ends in one of four ways:

| Outcome | Effect |
|---|---|
| Returns | `done` |
| Returns `{ rerunAt, payload? }` | Back to `pending` with `attempts` 0: a recurring job, or a date that moved |
| Throws `JobRetryLater(reason, delayMs?)`, or anything else | `pending` with backoff, or `dead` once past `giveUpAfterMs` |
| Throws `JobRefused(reason)` | `dead` at once: only a person can change the outcome |

`dead` means "a person must look". It is not a failure that the system retries:

- `last_error` keeps the reason, with no personal data, as `shop_mail` does today.
- It is logged once with `[commerce-job]`, the kind, the company and the id.
- It counts on the health route (section 1.7), and the company's owner sees it where failed mail already appears
  (`connection.ts`). The order list (rank 4) adds a per-order view.
- `requeueJob(tenantId, id)` sets `pending`, `attempts` 0, `run_at` now. The internal route exposes it; a retry
  button comes with the order list.

### 1.6 Tenant scoping

- A job is claimed through `commerceTenantDb(tgId)`, the same immutable scoped handle every repository uses.
- `tenant_id` is the company. The handler receives `{ db, tgId, tenantId, job, signal }` and builds its
  dependencies from those, as `paymentDeps(db, tgId, companyId)` does.
- Every handler read filters on `tenant_id`. `scripts/check-guards.mjs` learns the two new tables, which also
  moves its exact table count in `checkGuards.test.ts`.
- A tenant group with no site is never polled, but it also has no storefront. Consumers read nothing across
  tenant groups.
- A payload holds ids only and is parsed by a per-kind schema at claim. A payload that does not parse is
  `JobRefused`.

### 1.7 Running with one or several app copies

How many replicas run is not established (`rateLimit.ts` says one container today; the analysis found nothing in
`deploy/`). Under the lease it does not matter: any number of pollers is safe, and one is enough.

- **Driver.** `startCommerceWorker()` in `src/server/commerce/jobs/runtime.ts`, started from
  `src/instrumentation.node.ts`, replacing `startShopMailSweep`. One timer per process, guarded on `globalThis`
  against dev reloads, `unref`'d, no overlap with itself. A failure to start is logged and never fails the
  server, as the mail sweep does.
- **Why in the app, given what `deploy/README.md` says for the host timer.** That timer was chosen for one caller
  and nothing during `next build`. The lease removes the need for one caller, and `register()` does not run
  during a build. It also adds a chore that has already slipped: the expiry timer is still a preparation step of
  the fleet. A poller works on every deploy with nothing to install.
- **One pass.** Read tenant groups as both sweeps do (`site.findMany` with `distinct`), then for each group, with
  at most 4 at a time, claim up to 20 jobs and run them in sequence. A group failing never stops the others; a
  group without its schema or tables is skipped with the checks `expirySweep.ts` and `runtime.ts` already use.
- **Interval.** 30 seconds, down from the mail sweep's 60, because expiry now depends on it.
- **First attempt.** After a commit, the caller starts `runJobNow` for the jobs it wrote. Mail is not awaited.
  Section 1.9 covers receipts. A buyer never waits on the poller.
- **Retention.** Once an hour a pass deletes `done` jobs older than 90 days, at most 500 per group. A dedupe key
  concerns one order or checkout, so nothing old can recur. Events are kept: they are small and hold ids only.
- **Watchdog.** `POST /api/internal/commerce/jobs/run`, behind `checkInternalRequest`, runs one pass and answers
  `{ tenantGroups, ran, failed, dead, oldestDueSeconds }`. It answers 500 when a pass failed, any job is dead, or
  the oldest due job is over 10 minutes late. The systemd unit next to the expiry one calls it every 5 minutes,
  so a dead poller still gets its work done and the journal shows it. An Uptime Kuma monitor on the same route is
  what reaches Marlin.

**Known limit.** One indexed query per tenant group per pass, per process. At 1,000 groups that is seconds of a
30 second interval [inference, not measured]. Each pass logs its duration. When a pass exceeds 20 seconds, the
fix is a small platform-level table of groups with due work. It is not built now, because there is no demand for
it and it would add a write across schemas to every transaction.

### 1.8 Idempotency per kind

A claim can run twice, so each handler names why that is safe.

| Kind | Dedupe key | Why a repeat is harmless | Backoff, give up | Dead means |
|---|---|---|---|---|
| `payment_expiry` | `expiry:<orderId>` | `payment_event` records `expiry:<orderId>` once under the payment's row lock [code] | 1, 5, 15, 60 minutes, then 6 hours; 3 days | Stock held past its window |
| `receipt_issue` | `receipt:<orderId>` | `ensureReceipt` answers an issued receipt; a partial unique index allows one per order [code] | Same; 30 days, since a company may set up its Books late | A paid order with no receipt |
| `shop_mail` | `mail:<orderId>:<kind>` | Lumitra Mail's key, and the frozen letter [code] | Same as today; 3 days | A letter that could not go out |
| `late_refund` | `refund:<orderId>` | Stripe's idempotency key; the state machine refuses a second `refunded` [code] | Same; 30 days | A buyer charged for nothing |
| `stripe_reconcile` | `reconcile:<provider>` | Replays dedupe on `payment_event`; findings dedupe on their key | Recurring, 15 minutes | Lost payments unnoticed |
| `checkout_expire` | `checkout:<checkoutId>` | Updates only an open checkout whose `expires_at` has passed | Same; 3 days | Buyer data kept too long |

`payment_event` stays: inbound dedupe is a separate concern from outbound work.

### 1.9 How the three private versions are absorbed

**Expiry.**

- `createOrder` emits `order.placed` in its transaction, so the expiry job exists from the moment the hold does.
- The handler closes through the unchanged `handlePaymentEvent` path. If `expires_at` moved (section 2.1), it
  returns `{ rerunAt }`.
- A migration writes a job for every payment now `pending`, due at its `expires_at`.
- `sweepAllExpiredPayments`, its route and its systemd units go.
- The per-company `sweepExpiredPayments` before an order stays: it is what stops an expired hold reading as a
  shortage in the seconds before the poller reaches it. The pay route narrows to closing this order when its own
  window has passed.

**Receipts.**

- `payment.paid` writes `receipt_issue` in the transaction that marks the payment paid. A receipt can no longer
  be forgotten.
- The handler is `ensureReceipt`, then the link and `receipt.issued` in one transaction. On failure it still
  writes `receipt_error`, because the owner surface reads it, and rethrows for the retry.
- `handlePaymentEvent` returns the ids it wrote. The demo pay route awaits `runJobNow`, so its answer keeps its
  `receipt` field. The webhook does not wait: it starts the attempt and answers, because a PDF render should not
  hold a Stripe delivery open.
- A webhook no longer answers 500 `receipt_pending`.

**Mail.**

- `shop_mail` keeps what is about the letter: `letter`, `mailing_id` and `status` (`sent`, `blocked`, `failed`,
  `pending`), with the frozen-letter rule untouched.
- Scheduling moves to the job. `deliverShopMail` keeps its body and loses its own bookkeeping: `MailRetryLater`
  becomes `JobRetryLater`, `MailRefused` writes `failed` and throws `JobRefused`, and `blocked` is `done` because
  Lumitra Mail decided and a person cannot change it here.
- `sweepShopMail`, `startShopMailSweep` and `nextAttemptDelayMs` go.
- A migration writes a job for every `pending` row.
- `attempts`, `next_attempt_at` and `last_error` are dropped by a later slice, once the old build is gone. That is
  expand first, contract after, because dropping columns is destructive on production.

**Late refund.** In the payment transaction: record the event, emit `payment.stock_gone`, leave the status
closed. The job then reads the provider payment id, calls `refund` outside any transaction, and in one
transaction sets `refunded` and emits `payment.refunded`. A crash after the provider call repeats it under the
same key `refund:<providerPaymentId>`, which answers the same refund [code]. That key is full-refund only: rank 6
must change it (the VAT research makes the same point).

## 2. Stripe reconciliation

BusBasis needed this because lost webhooks left orders captured on Stripe and unpaid in its shop (analysis 3.5).
framer-clone compares nothing with Stripe today [code]. The risk is real here too, and sharper now that
`PaymentMismatchError` on a webhook is answered 200 and only logged [code].

### 2.1 A defect to fix first: the session is not pinned

Read from the code, not reproduced:

- **The session id is thrown away.** The pay route ignores `started.providerPaymentId` (a Checkout Session id), and
  `provider_payment_id` stays empty until a webhook sets it, to a PaymentIntent id [code]. A payment whose webhook
  was lost has no Stripe reference at all.
- **The idempotency key does not hold.** `start` sends `checkout:<orderId>` with
  `expires_at = max(window, now + 31 minutes)` [code]. Once a session exists, `now + 31 minutes` wins, so it
  differs on every call. Stripe refuses a key repeated with other parameters [documented by Stripe, unproven
  here]. So a buyer who returns from Stripe and presses pay again gets a server fault, the opposite of what the
  comment there promises. A changed return path or buyer email does the same.
- **The hold ends before the session does.** The hold is 30 minutes from the order; the session lasts 31 from the
  pay click. A buyer who pays in the gap reaches the late path and can be refunded for an order they paid for in
  time [inference].

**Decision.** `order_payment` gains `provider_session_id`, `session_expires_at` and `session_return_url`.

1. On the first pay, a short transaction under the row lock fixes `session_expires_at` (now plus 31 minutes),
   `session_return_url`, and moves `expires_at` to match. This happens once.
2. Stripe is called with those stored values and the key, then the id is stored.
3. On a later pay: an open session answers its own URL through a new `retrieveCheckoutSession`; a closed one
   leaves the payment to close normally.

A hold lasts at most about an hour. A late success still works, but needs an unusual gap. The buyer becomes fixed
at place (section 3), which removes the email case.

### 2.2 The job

`stripe_reconcile` is one recurring job per company with a Stripe account, written when the account is stored and
by a migration for existing accounts. Every 15 minutes it:

1. Calls a new `StripeApi.listEvents({ accountId, types, createdGte, startingAfter })`, `GET /v1/events` with the
   `Stripe-Account` header, from a cursor in the job's payload, with one hour of overlap. Types:
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `checkout.session.expired`, `charge.refunded`,
   `charge.dispute.created`.
2. Reads each through `readStripeEvent`, extracted from `readStripeDelivery` so that a webhook and a replay parse
   one way.
3. Requires the event's metadata to name this company and tenant group. Otherwise a finding, never applied.
4. Passes the three payment types to `handlePaymentEvent` under Stripe's own event id. A later real delivery of
   the same event dedupes on `payment_event`, and everything downstream (receipt, mail, late path) is the normal
   flow.
5. Records anything else as a finding.
6. Advances the cursor, through `{ rerunAt, payload }`.

Events rather than per-order lookups: one bounded call per company, a repeat of exactly what the webhook would
have said, and refunds and disputes in the same stream. Stripe lists events back 30 days, so a cursor older than
25 days raises a finding of its own.

### 2.3 Findings

| Case | Action |
|---|---|
| Stripe paid, we are pending or closed | Applied, through the state machine |
| Stripe failed or expired, we are pending | Applied |
| Amount or currency differs (`PaymentMismatchError`) | Finding, nothing changes. The webhook writes the same finding |
| Metadata names another company, or no payment row exists | Finding |
| `charge.refunded` while we say paid | Finding. A Standard account has a full Stripe dashboard, so an owner can refund there without the platform [inference] |
| `charge.dispute.created` | Finding |

```sql
CREATE TABLE "payment_finding" (
  "tenant_id", "id", "provider", "provider_ref", "kind", "order_id", "detail" TEXT,  -- no personal data
  "created_at", "resolved_at",
  UNIQUE ("tenant_id", "provider", "provider_ref", "kind")
);
```

Findings surface like dead jobs: on the health route and to the owner. Acting on a dashboard refund belongs to
rank 6, because it touches Books.

### 2.4 Not covered

`processing` payments (SEPA and Klarna) stay rank 8; the job handles only what the webhook handles today.
Reconciliation does not compare payouts or fees. The demo provider has nothing to reconcile.

## 3. A checkout record

The browser cart stays as it is: `src/lib/commerce/cart.tsx`, `localStorage`, no server write, a list of
intentions. A checkout row exists only once a buyer starts checkout, so browsing costs nothing and no anonymous
row exists per visitor.

### 3.1 Why now

Beyond the analysis's reason, that shipping and discounts need a server price before payment, three findings
force it:

- **An order is priced before the buyer is known.** `route.ts` allows the buyer to arrive at the pay step, so tax
  cannot follow the destination (VAT research, summary 3).
- **The buyer never confirms a total.** The cart shows a display figure and the server decides at order creation
  [code].
- **`request_id` comes from the client, and is not scoped to a company.** The unique index is per schema and
  `findByRequestId` and `readOrderTotal` do not filter on `tenant_id` [code]. A storefront request carrying a key
  already used by another company of the tenant group is answered with that company's order id, number and total
  [inference, not reproduced]. Keys are random (`CheckoutButton.tsx`), so someone would need another buyer's key,
  but it is a read across companies all the same: open question 1. A server-minted key closes the client side.

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

**Access.** An anonymous buyer holds a 32-byte random token, sent in a header, never in a URL. The tenant comes
from the request host, as on every storefront route. A wrong token answers the same 404 as a missing id. Creating a
checkout goes through the bounded `SlidingWindow` from `src/server/forms/rateLimit.ts`, per IP address.

**Personal data.** An open checkout expires after 24 hours, extended by each change. `checkout_expire` then sets
`expired` and empties `buyer` and `delivery`. A placed checkout is emptied the same way 7 days later, since the
order and payment hold what must be kept. A company erasure removes its checkouts, like `form_submission`.

### 3.3 One pricing path

`createOrder` steps 2 to 4 (price, snapshot, tax) become `priceCart(db, input)`, read-only and callable on a
handle or a transaction. The quote and the order both call it, so they cannot diverge. It uses `priceDocument`
(section 4).

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
| `POST /api/commerce/checkouts/<id>/retry` | From a placed or expired checkout: a new open one with the same inputs, freshly priced |

`POST /api/commerce/orders` goes when the storefront has moved. Pre-launch rules allow that, and two write seams
would be a defect. `POST .../pay` keeps its job, minus `buyer`, which is fixed at place because tax depended on it.

### 3.5 Place

In one `READ COMMITTED` transaction, on the existing path:

1. Lock the checkout `FOR UPDATE`. Placed with this key: answer its order (a double click). Expired: 410.
2. `revision` stale: 409.
3. `priceCart` again, in the transaction. If the key differs from `quoteKey`: 409 `quote_changed` with the new
   quote. Nothing is reserved, and the buyer confirms the new total.
4. The order path as today, under `request_id = checkout:<id>`: insert order and lines, reserve, open the payment,
   emit `order.placed`.
5. Set `placed` and `order_id`.

A shortage aborts everything, as today, and answers 409 with `shortages`, leaving the checkout open, so the buyer
can change quantities and go on.

`createOrder`'s body becomes `placeOrderInTransaction(trx, tgId, cart)` so step 4 runs inside this transaction.

Buyer data goes to `order_payment.buyer`, where 021 keeps personal data. Delivery joins it as an optional
`delivery` object, which the order's own shipping rows replace in rank 3.

### 3.6 The rule for derived state

Per `knowledge-base/standards/stateful-flow-testing.md`, what depends on an input is keyed to it:

- **A changed input** reprices everything. A shipping option no longer offered for the new country clears
  `shipping_option_id`; a code that no longer applies is removed. Both are stated in the answer's `notices`, so
  nothing vanishes silently.
- **Resume.** The browser keeps `{ checkoutId, token }` per site, in `localStorage` in a try/catch. On load it
  sends `GET`. An expired or missing checkout starts fresh from the cart. A browser cart that differs from
  `lines` is sent by `PUT`: the cart is the buyer's truth for what they want. A lost token only means a new
  checkout.
- **Re-entry.** A placed or expired checkout is never reopened. After a failed or expired payment the client calls
  `retry`, which keeps the buyer's typing and reprices. The browser cart stays until a payment succeeds, as it
  does now.

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

`order_line_item` gains two columns: `line_kind` (`item` or `shipping`, default `item`) and `discount_amount`
(default 0, with a CHECK against the line's amount). The accounting identity and every money floor stay, and no
negative amount appears. Under `gross` the base is gross and `computeLineTax` extracts the tax, as it does now.

- **A discount folds into lines, in exact cents.** The research's rule: no negative lines, and order-level or
  line-level makes no legal difference while the per-rate result is right. This also tells a refund exactly what
  each line sold for, which rank 6 needs.
- **Shipping is an order line, one per rate.** `line_kind = 'shipping'`, quantity 1, no variant, no stock. The
  existing `reservedStock` query does not see it, since no stock movement points at it.
- **Order of application** (research, discount rule 6): line discounts, cart discount, shipping allocation, tax.
- **The split** uses largest remainder, so parts sum exactly. The research recommends gross value of shipped lines
  after discount. That is one function argument, stored on the order in rank 3, and its adviser question stays
  open.

A deferred constraint trigger (BK022, at commit, like 002's transfer balance) checks that the lines sum to the
order. Today only `total = subtotal + tax_amount` is enforced by the database; nothing ties the header to the
lines [code].

### 4.2 One function

```ts
// src/server/tax/priceDocument.ts: pure, no database, beside germanVat.ts
export interface PriceLineInput {
  ref: string;
  listAmount: number;       // in the document's basis
  discountAmount: number;
  taxClass: 'standard' | 'reduced' | 'zero' | null;
  explicitRate?: number;
}
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

`priceCart` and Books' `deriveLine` plus `summarize` both go through it, keeping the "one semantic, one
implementation" rule of `germanVat.ts`.

**Rounding.** It starts per line, exactly as today, so the slice that introduces it changes no figure. The research
recommends per rate with allocation to lines, because the European e-invoice standard (EN 16931) calculates per
rate and a line carries no tax amount there, and a customer can recompute it from the printed totals. Under that
rule the identity above still holds, because allocation makes line taxes sum to the document's. This is Marlin's
decision 3 in the research, after adviser question 3. Whichever is chosen, it is one rule in this function and not
a per-company option. Issued documents are frozen, so it affects only new ones.

### 4.3 Books copies a shop order

The research's table of what must agree, adopted:

| Item | Rule |
|---|---|
| Gross total | Equal to the cent, equal to the payment |
| Net and tax per (rate, treatment) | Equal, compared at receipt |
| Rate on each line | Copied from the order, never re-derived |
| Shipping lines and discount amounts | Copied |
| Tax profile | Decided once, at checkout, passed to Books |

Today `receipt.ts` re-derives from `tax_class`, re-resolves the profile from the buyer, and compares only the total
[code]. So:

- `sales_document_line` gains `discount_amount` (cents), beside `discount_bp`, with a CHECK that a line uses at most
  one. `discount_bp` cannot express an allocated amount. The research adds that this also serves roadmap item 8c,
  the whole-invoice discount.
- For a document with `source_order_id`, `createDraft` takes the order's frozen profile, and `issue` and
  `syncDraftTaxState` use it instead of `profileFor(settings, customer)`.
- `ensureReceipt` copies each line's rate, discount and amounts, shipping lines included.
- The check becomes total and per-rate buckets. A mismatch stays `TOTALS_MISMATCH`, which `receipt_issue` treats as
  `JobRefused`: a mismatch will not heal, and it needs a person.
- `priceCart` must apply `convertUnitPrice` as Books does: `createOrder` charges a gross price unchanged under
  reverse charge [code].

### 4.4 The tax profile at checkout

`shopTaxProfile` becomes `checkoutTaxProfile(db, companyId, { buyer, delivery })`, which calls `resolveTaxProfile`
with the delivery country. The result lands in the quote and on the order (`customer_type`, `vat_id`,
`reverse_charge`, `kleinunternehmer`, `tax_note`), from which Books takes it, and `order.tax_region` becomes the
delivery country instead of the constant `DE`. Until this switch every order stays `DE`, because it is taxed as
German.

The research establishes why this has to happen, and why it is not enough alone:

- **Live fault** (read, not reproduced): a regular-taxed company selling to an Austrian business with a VAT id
  charges German VAT, then `ensureReceipt` throws `TOTALS_MISMATCH`, and a Swiss buyer ends in
  `TAX_CASE_UNSUPPORTED`. Either way the money is taken and no invoice exists.
- **`resolveTaxProfile`'s reverse-charge branch is wrong for goods.** A parcel to an EU business is a tax-free
  intra-Community supply, with its own note, proof and reporting, not paragraph 13b reverse charge. So the shop must
  not reach that branch for goods. The treatments needed belong to rank 12.

**Decision, subject to Marlin.** The slice that switches this on takes the research's recommendation: delivery to
Germany only, by default, so the quote refuses any other country with `destination_not_supported`, before payment.
A buyer delivering to Germany who gives a foreign VAT id is treated as domestic, because place of supply follows
delivery [inference, adviser question 7]. Frozen profiles make that receipt consistent. This slice waits for
Marlin's review. Everything else in sections 3 and 4 is indifferent to the answer, because no figure changes while
every order is domestic.

### 4.5 What is left to the rank plans

Shipping rates, discount computation, `payment_refund` rows, the order discount snapshot and receipt-at-dispatch
are specified in the research's section 8 and belong to ranks 3 to 7. This backbone gives them `line_kind`,
`discount_amount`, `allocateLargestRemainder`, one registry line for the receipt trigger, and the checkout columns.

## 5. Slices

Fourteen, not the four the fleet plan assumed. The plan's unit of about 30 to 60 minutes per slice holds only if
each stays this small, and every change here touches money or a migration, so they run in series. That adds about
10 slices to its total of about 70.

Every slice: branch from `origin/main`, the suite green before and after, a tenant migration takes the next free
number, is registered in `migrations/tenant/index.ts`, and updates `db-types.ts`, `provision.itest.ts` and, for a
new table, `checkGuards.test.ts`. New SQLSTATEs start at BK021. Slices touching a route run
`pnpm test:integration`. `shared_state: [migrations, docs-shop]` keeps them serial.

Test plans name the four paths of the stateful flow standard: **F** forward, **B** backtrack and revise, **R**
resume, **E** re-entry after completion or failure.

**Money** marks a slice that needs Marlin's review under the fleet plan (createOrder, reserve, payments, refunds,
reconciliation). Each also gets a fresh review agent, as does every contract.

### B1: job tables and engine

- **Files:** `migrations/tenant/025_commerce_job.ts`, `index.ts`, `db-types.ts`,
  `src/server/commerce/jobs/{types,emit,claim,run,consumers}.ts`, `jobs/__tests__/`, `checkGuards.test.ts`,
  `provision.itest.ts`.
- **Does:** sections 1.2 to 1.6, with one test kind. Nothing calls it. BK021.
- **F:** emit in a transaction, claim, run, `done`.
- **B:** a rolled-back transaction leaves no event and no job; a repeated dedupe key writes one job.
- **R:** two concurrent claimers on real Postgres never get one job. A killed worker's job is claimed again after
  its lease. A stale token changes nothing. An unknown kind is left alone.
- **E:** a job past `giveUpAfterMs` goes `dead`; `requeueJob` runs it again; `attempts` stops a job that kills its
  process; append-only refuses update and delete.
- **Money:** no.

### B2: the worker and its watchdog

- **Files:** `jobs/runtime.ts`, `src/instrumentation.node.ts`, `src/app/api/internal/commerce/jobs/run/route.ts`,
  `deploy/commerce/framer-clone-commerce-jobs.{service,timer}`, `deploy/README.md`.
- **Does:** section 1.7, beside the existing sweeps.
- **F:** a pass runs due jobs across two tenant groups.
- **B:** a group whose tables are missing is skipped; a failing group stops no other.
- **R:** overlapping passes run a job once; a pass after a restart picks up what was due.
- **E:** the route answers 500 on a dead job and on a late job, and 200 once requeued.
- **Money:** no. Installing the timer is a machine change: one line for Marlin.

### B3: expiry becomes a job

- **Files:** `order/createOrder.ts`, `payment/expiryJob.ts`, `jobs/consumers.ts`, a migration for pending payments,
  `orders/[orderId]/pay/route.ts`. Removed: `payment/expirySweep.ts`, `internal/commerce/expired-payments/`,
  its systemd units.
- **F:** order placed, job written, window passes, stock released.
- **B:** a rolled-back order leaves no job; paying before the window makes the job do nothing.
- **R:** the migration covers a pending payment from before the slice; a job failing keeps the stock held and
  retries.
- **E:** a late success after expiry still takes its path; a closed payment's job is a no-op.
- **Money:** yes, it releases stock.

### B4: receipts become a job

- **Files:** `payment/payments.ts`, `payment/receiptJob.ts`, `payment/deps.ts`, `jobs/consumers.ts`,
  `api/payments/stripe/webhook/route.ts`, `orders/[orderId]/pay/route.ts`, `payment/__tests__/`.
- **F:** paid, job written with the status change, receipt, `receipt.issued`.
- **B:** a failed status transaction leaves no job.
- **R:** the Books down at first attempt: the webhook still answers 200, the job issues later, `paid_on` stays the
  payment's day.
- **E:** repeat delivery on a paid order writes no second job; `TOTALS_MISMATCH` is `dead` and visible; a demo pay
  response still carries `receipt`.
- **Money:** yes, it changes the webhook's answer and `handlePaymentEvent`.

### B5: mail becomes a consumer

- **Files:** `mail/outbox.ts`, `mail/runtime.ts`, `mail/connection.ts`, `src/instrumentation.node.ts`,
  `jobs/consumers.ts`, a migration for pending letters, `mail/__tests__/shopMail.itest.ts`.
- **F:** `receipt.issued` writes letter and job, sent.
- **B:** a company not connected writes neither.
- **R:** Lumitra Mail down retries with the same frozen letter and key.
- **E:** a reconnect to another workspace rebuilds as today; `blocked` is `done`; a refusal is `failed` and `dead`;
  owner failures still count on the payments page.
- **Money:** no, but it edits `payments.ts` call sites, so the review agent reads those.

### B6: the late refund leaves the transaction

- **Files:** `payment/payments.ts`, `payment/lateRefundJob.ts`, `jobs/consumers.ts`, `payment/__tests__/`.
- **F:** a late success with no stock: event recorded, job, refund, `refunded`, letter.
- **B:** stock available: `reserveAgain` wins and no job is written.
- **R:** a crash after the provider call repeats with the same key and one refund, proven against a fake that
  counts calls.
- **E:** a concurrent delivery that decided it first; provider failure retries; a provider that keeps refusing is
  `dead`.
- **Money:** yes.

### B7: pin the Stripe session

- **Files:** migration on `order_payment`, `db-types.ts`, `payment/stripe/client.ts`, `payment/stripe/connect.ts`,
  `payment/provider.ts`, `orders/[orderId]/pay/route.ts`, `payment/expiryJob.ts`, `stripe/__tests__/stripe.test.ts`.
- **Does:** section 2.1.
- **F:** first pay pins, stores, redirects.
- **B:** a buyer back from Stripe gets the same session, with the same URL.
- **R:** a crash between pin and store sends identical parameters, proven by comparing request bodies.
- **E:** a session expired on Stripe closes normally, and the expiry job follows the moved date.
- **Money:** yes. The operator proves it with a sandbox purchase, including going back and paying again.

### B8: Stripe reconciliation

- **Files:** migration for `payment_finding`, seeding jobs, `db-types.ts`, `payment/stripe/client.ts`,
  `payment/stripe/webhook.ts`, `payment/reconcileJob.ts`, `payment/stripe/connect.ts`, `jobs/consumers.ts`,
  `api/payments/stripe/webhook/route.ts`, tests.
- **F:** a succeeded event with no webhook is applied, then a receipt follows.
- **B:** an amount mismatch or foreign metadata writes one finding and changes nothing.
- **R:** the cursor advances only after success; a failed page repeats; overlap re-reads harmlessly.
- **E:** a real webhook after a replay is a duplicate, and the reverse; a stale cursor raises its finding.
- **Money:** yes. Stripe's list API is unproven here, so the operator proves it in the sandbox on a connected
  account, with a delivery deliberately missed.

### B9: drop mail's old columns

- **Files:** a migration, `db-types.ts`, `mail/outbox.ts`, `mail/connection.ts`.
- **Does:** removes `attempts`, `next_attempt_at`, `last_error` and their index after B5 has been deployed.
- **F:** letters flow after the drop.
- **B:** n/a, a schema change only.
- **R:** the migration is re-runnable.
- **E:** owner failure counts read the job's reason.
- **Money:** no, but destructive on production: one line for Marlin, with backup and rollback stated.

### B10: `priceDocument` and the identity columns

- **Files:** `src/server/tax/priceDocument.ts`, its tests, `order/createOrder.ts`, `order/priceCart.ts`,
  `books/totals.ts`, a migration for `line_kind`, `discount_amount` and BK022, `db-types.ts`.
- **Does:** sections 4.1 and 4.2 with per-line rounding. No figure changes.
- **F:** every existing `createOrder` and Books total test passes unchanged, plus property tests of the identity on
  random carts in both bases.
- **B:** a line edited in a Books draft recomputes through the function.
- **R:** BK022 refuses a commit whose lines do not sum, with the correct order passing.
- **E:** allocation sums exactly for zero weights, one line and many lines; a zero-rate line; a small business.
- **Money:** yes.

### B11: Books copies a shop order

- **Files:** a migration for `sales_document_line.discount_amount`, `books/repository/documents.ts`,
  `books/repository/lines.ts`, `books/issue.ts`, `books/totals.ts`, `payment/receipt.ts`, `render/` where a line's
  discount prints, tests.
- **Does:** section 4.3.
- **F:** a receipt with a shop-supplied line discount and shipping line equals the order per rate.
- **B:** an editor invoice is untouched, and `discount_bp` still works.
- **R:** company tax status changed between order and receipt: the receipt keeps the order's profile.
- **E:** a tampered total is `TOTALS_MISMATCH`; a gross order under reverse-charge conversion matches; a retry
  rebuilds a left-over draft.
- **Money:** yes, it changes what an invoice shows.

### B12: the checkout record, server side

- **Files:** a migration for `checkout`, `db-types.ts`, `checkGuards.test.ts`,
  `src/server/commerce/checkout/{repository,quote,place,expireJob}.ts`, `order/createOrder.ts`,
  `src/app/api/commerce/checkouts/**`, `jobs/consumers.ts`, company erasure.
- **Does:** section 3, beside the existing orders route, with the tax profile as today. `findByRequestId` and
  `readOrderTotal` filter on `tenant_id` here at the latest.
- **F:** create, set buyer, place, pay with the existing route.
- **B:** a changed quantity or address changes quote and key; the same input keeps both and the revision; an
  option or code that no longer applies is cleared with a notice; a stale revision is 409.
- **R:** `GET` after a price change reprices; place with the old key is `quote_changed`, reserving nothing; a
  wrong token is 404; expiry wipes buyer data.
- **E:** double place answers one order; a shortage leaves the checkout open; `retry` after a failed payment makes
  a new one; a placed checkout refuses `PUT`.
- **Money:** yes, it writes orders.

### B13: the storefront moves, the old route goes

- **Files:** `src/lib/renderer/commerce/CheckoutButton.tsx`, `src/lib/commerce/payment/storefrontGateway.ts`, a
  client checkout module, `orders/[orderId]/pay/route.ts`. Removed: `api/commerce/orders/route.ts`, with
  `middleware.ts`, `storefrontTenant.ts` comments and its tests moved.
- **Does:** POST checkout, PUT changes, POST place. The confirmation shows the quote's total. `buyer` leaves the
  pay route.
- **F:** browser cart to paid order, demo and sandbox.
- **B:** back from the payment step, change a quantity, the total changes, and the old `placedRef` logic is gone.
- **R:** a reload at each step restores it; a cart changed in another tab wins.
- **E:** a declined payment offers retry with the buyer's typing kept; a finished order clears the cart, and a
  new checkout starts clean.
- **Money:** yes. The operator proves it on production with a test purchase after deploy.

### B14: tax follows the destination

- **Files:** `payment/shopTax.ts` (renamed `checkoutTax.ts`), `checkout/quote.ts`, `payment/buyer.ts`, tests.
- **Does:** section 4.4 on Marlin's answer.
- **F:** a German delivery prices as today.
- **B:** changing the country to one not offered refuses before payment, and changing it back recovers.
- **R:** a saved checkout for a country no longer offered is refused on resume.
- **E:** a German delivery with a foreign VAT id gets a receipt that matches.
- **Money:** yes, and it waits for the VAT review.

### Order

B1, B2, then B3 to B8 in series, then B10 to B13, then B14. B9 runs after B5 has been live for a while. B10 and B11
can run while B6 to B8 wait for review, since they touch other files. Ranks 3, 5 and 6 stay behind the VAT review.

## 6. Open questions

**For Marlin** (each has a default in the text):

1. **A read across companies, security.** Section 3.1: an order request reusing another company's key in the same
   tenant group is answered with that order's id, number and total. Recommended now, independent of this plan:
   filter `findByRequestId` and `readOrderTotal` on `tenant_id`, and make the index `(tenant_id, request_id)`. The
   index change is a production migration, so it is one line for Marlin. Auth and tenant isolation changes stop for
   him under the fleet plan, which is why this is here and not simply done in B12.
2. **The live fault, now.** A foreign VAT id or address today means money taken and no invoice. The research
   recommends a small immediate fix: refuse such a buyer at the pay route for regular-taxed companies, independent
   of this plan, since the backbone reaches it only at B14. It is one small slice. Its urgency depends on whether
   real payments run: the last purchases on record were sandbox ones (`stripe/client.ts`), and I did not check
   which keys production holds.
3. **Delivery countries at launch** (research decision 1, assumed by B14): Germany only by default.
4. **Per-rate rounding** (research decision 3, section 4.2): when, after the adviser.
5. **Receipt at dispatch or payment** (research decision 2): one registry line plus a service date, and it ties
   ranks 3 and 4 together.
6. **The research itself.** It lists 14 questions for a tax adviser. Shipping split, cart discount and rounding
   are the three this plan's identity leans on most, though the identity holds under any answer.

**Unproven:**

7. **Stripe's event list on connected accounts:** behaviour with the `Stripe-Account` header, and whether listed
   events have the same shape as the webhook's at the account's API version. B8 proves it in the sandbox.
8. **The repeated-key refusal in section 2.1** is read from the code and Stripe's documented rule, not reproduced.
   B7 reproduces it first.
9. **Scale of the per-group pass,** section 1.7. Estimated, not measured.
10. **Replica count.** Irrelevant to safety under the lease, but `SlidingWindow` limits are per process, so several
   copies would loosen the checkout rate limit.

**Deliberately left out:**

11. **A free order.** `createOrder` opens no payment when `total` is 0, and the amount CHECK forbids one, so a 100
    percent discount would have no payment, receipt or mail [code]. Rank 5 must decide; nothing reaches it today.
12. **Disputes and dashboard refunds** only raise findings until rank 6.
13. **After a deploy rollback,** jobs of a kind the older build does not know stay pending by design, and the
    watchdog's lateness warning fires until the newer build is back.
14. **Who reads findings and dead jobs for a company.** Until the order list exists, an owner sees counts on the
    payments page, and Marlin's monitor sees the platform total.

## Reality

- 2026-11-02: contract only, no product code. Read against `origin/main` at `e98a306`. The Medusa analysis and the
  fleet plan are not on `main` yet, so two links in this file resolve once those pull requests land. It needs its
  fresh contract review before B1 is dispatched, and a roadmap line from the operator when it is decided.
