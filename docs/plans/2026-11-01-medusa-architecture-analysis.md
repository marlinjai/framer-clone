---
type: plan
status: draft
date: 2026-11-01
title: "How Medusa solves e-commerce, and what framer-clone's commerce engine should build"
summary: "A source reading of Medusa v2.22.2 against framer-clone's own engine on origin/main (6ddf54b). Not a migration plan: BusBasis may stay on Medusa. Medusa's domain model is worth copying, its runtime is not: its workflow engine and event bus are built for one shop per server and give weak guarantees without Redis. framer-clone already beats it on stock and webhook correctness, and lacks shipping, discounts, order work and returns. Five decisions must be made before those features pile up, starting with one Postgres outbox and job table and a server-side checkout record."
tags: [framer-clone, commerce, medusa, architecture, events, workflows, research]
projects: [framer-clone]
---

# How Medusa solves e-commerce, and what framer-clone should build

## How to read this

**Evidence marks.** Claims in sections 2 to 5 carry one, on the claim or on the heading or table above it:

- **[code]**: read directly from source.
- **[inference]**: my conclusion from code, not stated by it.
- **[unknown]**: not established; section 8 lists these.

Judgement sizes are my estimates, in agent weeks of five working days, on the same scale as the
[BusBasis gap list](2026-11-01-busbasis-native-storefront.md).

**Sources.**

- Medusa: tag `v2.22.2`, the latest v2 release on 2026-11-01, confirmed in
  `packages/medusa/package.json`. Shallow clone, read as data. Nothing was installed or run. Medusa paths
  below are relative to that repository's root.
- BusBasis: runs `@medusajs/medusa` 2.19.0 (`MedusaJS/busbasisberlin/package.json`), read only. Three minor
  versions lie between it and this reading, so a detail read here (for example the row locks in
  `registerUsage`) may postdate what BusBasis runs. I did not diff the two.
- framer-clone: `origin/main` at `6ddf54b`. `src/...` paths are in this repository.
- The June decision: `knowledge-base/research/2026-06-01-owned-realtime-commerce-architecture.md`.

**Scope.** This is not a migration plan. Whether BusBasis moves stays open (see the
[BusBasis gap list](2026-11-01-busbasis-native-storefront.md)). This document asks only what framer-clone's
engine should build.

**Terms.** A *saga* is a sequence of steps, each with its own database transaction and each with an undo
action ("compensation"), instead of one big transaction. An *outbox* is a table written in the same
transaction as a business change, so the "something happened" record can never be lost or arrive for a
change that rolled back. A *module link* is Medusa's table joining two modules that are not allowed to
know each other.

Short forms used below: SQL (Structured Query Language, how the database is queried), API (application
programming interface), VAT (value-added tax), EU (European Union), JSON (JavaScript Object Notation, a
text format for structured data). "Books" is framer-clone's invoicing
domain (`src/server/books`).

## 1. The short version

1. **Copy Medusa's nouns, not its machinery.** Its entity model is good and already partly copied. Its
   runtime solves a problem framer-clone does not have: keeping dozens of module packages unaware of each other so
   each can be replaced or sit on its own database.
2. **framer-clone's correctness is already ahead on the hard parts.** Stock is a guarded SQL update with
   an append-only ledger; Medusa checks in application code under a lock that is process-local by default.
   Webhooks apply in one transaction and ask Stripe to redeliver on failure; Medusa answers 200 first and
   processes through a queue. Keep this.
3. **The real gap is features**: shipping, discounts, fulfilment, partial refunds and returns, shopper
   accounts.
4. **Five design decisions come before those features** (section 6), because each one changes tables that
   every later feature writes to. The first is a single outbox and job table in Postgres, because
   framer-clone has already grown three private versions of it.
5. **One defect found on the way:** the job that closes expired payments only runs when someone reaches
   the pay route of the same company, so a held last unit can stay held (section 5.5).

## 2. Entity and data model

### 2.1 How modules stay isolated yet linked

- **Each module owns its tables and has no foreign keys to another module** [code]. Relations across
  modules are declared as link definitions in `packages/modules/link-modules/src/definitions/`, each
  producing a join table, for example `order_cart` (`order-cart.ts`).
- **A link can carry data** [code]: `product_variant_inventory_item` has `required_quantity`
  (`product-variant-inventory-item.ts`), which is how Medusa models kits. Variant to price set, sales
  channel to location and product to shipping profile are also links.
- **`query.graph` and remote query stitch data together at runtime** [code]: `packages/core/query/src/joiner/remote-joiner.ts`
  fetches each module separately and joins in memory. Because that cannot filter or sort across modules
  in the database, two things were added on top: `joiner/cross-module-joins/` ("Stage-1 cross-module
  filtering/sorting (SQL pushdown)") and a separate Index module (`packages/modules/index`) that keeps a
  synchronised read copy [code]. The need for both is the visible price of no joins [inference].
- **Links are migrated by a planner** that diffs definitions against the database and treats `alter
  column` and `drop column` as unsafe (`packages/modules/link-modules/src/migration/index.ts`) [code].
- **No foreign key means no database-level integrity across modules** [inference]. Consistency between
  modules is the job of workflows.
- **No tenant concept exists.** A search for "tenant" across module, framework and utility source hit one
  unrelated file (`modules/search/src/types/index.ts`) [code]. `Store` holds settings with no owner column
  (`modules/store/src/models/store.ts`), the schema is one per deployment
  (`core/framework/src/database/pg-connection-loader.ts:48`), and stock keeping unit (SKU) uniqueness is
  global (`IDX_product_variant_sku_unique`) [code]. Sales channels partition the catalogue and carts, but not
  customers, promotions or tax regions, so they are not a tenant boundary [inference].

### 2.2 Per module

All [code], from `packages/modules/<module>/src/models/`. In total 93 model files for these 13 modules.

| Module | Core entities | Relations and ideas worth noting |
|---|---|---|
| Product | Product, ProductVariant, ProductOption, ProductOptionValue, ProductCategory, ProductCollection, ProductTag, ProductType, ProductImage | Options are shared through pivot tables. Variant to option value is many to many. Categories are a tree with a materialised path (`mpath`), `rank`, `is_active`, `is_internal`. Variant carries `manage_inventory` and `allow_backorder`. Unique SKU, barcode, EAN (European Article Number) and UPC (Universal Product Code) among live rows. `discountable` flag on product. |
| Pricing | PriceSet, Price, PriceRule, PriceList, PriceListRule, PricePreference | A price set is only a bag of prices. A price has currency, quantity band and `rules_count`. Rules are attribute, operator, value (for example `region_id`, `customer.groups.id`, and `item_total` for shipping). A rule-based price must match all its rules (`modules/pricing/src/repositories/pricing.ts`). `PricePreference` says per region or currency whether prices include tax. |
| Inventory | InventoryItem, InventoryLevel, ReservationItem | Level has `stocked_quantity`, `reserved_quantity`, `incoming_quantity`. `available_quantity` is a computed application field: no migration defines the column. |
| Stock location | StockLocation, StockLocationAddress | Linked to sales channels and fulfilment sets. |
| Cart | Cart, LineItem, LineItemAdjustment, LineItemTaxLine, ShippingMethod, ShippingMethodAdjustment, ShippingMethodTaxLine, CreditLine, Address | The cart is a persisted, priced document. Discounts and tax are rows (adjustment lines, tax lines), and totals are computed from them. Lines snapshot product and variant fields. |
| Order | Order, OrderItem, OrderLineItem, OrderSummary, OrderChange, OrderChangeAction, OrderTransaction, Return, ReturnItem, ReturnReason, Exchange, Claim, shipping and adjustment lines | `Order.version` increments per confirmed change. `OrderItem` is the line per version, with `fulfilled_quantity`, `shipped_quantity`, `delivered_quantity`, `return_requested_quantity`, `return_received_quantity`, `return_dismissed_quantity`, `written_off_quantity`. 23 action types in `modules/order/src/utils/actions/`. `OrderSummary.totals` tracks `paid_total`, `refunded_total`, `pending_difference`. |
| Payment | PaymentCollection, PaymentSession, Payment, Capture, Refund, RefundReason, AccountHolder, PaymentProvider | Collection is what is owed, session is one attempt at one provider, Payment exists after authorisation, Capture and Refund are separate rows, so partial amounts are natural. `Refund.idempotency_key`. |
| Fulfilment | FulfillmentSet, ServiceZone, GeoZone, ShippingOption, ShippingOptionRule, ShippingOptionType, ShippingProfile, Fulfillment, FulfillmentItem, FulfillmentLabel, FulfillmentProvider, Address | Location has fulfilment sets, a set has service zones, a zone has geo zones (country, province, city, postal expression) and shipping options. Option has `price_type` (flat or calculated). Profile groups products with the same shipping needs. Fulfilment has `packed_at`, `shipped_at`, `delivered_at`, `canceled_at`. |
| Customer | Customer, CustomerAddress, CustomerGroup | `has_account` separates guest from registered. Login lives in a separate Auth module. Groups feed price and promotion rules. |
| Promotion | Promotion, ApplicationMethod, PromotionRule, PromotionRuleValue, Campaign, CampaignBudget, CampaignBudgetUsage | Type standard or buy-get. Method: fixed or percentage; target items, shipping or order; allocation each, across or once. Budgets: spend, usage, or per attribute. `is_automatic`, `limit`, `used`. |
| Tax | TaxRegion, TaxRate, TaxRateRule, TaxProvider | Regions nest (country, province). Rates can be scoped to a product by rule and combined with a parent (`is_combinable`). The default provider only looks up rates (`modules/tax/src/providers/system.ts`). |
| Region | Region, RegionCountry | A region fixes one currency for a set of countries, plus `automatic_taxes`. A cart's currency follows its region (`core-flows/src/cart/workflows/create-carts.ts`). |
| Sales channel | SalesChannel | A publishable API key is linked to channels (`publishable-api-key-sales-channel.ts`), and a channel to products and stock locations. |

**The cart-as-document idea is the most important one here for framer-clone** [inference]: discount,
shipping and tax all become rows on the cart, the order copies them, and everything downstream (receipt,
refund, return) reads the rows rather than recomputing.

## 3. Event-driven architecture

### 3.1 Event bus

**Default: `event-bus-local`** (`packages/core/utils/src/modules-sdk/definition.ts:42`) [code].

- A Node `EventEmitter` inside one process (`modules/event-bus-local/src/services/event-bus-local.ts`).
- A subscriber error is caught and logged; there is no retry. Nothing is persisted. `delay` is a timer.
- Events emitted inside a workflow wait in a process-local `Map` keyed by group until released.

**With Redis (an in-memory data server, a separate service to run): `event-bus-redis`, on BullMQ (a job
queue library for Redis)** (`modules/event-bus-redis/src/services/event-bus-redis.ts`) [code].

- Default `attempts: 1`, so no retry unless the emitter asks. On a retry, subscribers that already
  succeeded are skipped (`completedSubscriberIds`).
- Priorities exist (order placed is `CRITICAL`).
- Workflow events wait in a Redis list with `groupedEventsTTL = 600` seconds.
- Events with no subscriber at emit time are dropped.

**When events are released.** At the end of a workflow, `workflow-export.ts` calls
`releaseGroupedEvents`, and a failure there is logged, not raised [code]. The events are not written in
the transaction of the data they describe, so this is not an outbox. A crash between the last step and the
release loses the event while the data stays [inference].

### 3.2 Workflows and compensation

- **A workflow is a saga built from steps** (`packages/core/workflows-sdk/src/utils/composer/create-step.ts`,
  run by `packages/core/orchestration/src/transaction/transaction-orchestrator.ts`, 2,081 lines) [code].
- **Each step has an action and an optional compensation.** When a step fails permanently the
  orchestrator runs compensations in reverse order [code]. If a compensation itself fails, the workflow
  ends `FAILED`, not `REVERTED` (lines 359 to 366) [code]. There is no automatic repair after that
  [inference]; the admin API has a `workflows-executions` view.
- **Step options** (`transaction/types.ts`): `maxRetries` (default 0), `retryInterval`, `timeout`, `async`,
  `backgroundExecution`, `continueOnPermanentFailure`, `skipOnPermanentFailure`, `noCompensation` [code].
- **No database transaction spans steps** [inference, from the structure: each step calls a module service
  independently]. Between steps other requests can see half-finished state, which is why cart workflows
  take explicit locks (`acquireLockStep`).
- **Hooks** (`createHook`) are named extension points inside core workflows [code].
- **State is stored only when needed**: `store` is forced on for async steps, timeouts, retries, idempotent
  workflows or a retention time (`transaction-orchestrator.ts:1518` to `1530`) [code]. A plain short
  workflow keeps no record in Postgres [inference, from those conditions].
- **`completeCartWorkflow` is `store: true, idempotent: false, retentionTime: THREE_DAYS`** and gets its
  idempotency from a lock plus the `order_cart` link, not from a unique key (`complete-cart.ts:354` to `411`) [code].

**Storage.** The in-memory engine keeps checkpoints in a local object and mirrors to `workflow_execution`
in Postgres (`workflow-engine-inmemory/src/utils/workflow-orchestrator-storage.ts`). Retries, timeouts and
schedules are `setTimeout` (lines 193, 672). The Redis engine uses BullMQ delayed jobs and a dedicated
repeatable job queue (`workflow-engine-redis/src/utils/workflow-orchestrator-storage.ts:140` to `151`, `657`) [code].

### 3.3 Scheduled jobs

A job is a file with a time schedule (a cron expression) that `core/framework/src/jobs/job-loader.ts` wraps
into a one-step workflow with a `schedule` option [code]. In memory it is a timer per process; with Redis it
is a BullMQ repeatable job, so one execution across workers [code for the mechanism, inference for "one
execution"]. The option types say concurrent runs are off by default (`transaction/types.ts`), but the
in-memory storage file does not reference that option [code]. `packages/medusa/src/jobs/` ships empty: core has no scheduled
jobs of its own [code], so nothing in core expires an abandoned cart or checks for lost payments
[inference]. BusBasis wrote that itself (section 3.5).

### 3.4 Which guarantees hold

| Concern | Default (no Redis) | With the Redis modules configured | framer-clone today |
|---|---|---|---|
| Event survives a process crash | No [code] | Yes once queued, within Redis's own persistence settings [inference] | Shop mail yes: row in Postgres [code]. No general events exist. |
| Event is lost if the data transaction rolled back, and vice versa | Not atomic [inference] | Not atomic [inference] | Atomic for `shop_mail` (same transaction as receipt link) [code] |
| Subscriber retry | None [code] | Only if `attempts` set; default 1 [code] | Mail: backoff at 1, 5, 15, 60 minutes, then 6 hours, for 3 days [code] |
| Works across several server processes | Bus, engine and lock are all local to one process, so no [inference] | Yes; `workerMode` splits server and worker [code] | Mail sweep has no cross-process lock, but the mail key is idempotent [code]. Replica count [unknown]. |
| Workflow step retry after restart | Timers lost; `onApplicationStart` only arms the expiry cleaner [code]. Resume [unknown] | Queued retries survive in Redis [inference] | Not applicable: one transaction, or a retried delivery |
| Lock | In-memory provider is the default (`modules/locking/src/loaders/providers.ts:56`) [code] | Redis provider when configured; a Postgres provider also exists (`modules/providers/locking-postgres`) [code] | Row locks in Postgres [code] |
| Webhook delivery | 200 returned, then an event with a 5 second delay, `attempts: 3` (`api/hooks/payment/[provider]/route.ts`). Lost on crash [inference] | Durable in queue; retried 3 times; then gone [inference] | Applied before answering; 500 makes Stripe redeliver; deduplicated in `payment_event` [code] |

`defineConfig` wires the Redis modules by itself only on Medusa Cloud
(`packages/core/utils/src/common/define-config.ts:415`, under `isCloud`). A self-hosted shop declares them, or
stays on the defaults without any warning at this layer [code]. **BusBasis declares all four Redis modules
whenever `REDIS_URL` is present** (`medusa-config.ts:93`) [code]; whether production sets it is [unknown] but
very likely [inference].

### 3.5 What this cost a real shop

From BusBasis, read only:

- `src/jobs/payment-reconciliation.ts` opens by stating that lost webhook deliveries left orders 43, 47, 67
  and 230 captured on Stripe but uncaptured in Medusa, and adds a sweep that compares Stripe to Medusa and
  alerts [code].
- `src/subscribers/payment-failed.ts` exists "because the default Medusa webhook handler skips FAILED
  actions" [code]. Confirmed in v2.22.2: `medusa/src/subscribers/payment-webhook.ts` returns early on
  `CANCELED` and `FAILED` [code].
- `src/modules/stripe-delayed/` extends the Stripe provider so SEPA (Single Euro Payments Area) direct debit
  creates an order at `charge.pending`, because the stock provider treats `processing` as pending and
  creates none [code].

**Takeaway** [inference]: a real German shop needed payment reconciliation, failure handling and delayed
methods on top of Medusa. These are ordinary needs and framer-clone will meet them too.

## 4. Key flows end to end

### 4.1 Cart to order (`core-flows/src/cart/workflows/complete-cart.ts`) [code]

1. Add to cart: lock the cart, price the variant, `confirmVariantInventoryWorkflow` checks stock (no
   reservation), write lines, then `refreshCartItemsWorkflow` reprices, refreshes shipping, tax lines,
   promotions and the payment collection.
2. Completion: lock on cart id (30 second wait, 2 minute hold). If `order_cart` already links an order,
   return that order. Validate items, payment, shipping (every shipped item's profile must be covered by a
   chosen method: `steps/validate-shipping.ts`).
3. Create the order from the cart snapshot.
4. In parallel: link order to cart, promotions and payment; mark the cart complete; reserve inventory;
   register promotion usage; emit `order.placed`.
5. **Authorise payment last**, so the only things that can fail after money is touched are few.
6. On failure, compensation cancels an authorised payment or refunds a captured one, and undoes the rest.

**The reverse order is the design point.** Medusa reserves stock at the end, after the buyer has paid
off-site or confirmed in a payment element [inference from the storefront contract]. A webhook can even
trigger completion after capture (`completeCartAfterPaymentStep`). So a buyer can be charged for stock that
is gone, and compensation refunds them. framer-clone reserves first, for a 30 minute window, and only then
sends the buyer to pay. A late payment with no stock is the only refund path (`payments.ts`) [code].
framer-clone's order is simpler and safer for small stock counts; its cost is held stock for abandoned
checkouts [inference].

### 4.2 Payment capture [code]

- `Provider webhook -> route -> event bus -> payment-webhook subscriber -> processPaymentWorkflow`
  (`core-flows/src/payment/workflows/process-payment.ts`).
- Actions: `SUCCESSFUL` captures, `AUTHORIZED` authorises. `CANCELED`, `FAILED`, `REQUIRES_MORE`,
  `PENDING` and `PENDING_AUTHORIZATION` are dropped by the subscriber.
- The Stripe provider defaults to manual capture unless `capture: true` (`stripe-base.ts:120`). So
  "authorised" and "captured" are distinct states and a merchant captures in admin.
- If no order exists and the cart is linked, the workflow completes the cart, with
  `continueOnPermanentFailure: true`.
- Provider calls pass idempotency keys derived from session, capture and refund ids
  (`payment-module.ts:577`, `897`, `1197`).

### 4.3 Inventory reservation [code]

- `core-flows/src/cart/steps/reserve-inventory.ts` runs `locking.execute(inventoryItemIds, ...)`, inside
  which `inventory-module.ts` `ensureInventoryLevels` loads levels and compares
  `available_quantity < quantity` in JavaScript.
- `adjustInventory_` reads a level, adds in `MathBN`, and writes back. **The counter is mutable** and no
  ledger exists, confirming the June note.
- Compensation deletes reservations. A reservation has no expiry.
- With several locations, `prepareConfirmInventoryInput` narrows to locations with enough stock and the step
  reserves at the first (`location_ids[0]`). One line is not split across locations.

Atomicity rests entirely on the lock. On the default in-memory provider that holds only inside one process
[inference]. framer-clone's guarded `UPDATE ... WHERE (stocked - reserved) >= needed` holds in the database
regardless of how many processes run [code].

### 4.4 Fulfilment [code]

`core-flows/src/order/workflows/create-fulfillment.ts`: validate quantities, find reservations by line
item, `prepareInventoryUpdate` subtracts from stock and shrinks or deletes the reservation, call the
provider through `createFulfillmentWorkflow`, `registerOrderFulfillmentStep` updates order item quantities,
emit events. **Stock leaves `stocked_quantity` at fulfilment, not at sale.** `create-shipment.ts` records
labels and `shipped_at`; `mark-order-fulfillment-as-delivered.ts` records delivery. The bundled provider
is `fulfillment-manual`; no carrier integration ships in this repository (`packages/modules/providers/`).
BusBasis's calculated shipping is custom [unknown in detail].

### 4.5 Returns [code]

An order change is a draft set of actions, previewed, then confirmed.

1. `begin-return.ts` creates a `Return` and an `OrderChange`.
2. `request-item-return.ts` adds `RETURN_ITEM` actions; `confirm-return-request.ts` confirms, optionally
   creating a return fulfilment (a label), and emits `order.return_requested`.
3. On arrival, `confirm-receive-return-request.ts` marks items received or damaged, adjusts stock for good
   items at the return's location, moves the return to `received` or `partially_received`.
4. `createOrUpdateOrderPaymentCollectionWorkflow` computes the outstanding amount. Refund is a separate
   explicit step through `refundPaymentWorkflow`, not automatic.

`Order.version` increments when a change is applied, and order items are kept per version, so history is
versioned (`order-module-service.ts`, `applyOrderChanges_`).
Exchanges, claims and order edits reuse this one mechanism. **BusBasis uses none of them**, per the
[gap list](2026-11-01-busbasis-native-storefront.md).

### 4.6 Promotions [code]

- `core-flows/src/cart/workflows/update-cart-promotions.ts`: the module computes **actions**, a pure-looking
  list such as "add adjustment of X to line Y", and the workflow turns those into adjustment rows.
- `promotion-module.ts` `computeActions` loads applied codes and automatic promotions, filters by rules
  against a cart context, orders buy-get first, and honours budgets. Implementation in
  `modules/promotion/src/utils/compute-actions/`.
- Usage is registered at order placement. `registerUsage` locks promotion and budget rows in a stable id
  order with `SET LOCAL lock_timeout = '3s'`, so limits cannot be overrun under concurrency.

## 5. Judgement

### 5.1 What is excellent

- **The domain model.** Thirteen modules of well-separated nouns. June already copied
  the catalogue, pricing and inventory shapes. Shipping zones, adjustment lines, the payment
  collection/session/capture split and order item quantities are next [inference].
- **Promotions as compute-actions then apply.** Clean, testable, reusable for previews [inference].
- **Order changes.** One mechanism for every post-sale change [inference].
- **Cart as a priced document** (section 2.2).
- **Provider seams.** `AbstractPaymentProvider` and the fulfilment provider contract in
  `core/utils/src/fulfillment/provider.ts` are small and sharp, and the tax provider is similar [code].
- **Honest code comments.** `complete-cart.ts` documents its failure ordering in full [code].

### 5.2 What is over-built for a small multi-tenant shop host

Size context [code]: `core-flows` 78,643 lines across 343 workflow files; `medusa/src/api` 38,774; order
module 11,438; orchestration, workflows SDK and two engines 13,382; query and links 12,156; 36 packages under
`packages/modules`.

- **Module isolation** [inference]. Its benefit is swapping a module or moving it to its own database.
  framer-clone is one schema per tenant group, and June named real foreign keys as a reason to own the
  stack. Links, remote joiner, SQL pushdown and the Index module together repair a problem framer-clone
  does not have.
- **A general workflow engine** [inference]. A saga buys partial failure handling across databases.
  framer-clone's cart-to-order runs in one Postgres transaction, which is strictly stronger and needs no
  compensation code. Sagas earn their keep only around external calls, and there are few.
- **Exchanges, claims, order transfer, draft orders, order edits** [inference]: unused by BusBasis, and rare
  for a small shop.
- **Regions, sales channels, publishable keys** [inference]: a framer-clone site is already the channel.
- **Campaigns and per-attribute budgets** [inference]: a discount code with a limit and dates covers small
  shops.

### 5.3 What it costs

- **Redis is effectively required for production** [inference from section 3.4]. Per shop that is one
  more stateful service.
- **One server, worker, Postgres and Redis per shop, and one upgrade per shop** [code for no tenancy,
  inference for the ops].
- **Extension through hooks and subscribers** means business logic is spread across files and runs
  asynchronously, so "what happens when an order is placed" is not readable in one place [inference].
- **Reads cost more**: `query.graph` issues several queries and joins in memory [code for the mechanism,
  performance [unknown], nothing was run].
- **Money as `BigNumber` plus `raw_*` JSON** on every amount [code]: flexible for very small currency units
  and quantities, more machinery than framer-clone's integer minor units need [inference].

### 5.4 Why June ruled out one Medusa server per shop

The June decision (`knowledge-base/research/2026-06-01-owned-realtime-commerce-architecture.md`) says Medusa
is single tenant per deployment, so "switch on commerce for any client" means N instances, N upgrade
treadmills, N Redis fleets and N backup runbooks for a 1 to 2 person team. **Section 2.1 confirms the core
claim from source.** Further June points that held up: stock is a mutable counter, not a ledger, and variant
to price and inventory have no foreign keys [code]. One refinement: June says Medusa has "real
transactions". That is true inside one module only; across modules it is a saga [inference from section 3.2].

June's reasons were about the shop host. They do not argue against BusBasis staying on Medusa, where the
server already exists. June also planned a live co-editing plane for catalogue content; the ledger exists,
and that plane is still not built (no Hocuspocus, the planned sync server, in `package.json`) [code].

### 5.5 framer-clone against Medusa, capability by capability

Ranked by value to ordinary shops. "Has" means on `origin/main`. Sizes are judgement, and include tests.
They overlap with, and do not add to, the [BusBasis gap list](2026-11-01-busbasis-native-storefront.md).

| Rank | Capability | framer-clone has | Decision | Why | Size |
|---|---|---|---|---|---|
| 1 | Outbox, jobs, reconciliation | Three private versions: `payment_event` (inbound dedupe), `shop_mail` (outbox), lazy `sweepExpiredPayments` | **Adapt**, not Medusa's bus: section 6.1 | Stronger than Medusa default, no Redis | 1 to 1.5 weeks |
| 2 | Server-side checkout | No: `src/lib/commerce/cart.tsx` is browser `localStorage` by design | **Adopt** the priced document, as a checkout record | Shipping and discounts need a server price before payment | 1 week |
| 3 | Shipping | No | **Adapt**: zone, option, flat or threshold price, pickup; profiles reduced to a "needs a form" flag | Every physical shop needs it. Skip fulfilment sets and geo-zone depth | 2 weeks |
| 4 | Order list and fulfilment | `applyInventoryEffect` `fulfill` exists with no caller; no list | **Adopt** Medusa's order item quantities and fulfilment rows, with a shipped email | Owner cannot work without it | 1.5 to 2 weeks |
| 5 | Discount codes | No | **Adopt** compute-actions and adjustment rows; **skip** campaigns, buy-get first | Common; legally touches VAT and receipts | 1.5 to 2 weeks |
| 6 | Refunds, partial | Full refund only: one `refund_id` per payment | **Adopt** Capture and Refund as rows and a Books credit note link | Every shop refunds | 1 week |
| 7 | Returns, light | No | **Adapt**: return, item, reason, received, restock, refund. **Skip** the 23-action change engine | EU withdrawal right makes this ordinary | 1 to 1.5 weeks |
| 8 | Delayed and other payment methods | Stripe hosted checkout. No `processing` or `checkout.session.completed` handling (`stripe/webhook.ts`), and a 30 minute window | **Adapt** the BusBasis lesson: a `processing` state that keeps stock held | SEPA and Klarna are normal in Germany | 0.5 to 1 week after rank 1 |
| 9 | Shopper accounts | No; buyer stored on the payment | **Adapt** Customer and Address per company; guest order claimed by email | Repeat buyers. Auth choice is open | 2 to 3 weeks |
| 10 | Categories and search | Collections, tags; no public search | **Adopt** the category tree. **Skip** Index module; use Postgres text search | Needed from a few hundred products | 2 weeks |
| 11 | Price rules | `price_rule` stored, not evaluated (`pricing.ts` comment) | **Adapt** when groups exist; lists and quantity bands already work | Customer groups come after accounts | 0.5 week |
| 12 | Tax beyond Germany | `src/server/tax/germanVat.ts`, one region constant `DE` in the order route | **Adapt**: rates by country, plus One Stop Shop tracking per June | Needed for EU sales | 1 to 2 weeks |
| 13 | Offers and quotes | Books know an offer type; no flow | **Keep** in Books, do not copy draft orders | Platform plan item 4 | Listed there |
| 14 | Multi-currency, regions | No | **Skip** until a shop asks. Keep `currency_code` on everything (already so) | German-speaking focus | 1 week when needed |
| 15 | Kits | `reserveKit` exists with lock ordering, but `createOrder` calls only `reserve` | **Keep**, wire it in when a shop sells a kit | Medusa does this in the normal path through `required_quantity` | Small |
| 16 | Stock and backorder policy, idempotency, money, tax snapshots | Yes | **Keep** | Better than Medusa: section 3.4 | None |
| 17 | Multi-location stock | Tables exist; one default per workspace | **Keep**, add picking when a shop has two locations | Rare | Small |
| 18 | Gift cards, store credit | No | **Skip** for now | Legal and accounting weight | None |
| 19 | Exchanges, claims, order edits, order transfer | No | **Skip** | BusBasis does not use them | None |
| 20 | Module links, remote query, workflow engine, Redis, sales channels, regions as modules | No | **Skip** | Section 5.2 | None |

**Reading of the table** [inference]: ranks 1 to 8 are what makes a shop operable, about 9.5 to 12 agent weeks.

**Defect to fix first, independent of all this** [code, read not reproduced]: `sweepExpiredPayments` is
called only from `src/app/api/commerce/orders/[orderId]/pay/route.ts`. Nothing schedules it. The checkout
calls `POST /api/commerce/orders`, which reserves stock and opens a pending payment, and then the pay route.
If a buyer stops between the two, no Stripe session exists, so `checkout.session.expired` never arrives. The
stock stays reserved until some buyer of the same company reaches the pay route. If that was the last unit
of the only product in stock, every other buyer gets a shortage answer (HTTP 409) at order creation and never reaches the pay
route, so the hold has no end. Move the sweep to the scheduler (one small change, independent of the
backbone).

Two smaller findings of the same kind [code]:

- A paid order whose receipt failed depends on Stripe delivering again, which stops after a few days, and
  the reason sits in `order_payment.receipt_error` with no order list to show it.
- Nothing compares Stripe to framer-clone. BusBasis needed exactly that (section 3.5).

## 6. What must be designed before more shop features pile up

Each of these changes tables that later features write to. 6.1 and 6.2 are ranks 1 and 2 above, about 2 to
3 agent weeks, and come first. 6.3 to 6.5 are decisions made inside the shipping and order plans.

### 6.1 One outbox and job table, on Postgres

**Problem** [code]: three private versions already exist. Receipt, mail and expiry each decide retry and
timing for themselves: Stripe redelivery for receipts, a `setInterval` per process for mail
(`src/instrumentation.node.ts`, `mail/runtime.ts`), a call on someone else's request for expiry. Accounts,
shipping, stock alerts and search would each add another.

**Proposal** [inference, for review]:

- `commerce_event` in each `tg_<id>` schema: written in the transaction of the change it describes (`tenant_id`,
  type, payload of ids only, `created_at`).
- `commerce_delivery`: one row per consumer and event, with attempts, `next_attempt_at`, `last_error` and
  status (`pending`, `done`, `dead`). This is the `shop_mail` table generalised. Letter freezing stays in
  mail.
- One sweep per process, claiming work with `FOR UPDATE SKIP LOCKED`, so replicas are safe.
- `commerce_job` for time-based work (expiry, reconciliation), claimed the same way.
- Dead rows surface to the shop owner in the order list and to platform alerting.
- `payment_event` stays: inbound dedupe is a separate concern.
- Consumers are plain functions registered in one file, so "what happens when an order is paid" is one
  list in one place. That answers Medusa's spread-out subscribers.

**Not proposed**: Redis, BullMQ, a saga engine, an external broker. At this volume Postgres is enough, and
a transactional write is what those would lack.

**Migrations**: `shop_mail` keeps working until a later change moves it. Pre-launch rules allow rewriting it
in place, and live test data has to be checked first. **Open:** how the sweep walks all `tg_` schemas when
there are many (the mail sweep does this today, per group).

### 6.2 Server-side checkout record

Keep the anonymous browser cart for browsing. Add a `checkout` row, with lines, the chosen shipping option,
applied codes, address and computed adjustment and tax rows. `createOrder` then snapshots it in the
existing single transaction. Follow the existing rule: the server is sole author of money.

**Backtrack rule** (the four paths in `knowledge-base/standards/stateful-flow-testing.md`): a checkout total is derived
state, so changing an address, quantity or code recomputes everything, and a resumed checkout reprices
before it pays. A paid or expired checkout is never reused.

### 6.3 The order total identity and the VAT rule

The database enforces `total = subtotal + tax_amount` (`005_minimal_orders`), and `receipt.ts` deletes the
draft unless Books totals equal the order [code]. Discounts and shipping must change that identity, and
**Books and the order must keep one tax computation**. To decide: discount before tax per rate; shipping tax
follows the items (usual German practice, to confirm with the accounting owner) [unknown]; shipping and
discount as receipt lines. This is a legal and accounting question, so it goes to Marlin with a
recommendation when the shipping plan is written.

### 6.4 Order state

`order` is append-only by design, and `order_payment` is its state [code]. Fulfilment and returns need the
same pattern, not new columns on `order`:

- `order_payment` gains `payment_capture` and `payment_refund` rows.
- `order_item_state` holds fulfilled, shipped, delivered and returned quantities per line.
- `order_action` is an append-only log (who, what, when). Copy the audit value of `OrderChange`, not its
  preview engine.
- Displayed order status is derived, never stored twice.

### 6.5 Seams, drawn before they have a second implementation

Shipping provider (`rates`, `createLabel`), discount computation (a pure function returning actions, so the
editor can preview it), and authorise versus capture in `PaymentProvider`. Each new table carries
`tenant_id` (the company) inside the `tg_` schema, and `site_id` where a site narrows it. A site stays the
sales channel: `product_site_hidden` already does this.

## 7. Recommendation

**Decided here, say so if you disagree:**

- framer-clone does not adopt any Medusa runtime piece (module links, workflow engine, event bus, Redis).
- A saga is used only around a provider call, written by hand, following the pattern `refundLatePayment`
  already uses: write the intent first, then call the provider with an idempotency key.
- Medusa's nouns are copied for shipping, adjustments, payments and fulfilment, without the module split.

**Sequence:**

1. Fix the expiry sweep now.
2. Design 6.1 and 6.2 in one plan, then build the outbox with receipts, mail and expiry as first consumers,
   and add a Stripe reconciliation job.
3. Resolve 6.3 and 6.4 in the shipping and order plans.
4. Build shipping, then order list and fulfilment, then discounts, then refunds and returns, then payment
   methods.
5. Accounts, categories and search after that, or earlier if a real shop needs them.

**For Marlin to decide** (section 6.3 and the existing open question):

- The VAT treatment of shipping and discounts, once the accounting owner has confirmed it.
- Whether this order suits the shop actually coming next. A shop that sells only digital goods or services
  would skip shipping and raise accounts.

## 8. Unknown

- **Restart behaviour of the in-memory engine.** I read that `onApplicationStart` only arms the expiry
  cleaner, and found no resume in either engine's services. I did not run it.
- **Redis engine after a worker crash in mid-step.** Queued jobs survive; a step running without a queued
  follow-up may not resume.
- **Runtime cost of Medusa.** Nothing was run: no timing, memory or query counts.
- **Differences between 2.19.0 and 2.22.2.** A `medusa-fork` checkout also sits beside BusBasis
  (`MedusaJS/medusa-fork`); whether BusBasis depends on it, and why it exists, I did not establish.
- **BusBasis's production `REDIS_URL`, and how its calculated shipping works.**
- **framer-clone replica count.** My search of `deploy/` for it found nothing, so the safety of the mail
  sweep across replicas was judged only from its idempotency key.
- **The expiry defect** is read from code and was not reproduced on a running shop.
- **SEPA on framer-clone.** The hosted checkout's behaviour with delayed methods is unchecked, as the gap
  list already says.
- **German VAT on shipping and discounts** in section 6.3 needs the accounting owner.

## Reality

- 2026-11-01: research only, no implementation. Medusa clone read as data and deleted. The roadmap line
  lands through another pull request, as agreed.
