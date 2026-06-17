---
name: b6-minimal-orders
track: commerce-engine
wave: 2
priority: P0
status: done
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [b5-pricing-and-tax]
touchesSharedState: true
sharedState: [prisma, migrations]
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Minimal orders: cart -> order, snapshot line items, atomic $transaction reserving stock via the guarded decrement, OWNING the Order model + its German tax fields

> The order entity that closes the loop from catalog+pricing+inventory; single-tenant, in-process, NO payment provider (E8). SERIAL schema position: LAST in the commerce schema chain (after b5). OWNERSHIP FIX (critique major): b6 OWNS the ENTIRE Order + OrderLineItem model INCLUDING the order-level German tax fields (tax_region/vat_id/customer_type/reverse_charge/net_or_gross/kleinunternehmer), and finalizes the b5 `CreditNote.credit_note_ref` FK -> Order. The reverse-charge / Kleinunternehmer ORDER-level tests live HERE (where Order exists), not in b5. b6 dependsOn b5 (it consumes `resolvePrice` and the CreditNote entity) and transitively b3 (it calls `reserve`).

## Goal

Add Order + OrderLineItem (snapshot, not reference) with the full order-level German tax model, and the `createOrder` write that runs in ONE `prisma.$transaction`: resolve prices via b5, snapshot each line, compute server-side integer-cents totals (never client-trusted), and reserve stock per line via b3's guarded decrement with idempotency on the order's request_id; if any line short-stocks, the whole transaction rolls back atomically. Cart itself is client-side selection state (Track C); this spec owns the server-authoritative order WRITE.

## Scope

**In:**
- `order` (order; status; OWNS the order-level tax fields tax_region/vat_id/customer_type/reverse_charge/net_or_gross/kleinunternehmer; server-computed integer-cents totals subtotal/tax_amount/total).
- `order_line_item` (SNAPSHOT-not-reference: copies variant title/sku, the resolved unit_price cents, quantity, tax_rate at creation; a loose `variant_ref` TEXT carrier + `variant_ref_source` select carrying none|datatable|owned NEVER medusa).
- Finalize the b5 `CreditNote.credit_note_ref` FK -> Order (the corrected document is an Order/invoice).
- `src/server/commerce/order/createOrder.ts`: cart payload -> order in ONE `prisma.$transaction`: resolve prices (b5 resolvePrice), snapshot lines, compute integer-cents subtotal/tax/total server-side, reserve each line via b3 `reserve()`; roll back atomically on any shortage.
- `src/server/commerce/repository/order.ts`: `OrderRepository`.

**Out (explicitly deferred):**
- Stripe / checkout / payment (E8).
- The bought tax-engine call, OSS accumulation, invoice rendering (E8).

## Consumer contracts (from the b3 and b5 reviews, both merged: honor exactly)

**b3 reservation idempotency (the subtle one).** `createOrder` owns ONE `prisma.$transaction` and must reserve every line INSIDE it so a short-stock on any line rolls back ALL prior lines' reservations atomically. Therefore call the INNER `reserve(tx, ...)` (which takes the caller's transaction client) per line, NOT `reserveWithRetry` (it opens its OWN separate transaction per call and would not roll back with the order). Because the inner `reserve` re-throws a `DuplicateRequestError` sentinel on a `request_id` UNIQUE (P2002) violation OUT of the transaction (verified in `src/server/commerce/inventory/reserve.ts`), `createOrder` must replicate b3's recovery at the ORDER level: on that sentinel, the order transaction rolls back, then re-read and return the prior committed order in a FRESH transaction (the naive in-transaction re-read fails with Postgres 25P02). Use the order's `request_id` as the idempotency key.

**b5 tax snapshot (TAX-04).** `OrderLineItem` must snapshot the FULL resolved tax treatment, NOT a bare `tax_rate`: the applied `tax_class`, the resolved rate, the computed `tax_amount` in integer cents, and a `tax_treatment` discriminator (`standard | reduced | zero | reverse_charge | kleinunternehmer`). Combined with the order-level markers (`reverse_charge` / `kleinunternehmer` / `net_or_gross`), this must let a reprint reproduce the original legal invoice with ZERO recomputation. Money stays integer cents (b5 enforces non-negative CHECKs on price/credit_note; apply the same floor to order/line totals).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | edit | ADD Order (incl. order-level tax fields) + OrderLineItem; finalize CreditNote->Order FK. `prisma` shared-state (serial after b5) |
| `prisma/migrations/**` | new | Order + OrderLineItem + CreditNote FK. `migrations` shared-state |
| `src/server/commerce/order/createOrder.ts` | new | atomic cart->order in one $transaction |
| `src/server/commerce/repository/order.ts` | new | OrderRepository |
| `src/server/commerce/order/__tests__/createOrder.itest.ts` | new (integration) | snapshot, server totals, atomic rollback, reverse_charge/Kleinunternehmer order tests |

## API surface

```ts
export async function createOrder(prisma, cart):
  Promise<{ ok: true; orderId: string } | { ok: false; shortages: Shortage[] }>; // single $transaction
// Order owns: tax_region, vat_id, customer_type, reverse_charge, net_or_gross, kleinunternehmer
//            + server-computed cents totals subtotal/tax_amount/total
// OrderLineItem: snapshot fields + variant_ref/variant_ref_source (none|datatable|owned)
```

## Test plan

- [ ] Integration: a successful order snapshots line prices (a later price change does NOT alter the order).
- [ ] Totals are server-computed integer cents, ignoring any client-sent total.
- [ ] An order whose last line short-stocks rolls back the ENTIRE order and creates zero reservations.
- [ ] `variant_ref_source` accepts only none|datatable|owned.
- [ ] A B2B `reverse_charge` order produces a zero-VAT marker + the legal-notice flag (order-level test, lives here).
- [ ] A `kleinunternehmer` flag suppresses VAT and sets the Sec 19 notice (order-level test).
- [ ] A `CreditNote` links to its corrected Order via `credit_note_ref` (no DELETE path for the invoice).

## Definition of done

- [ ] Order (incl. order-level tax fields) + OrderLineItem (snapshot + variant_ref/variant_ref_source) land; the CreditNote->Order FK is finalized.
- [ ] `createOrder` resolves prices, snapshots, computes server cents totals, reserves via b3, rolls back atomically on any shortage.
- [ ] All 7 integration assertions (snapshot, server totals, atomic rollback, ref source, reverse_charge, Kleinunternehmer, CreditNote FK) pass.
- [ ] `pnpm exec prisma generate` + migration apply succeed.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Cross-check doc sections 3.4 (German tax model), 4.5 (orders Layer-B atomic, snapshot not reference), 8.2 (atomic rollback).
- Critique (major, fixed): b6 OWNS Order + order-level tax fields; reverse_charge/Kleinunternehmer order tests moved here; CreditNote FK finalized here.
- Depends on: `b5-pricing-and-tax` (resolvePrice, CreditNote) and transitively `b3-guarded-reservation` (reserve).
