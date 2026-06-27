---
type: plan
status: draft
title: "MedusaJS Inventory / Reservation / Backorder Model: Implementation-Grade Reference"
summary: "Authoritative, docs-grounded reference on how Medusa models inventory items, levels, reservations, and the manage_inventory / allow_backorder policy flags, plus the exact schema and reserve-path changes our custom Postgres commerce engine needs to support backorder."
date: 2026-06-27
tags: [commerce, inventory, backorder, medusa, reference]
projects: [framer-clone]
---

# MedusaJS Inventory / Reservation / Backorder Model: Implementation-Grade Reference

> Purpose: We are NOT building on Medusa. We study Medusa as the reference implementation and reimplement the relevant inventory / reservation / backorder behavior in our own schema-per-tenant Postgres commerce engine. Every claim below links to the official docs page it came from. Where the docs only imply a behavior (e.g. negative availability), it is flagged as an inference from the model, not a verbatim doc statement.
>
> Medusa docs feedback: POST https://docs.medusajs.com/agents/feedback with {agent, path, feedback} for specific, actionable doc issues. (Not used here; noted per the docs' agent instructions.)

---

## 1. Data model

### 1.1 InventoryItem

- An `InventoryItem` is "a stock-kept item whose inventory can be managed. For example, a product." It is the abstraction over a sellable, stock-tracked thing (typically a product variant). Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).
- Carries `requires_shipping` (boolean, enabled by default) indicating whether the item needs shipping, and a `sku`. Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).
- One `InventoryItem` can be linked to a product variant; in inventory kits it can be re-used / shared across variants. Source: [Inventory Kit](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-kit).

### 1.2 InventoryLevel (the quantity record, per location)

`InventoryLevel` "stores the inventory and quantity details of an inventory item in a specific location." There is one level row per `(inventory_item, stock_location)` pair. Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).

Fields (verbatim semantics):

| Field | Meaning (verbatim from docs) |
|---|---|
| `stocked_quantity` | "The available stock quantity of an item in the associated location." (i.e. physical on-hand at this location) |
| `reserved_quantity` | "The quantity reserved from the available `stocked_quantity`. This quantity is still in stock but unavailable when checking if an item is available." |
| `incoming_quantity` | "The incoming stock quantity of an item into the associated location. This property doesn't affect the `stocked_quantity` or availability checks." (informational, restock pipeline) |
| `location_id` | Links the level to a `StockLocation`. |

Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).

**Available quantity is derived, not stored** (in Medusa): the `getVariantAvailability` utility computes availability by, "when retrieving the `stocked_quantity` of each of the inventory levels, the `reserved_quantity` is subtracted from it." So:

```
available = stocked_quantity - reserved_quantity
```

Source: [Get Product Variant Inventory Quantity](https://docs.medusajs.com/resources/commerce-modules/product/guides/variant-inventory) and [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts). Key model property: `reserved_quantity` does NOT reduce `stocked_quantity` — both quantities coexist in the level; reservation only moves quantity from "available" to "reserved", it does not remove it from stock. The physical decrement happens later, at fulfillment (see §3).

**Crucial nuance: `incoming_quantity` is informational only** and never enters availability or purchasability math. Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).

### 1.3 ReservationItem

- "Represents unavailable quantity of an inventory item in a location." Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).
- Created automatically when an order is placed, storing "the reserved quantity of the inventory item in the location associated with the order's sales channel." It is location-scoped, with a relationship to the `InventoryLevel` analogous to the Stock Location link. Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).
- Can ALSO be created manually in the Admin (e.g. reserve stock for an offline sale or a customer request). A reservation holds: inventory item (by SKU), location, quantity. Source: [Manage Reservations in Medusa Admin](https://docs.medusajs.com/user-guide/inventory/reservations).
- The sum of a level's reservation items is its `reserved_quantity`.

### 1.4 Stock Location and the variant -> inventory link

- A `StockLocation` is a "location of stock-kept items" (e.g. a warehouse). Medusa "links stock locations with data models of other modules that require a location, such as the Inventory Module's `InventoryLevel`." Source: [Stock Location Module](https://docs.medusajs.com/resources/commerce-modules/stock-location).
- Variant -> inventory link: when a variant is created with `manage_inventory = true` and `inventory_items` set, Medusa "creates an inventory item using the Inventory Module and links it to the product variant." Source: [Product Variant Inventory](https://docs.medusajs.com/resources/commerce-modules/product/variant-inventory).
- The link can carry a `required_quantity` ("how much quantity is consumed of the part's inventory when [the product] is sold"). A single variant can link to MULTIPLE inventory items (an "inventory kit" / multi-part or bundled product), and inventory items can be shared across variants. Source: [Inventory Kit](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-kit).

### 1.5 Multi-location semantics

- Inventory is tracked per location: one `InventoryLevel` per `(inventory_item, location)`. Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).
- Availability is computed PER SALES CHANNEL: "a product variant's inventory quantity is set per stock location. This stock location is linked to a sales channel." `getVariantAvailability` therefore takes the variant + the sales channel and returns availability "in the stock location linked to the sales channel," summing `stocked - reserved` across the location levels in that sales channel's scope. Source: [Get Product Variant Inventory Quantity](https://docs.medusajs.com/resources/commerce-modules/product/guides/variant-inventory) and [Retrieve Variant Inventory in Storefront](https://docs.medusajs.com/resources/storefront-development/products/inventory).
- So the sales-channel -> stock-location link is what scopes "is this variant in stock for this storefront."

---

## 2. The two policy flags, exactly

Both flags live on the **product variant** and are **disabled (false) by default**. Source: [Product Variant Inventory](https://docs.medusajs.com/resources/commerce-modules/product/variant-inventory) and [Manage Product Variants (Admin)](https://docs.medusajs.com/user-guide/products/variants).

### `manage_inventory`
- `true`: Medusa "tracks the inventory of the product variant using the Inventory Module"; when a customer purchases the variant, Medusa decrements the stocked quantity (at fulfillment). Purchasability is gated by stock. Source: [Product Variant Inventory](https://docs.medusajs.com/resources/commerce-modules/product/variant-inventory).
- `false`: Medusa "always considers the product variant to be in stock" (e.g. digital / unlimited goods). No inventory item is required, no reservation is created, no stock check. `getVariantAvailability` returns `0` for such variants, but they are still treated as in stock. Source: [Product Variant Inventory](https://docs.medusajs.com/resources/commerce-modules/product/variant-inventory) and [Get Product Variant Inventory Quantity](https://docs.medusajs.com/resources/commerce-modules/product/guides/variant-inventory).

### `allow_backorder`
- `true`: Medusa "allows customers to purchase the product variant even when it's out of stock" (pre-order / on-demand). The cart-add inventory validation is bypassed for this variant. Source: [Product Variant Inventory](https://docs.medusajs.com/resources/commerce-modules/product/variant-inventory) and [confirmInventoryStep](https://docs.medusajs.com/resources/references/medusa-workflows/steps/confirmInventoryStep).
- `false`: purchase is blocked once stock is depleted (default). Source: [Product Variant Inventory](https://docs.medusajs.com/resources/commerce-modules/product/variant-inventory).

### 2.1 Purchasability truth table

`requested` = quantity being added/ordered (times `required_quantity` for kit parts). `available = stocked - reserved` at the sales channel's location(s).

| `manage_inventory` | `allow_backorder` | `available >= requested` | Add to cart / purchasable? | `reserved_quantity` change at order placement |
|---|---|---|---|---|
| `false` | (any) | n/a — always "in stock" | YES | none — no inventory item, no reservation created |
| `true` | `false` | YES | YES | `+requested` (stays `reserved <= stocked`) |
| `true` | `false` | NO | NO — `confirmInventoryStep` throws on add-to-cart | n/a (never placed) |
| `true` | `true` | YES | YES | `+requested` |
| `true` | `true` | NO (out of stock) | YES — backorder | `+requested`; `reserved` can exceed `stocked` -> `available` goes negative |

Truth-table sources: cart-add validation throws on insufficient stock for `manage_inventory` variants ([Inventory in Flows](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-in-flows)); `allow_backorder` bypasses that validation ([confirmInventoryStep](https://docs.medusajs.com/resources/references/medusa-workflows/steps/confirmInventoryStep)); reservation created at order placement only for `manage_inventory = true` variants ([Inventory in Flows](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-in-flows)).

**Does `available` go negative under backorder?** The docs do not say this in words, but it follows directly from the model and is the behavior to replicate:
1. `available = stocked - reserved` with no floor and no documented constraint. Source: [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).
2. At order placement Medusa "creates a reservation item for each product variant with `manage_inventory` set to `true`" — unconditionally, regardless of stock. Source: [Inventory in Flows](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-in-flows).
3. Therefore a backorder pushes `reserved_quantity` above `stocked_quantity`, and `available = stocked - reserved` is negative. Medusa has NO equivalent of our `CHECK (reserved <= stocked)` constraint, which is exactly why it can backorder. (Inference from 1+2; flagged as not-verbatim.)

So in Medusa, negative availability is the natural representation of "this much is backordered." There is no separate backorder counter — the negative `available` IS the backorder depth.

---

## 3. Reservation lifecycle (where reserve and decrement happen)

The single most important structural fact: **reservation (at order placement) and physical stock decrement (at fulfillment) are two separate events.** `stocked_quantity` is untouched from order placement until fulfillment; only `reserved_quantity` moves.

| Stage | Workflow | Effect on `stocked_quantity` | Effect on `reserved_quantity` | Reservation row |
|---|---|---|---|---|
| Variant created (`manage_inventory=true`, `inventory_items` set) | `createProductVariantsWorkflow` | inventory item + level created | — | — |
| Add to cart | `addToCartWorkflow` -> `confirmInventoryStep` | unchanged | unchanged | none — VALIDATION ONLY: "checks whether there's sufficient stocked quantity. If not, an error is thrown" (bypassed if `allow_backorder`) |
| Order placed | `completeCartWorkflow` | unchanged | `+ ordered qty` | reservation item CREATED (only for `manage_inventory=true` variants) |
| Order fulfilled | `createOrderFulfillmentWorkflow` | `- reserved_quantity` | reset to `0` | reservation item DELETED |
| Order canceled | `cancelOrderWorkflow` -> `deleteReservationsByLineItemsStep` | unchanged | released (`- reserved`) | reservation item(s) DELETED |
| Order item returned (accepted) | `confirmReturnReceiveWorkflow` | `+ returned qty` | — | — |
| Returned item dismissed/damaged | `confirmReturnReceiveWorkflow` | unchanged (does NOT increment) | — | — |

Sources: [Inventory in Flows](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-in-flows), [confirmInventoryStep](https://docs.medusajs.com/resources/references/medusa-workflows/steps/confirmInventoryStep), [cancelOrderWorkflow](https://docs.medusajs.com/resources/references/medusa-workflows/cancelOrderWorkflow).

Key takeaways:
- **Reserve != decrement.** Reserving only increments `reserved_quantity`; `stocked_quantity` is unchanged. The actual physical decrement (`stocked -= reserved; reserved = 0; delete reservation`) happens ONLY at fulfillment. Source: [Inventory in Flows](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-in-flows).
- **Reservation is created at order placement, not at cart line add.** Cart add is validation only. This means Medusa has an inherent oversell window between add-to-cart validation and order placement: two carts can both pass the non-atomic check and both reserve. (See §6 — our atomic guarded decrement closes this window and is stronger than Medusa here.)
- **Release vs convert.** Cancel = release (delete reservation, free the reserved quantity). Fulfillment = convert (turn the reservation into a real `stocked_quantity` decrement). Return = restock (`stocked += returned`).
- **Idempotency / concurrency:** the public docs describe these as workflow steps; they do NOT specify DB-level locking or idempotency-key semantics for the reservation write. That concurrency contract is ours to design (our `UNIQUE(request_id)` + guarded `UPDATE ... WHERE` already does this; Medusa's docs do not promise it). Flagged: not specified by Medusa docs.

---

## 4. Availability + fulfillment checks

- **Compute availability:** `getVariantAvailability(variant_ids, sales_channel_id)` -> per variant, `availability = sum over the sales-channel's stock locations of (stocked_quantity - reserved_quantity)`. For `manage_inventory=false` variants it returns `0` (but they are still purchasable). Source: [Get Product Variant Inventory Quantity](https://docs.medusajs.com/resources/commerce-modules/product/guides/variant-inventory).
- **Storefront "is in stock" (simplified):**
  ```ts
  const isInStock = variant.manage_inventory === false || variant.inventory_quantity > 0
  ```
  where `inventory_quantity` is the computed availability for the sales channel. Source: [Retrieve Variant Inventory in Storefront](https://docs.medusajs.com/resources/storefront-development/products/inventory). NOTE: this storefront snippet omits `allow_backorder`; the authoritative purchasability gate is the SERVER-side `confirmInventoryStep`, which DOES honor `allow_backorder` (bypasses the stock check). Treat the storefront check as a display hint, the server step as the contract. Source: [confirmInventoryStep](https://docs.medusajs.com/resources/references/medusa-workflows/steps/confirmInventoryStep).
- **"Can this order be fulfilled":** fulfillment subtracts `reserved_quantity` from `stocked_quantity`; if a manage_inventory item was backordered, `stocked` may be insufficient at fulfillment time — that is the operational signal to restock (driven by `incoming_quantity`, which is informational and never gates the sale). Source: [Inventory in Flows](https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-in-flows), [Inventory Concepts](https://docs.medusajs.com/resources/commerce-modules/inventory/concepts).
- **Cross-location / cross-sales-channel:** availability is always evaluated within the sales channel's linked stock locations; a variant can be in stock in one sales channel and out in another depending on which locations each channel maps to. Source: [Get Product Variant Inventory Quantity](https://docs.medusajs.com/resources/commerce-modules/product/guides/variant-inventory).

---

## 5. Admin config surface

- Both flags are set **per variant** as toggles, in the variant's Details step at creation and in the variant edit panel afterward:
  - "Manage Inventory" — "Enable ... if you want Medusa to track the inventory of this variant. If disabled, the variant is always considered in stock."
  - "Allow backorders" — "Enable ... if you want to allow customers to purchase the variant even if it's out of stock."
  - Source: [Manage Product Variants (Admin)](https://docs.medusajs.com/user-guide/products/variants).
- No product-level default for these toggles; the bulk editor manages stock LEVELS, not these policy flags. Source: [Manage Product Variants (Admin)](https://docs.medusajs.com/user-guide/products/variants).
- Reservations: created automatically on purchase, and can be created MANUALLY in Admin (Inventory -> Reservations) for offline sales / customer holds; the create form shows live available quantity that updates as you change the reserved amount. Source: [Manage Reservations (Admin)](https://docs.medusajs.com/user-guide/inventory/reservations).
- There is no separate "continue selling when out of stock" setting; `allow_backorder` IS that setting (Shopify's "continue selling when out of stock" maps 1:1 to Medusa's `allow_backorder`).

---

## 6. Implications for OUR engine

Our current state: `inventory_item`, `stock_location`, `inventory_level` (`stocked_quantity`, `reserved_quantity`, GENERATED `available_quantity = stocked_quantity - reserved_quantity STORED`), `stock_movement`, `reservation`, `fulfillment_location_default`; a hard `CHECK (reserved_quantity <= stocked_quantity)`; a guarded-decrement reserve under READ COMMITTED with `UNIQUE(request_id)` idempotency and ascending-id kit lock ordering. Variants have NO flags yet; inventory keyed to variants via SKU bridge (`inventory_item.sku == product_variant.sku`).

### 6.1 Schema changes (flags + where they live)

Add the two flags to **`product_variant`** (the sellable/merchandising unit), matching Medusa exactly. They are NOT on `inventory_item` and NOT on `inventory_level`:

```sql
ALTER TABLE product_variant
  ADD COLUMN manage_inventory boolean NOT NULL DEFAULT true,
  ADD COLUMN allow_backorder  boolean NOT NULL DEFAULT false;
```

- Why per-variant, not per-level: purchasability is a merchandising policy about the sellable unit. `inventory_item` / `inventory_level` are physical stock truth that can be shared/reused across variants (kits). Backorder is NOT a per-location concept in Medusa — a variant either allows backorder or it doesn't, across all its locations. Keep it that way.
- `allow_backorder` default `false` matches Medusa.
- `manage_inventory` default: Medusa defaults `false`, but our engine was built SKU-bridge-first (every tracked SKU already has an inventory_item/level). Recommend default `true` for us so existing tracked SKUs keep their current "stock is real" behavior, and let digital/unlimited variants opt out by setting `false`. (This is a deliberate divergence from Medusa's default; flagged as Open Question Q1.) When `manage_inventory = false`, the reserve path is a no-op and the variant is always sellable.

### 6.2 The `CHECK (reserved_quantity <= stocked_quantity)` constraint: DROP it

Verdict: **the table-level CHECK must be dropped.** Backorder REQUIRES `reserved > stocked` (negative available); Medusa has no such constraint, which is precisely how it backorders.

Why a conditional CHECK can't save it: the flag lives on `product_variant`, but the constraint is on `inventory_level`, which has no knowledge of the variant's `allow_backorder`. A table CHECK cannot express "block oversell only for non-backorder variants." So the oversell guard must move OUT of the schema and INTO the reserve path's `WHERE` clause, where the caller knows the variant's flags (§6.3). This is the right place anyway — the guarded `UPDATE ... WHERE (stocked - reserved) >= n` is already an atomic, conditional oversell backstop.

```sql
ALTER TABLE inventory_level DROP CONSTRAINT inventory_level_reserved_lte_stocked; -- name per actual constraint
```

The GENERATED `available_quantity = stocked_quantity - reserved_quantity STORED` column: **keep it as-is.** A generated/stored column has no problem going negative (there's no CHECK on it). Under backorder it simply becomes negative, which — exactly as in Medusa — IS the backorder depth. Downstream "is in stock" logic must read negative `available_quantity` as "backordered," not "unavailable": a variant is sellable iff `NOT manage_inventory OR available_quantity > 0 OR allow_backorder`. Do NOT add a `CHECK (available_quantity >= 0)`.

### 6.3 The reserve heart: 3-case branch on the flags

The reserve call operates on `inventory_level` rows (keyed by inventory_item / SKU), but the policy is per-variant. Resolve the variant's `manage_inventory` / `allow_backorder` ONCE at the top of the reserve (join SKU -> variant, or pass the flags in from the caller who already loaded the variant). For a kit (one variant -> many inventory items via `required_quantity`), the kit variant's flags govern ALL its component reserves. Preserve READ COMMITTED, `UNIQUE(request_id)` idempotency, and ascending-id kit lock ordering in every case.

**Case A — `!manage_inventory`: no tracking.**
No reservation row, no decrement, no stock_movement. Return `{ ok: true }` immediately (variant is always sellable). Mirrors Medusa: no inventory item / no reservation for `manage_inventory = false`.

**Case B — `manage_inventory && allow_backorder`: reserve always succeeds.**
Drop the `(stocked - reserved) >= n` guard. Unconditional increment; `reserved` may exceed `stocked`, driving `available_quantity` negative (the backorder).
```sql
UPDATE inventory_level
   SET reserved_quantity = reserved_quantity + :n
 WHERE inventory_item_id = :item
   AND location_id = :loc;            -- NO availability guard
```
Still insert the reservation row, still idempotent via `request_id`, still lock kit components in ascending id order.

**Case C — `manage_inventory && !allow_backorder`: current guarded decrement (UNCHANGED).**
```sql
UPDATE inventory_level
   SET reserved_quantity = reserved_quantity + :n
 WHERE inventory_item_id = :item
   AND location_id = :loc
   AND (stocked_quantity - reserved_quantity) >= :n;   -- atomic oversell backstop
-- 0 rows affected  ->  return { ok: false, shortages: [...] }
```

Notes:
- The `WHERE (stocked - reserved) >= n` guard is now the oversell backstop that the dropped CHECK used to provide — but conditional on the flags and atomic under READ COMMITTED. This is STRONGER than Medusa, whose add-to-cart validation is non-atomic and separate from the order-placement reservation (Medusa's oversell window). Our reserve gate is the authoritative purchasability check.
- Decrement (`stocked -= reserved`) still happens at FULFILLMENT, not at reserve — mirror Medusa. Our `stock_movement` row records the reserve; a separate fulfillment movement does `stocked -= reserved; reserved = 0; delete reservation`. Confirm our fulfillment path matches.
- Cancel/abandon: delete the reservation rows and `reserved -= n` (release). Mirror `deleteReservationsByLineItemsStep`.
- Kit reserve with mixed need: resolve flags once; if the kit variant is non-backorder, EVERY component reserve uses Case C (any single shortage fails the whole kit, rolled back); if backorder, every component uses Case B.

---

## 7. Open questions / decisions for Marlin

1. **`manage_inventory` default.** Medusa defaults it `false` (untracked unless you opt in). Our SKU-bridge model already assumes tracking. Recommend default `true` for us (every bridged SKU stays stock-gated; digital/unlimited opts out). Confirm, or match Medusa's `false`.
2. **Backorder granularity.** Medusa backorder is variant-level, not per-location. Our `inventory_level` is per `(item, location)`. Recommend keeping backorder a variant-level policy (no per-location backorder flag). Confirm we don't want per-location backorder.
3. **Negative-availability representation.** Keep the GENERATED `available_quantity` (allowed to go negative) as the single source of truth for backorder depth (Medusa-style), or add an explicit `backordered_quantity` view/column for reporting? Recommend keep the generated column; derive backorder depth as `GREATEST(0, -available_quantity)` in queries.
4. **When does stock physically decrement?** Mirror Medusa (decrement only at fulfillment; `stocked` constant from order placement to fulfillment), vs decrement at order placement. Recommend mirror Medusa — reserve != decrement — so cancels are clean releases and reporting matches. Confirm our `stock_movement` semantics already separate reserve from fulfillment.
5. **Cart-hold vs reserve-at-placement.** Medusa validates at add-to-cart (no hold) and only reserves at order placement, leaving an oversell window. Our atomic guarded reserve closes that window. Decision: do we keep reserve strictly at order placement (Medusa parity, simplest), or also add a soft cart-level hold (TTL reservation) for high-contention drops? Recommend: order-placement reserve only for now; revisit soft-holds if oversell pressure appears.
6. **Multi-location now or later.** Medusa sums availability across a sales channel's stock locations. Single-tenant-first, we have `fulfillment_location_default`. Decision: ship single-default-location reserve now (cheapest), but keep the reserve `location_id`-parameterized so multi-location summing and per-channel location maps drop in later. Recommend yes.
7. **`incoming_quantity` in availability.** Medusa keeps it purely informational (never gates a sale). Do we ever want "available to promise" = `available + incoming`? Recommend keep incoming OUT of the reserve path (informational only), matching Medusa, to avoid promising stock we don't have.
8. **Sales-channel scoping of purchasability.** Medusa's purchasability is scoped per sales channel via its location map. Single-tenant-first we may not have sales channels yet. Decision: introduce a minimal "channel -> location(s)" mapping now, or assume one implicit channel = default location until storefront/channel work lands? Recommend the implicit-single-channel shortcut now, with the data model shaped to add channels later.

---

## 8. Domain survey: Medusa's full commerce module surface (one line each)

High-level map only, to later scope "how much Medusa parity" we want. The inventory/backorder model above is the priority; these are NOT deep-dived. Module list source: [Commerce Modules index](https://docs.medusajs.com/resources/commerce-modules) (taglines for the starred ones are verbatim from the docs index `llms.txt`).

| Module | One-line purpose |
|---|---|
| Product | Product catalog: products, variants, options, categories, collections, tags, bulk edits. (docs tagline: "Variants, categories, and bulk edits") |
| Pricing | Price lists, price sets, currency/region-aware prices, price rules and tiers. |
| Inventory | Stock-kept items, per-location levels, reservations, multi-warehouse. (docs tagline: "Multi-warehouse and reservations") — covered above. |
| Stock Location | Physical locations (warehouses) that hold inventory; linked to channels + inventory levels. (docs tagline: "Locations of stock-kept items") |
| Order | Order lifecycle, edits, returns, exchanges, claims, omnichannel management. (docs tagline: "Omnichannel order management") |
| Cart | Add-to-cart, line items, checkout, totals, promotions/tax application. (docs tagline: "Add to cart, checkout, and totals") |
| Fulfillment | Shipping options, fulfillment providers, fulfilling/shipping order items. (docs tagline: "Order fulfillment and shipping") |
| Payment | Payment sessions, providers, captures/refunds, payment collections. |
| Promotion | Discounts, campaigns, promotion rules (percentage/fixed, conditions). |
| Tax | Tax regions, tax rates, tax providers, line-item tax calculation. |
| Sales Channel | Omnichannel selling; scopes products + stock locations per channel. (docs tagline: "Omnichannel sales") |
| Customer | Customers and customer groups, addresses, account vs guest. |
| Region | Regions: countries, currency, tax + payment/fulfillment provider scoping. |
| Currency | Supported currencies and currency metadata. |
| API Key | Publishable (storefront) and secret (admin) API keys, channel scoping. |
| Auth | Authentication identities + providers (the auth layer behind users/customers). |
| User | Admin users (back-office accounts). |
| Store | Store-level settings (name, default currency, default sales channel/region). |
| Notification | Outbound notifications (email/SMS) via notification providers. |
| Loyalty | Loyalty points / rewards (newer module). |
| Store Credit | Store credit balances applied at checkout (newer module). |
| Translation | Localized/translated content for catalog entities (newer module). |

(Notification and File modules appear elsewhere in the docs under infrastructure/architectural modules rather than the commerce-modules index; listed here for completeness.)

---

## Sources (all official `docs.medusajs.com`)

- Inventory Concepts: https://docs.medusajs.com/resources/commerce-modules/inventory/concepts
- Inventory Module (overview): https://docs.medusajs.com/resources/commerce-modules/inventory
- Inventory in Flows (lifecycle): https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-in-flows
- Inventory Kit: https://docs.medusajs.com/resources/commerce-modules/inventory/inventory-kit
- Product Variant Inventory (flags): https://docs.medusajs.com/resources/commerce-modules/product/variant-inventory
- Get Product Variant Inventory Quantity (getVariantAvailability): https://docs.medusajs.com/resources/commerce-modules/product/guides/variant-inventory
- Retrieve Variant Inventory in Storefront: https://docs.medusajs.com/resources/storefront-development/products/inventory
- confirmInventoryStep: https://docs.medusajs.com/resources/references/medusa-workflows/steps/confirmInventoryStep
- cancelOrderWorkflow: https://docs.medusajs.com/resources/references/medusa-workflows/cancelOrderWorkflow
- Stock Location Module: https://docs.medusajs.com/resources/commerce-modules/stock-location
- Manage Product Variants (Admin): https://docs.medusajs.com/user-guide/products/variants
- Manage Reservations (Admin): https://docs.medusajs.com/user-guide/inventory/reservations
- Commerce Modules index: https://docs.medusajs.com/resources/commerce-modules
