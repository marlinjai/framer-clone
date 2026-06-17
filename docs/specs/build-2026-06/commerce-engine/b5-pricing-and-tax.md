---
name: b5-pricing-and-tax
track: commerce-engine
wave: 2
priority: P0
status: done
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [b4-catalog-schema]
touchesSharedState: true
sharedState: [prisma, migrations]
estimateDays: 5
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Pricing engine (price_set/price/price_rule/price_list) + catalog-side German tax_class + Storno/Gutschrift corrective-invoice entity

> Pricing + the catalog-side tax model. SERIAL schema position: after b4, before b6. OWNERSHIP FIX (critique major): b5 owns ONLY the pricing graph, the CATALOG-side `tax_class` (on Product/Variant), and the CreditNote/credit_note_ref entity. b5 does NOT add any `Order.*` fields and does NOT create the Order model. The ORDER-LEVEL tax fields (tax_region/vat_id/customer_type/reverse_charge/net_or_gross/kleinunternehmer) and the reverse-charge/Kleinunternehmer ORDER tests are OWNED by b6 (which creates the Order model). This removes the circular ownership in the original brief.

## Goal

Add the pricing graph (integer-cents amounts, NEVER floats, NEVER Yjs), the catalog-side `tax_class` mapping (per product/variant, maps to a future bought tax engine's product-tax-code), and the corrective-invoice entity (Storno/Gutschrift/CreditNote) because you cannot DELETE an invoice in Germany. The pricing-resolution read engine is a pure function over owned rows. The bought-tax-engine integration, OSS accumulation, and conditional invoice rendering are OUT (E8).

## Scope

**In:**
- `price_set` (pset), `price` (price; currency_code; amount as integer minor units / cents; min/max_quantity; belongsTo price_set + nullable price_list), `price_rule` (prule; attribute/value/operator/priority), `price_list` (plist; status enum; type; starts_at/ends_at).
- `tax_class` on `product`/`product_variant` (the catalog-side tax classification only).
- `CreditNote` (Storno/Gutschrift) entity with a `credit_note_ref` junction. NOTE: the corrected document is the Order/invoice owned by b6; therefore the `credit_note_ref` -> corrected-document FK is added in b6 (which owns Order), OR `CreditNote` carries a loose corrected_ref + a deferred FK that b6 finalizes. This spec builds the `CreditNote` entity + the no-DELETE-on-invoice contract; the FK to Order is wired in b6. (Documented so b5 does not block on a model it does not own.)
- `src/server/commerce/repository/pricing.ts`: `PricingRepository` (createPriceSet, addPrice, `resolvePrice(tx, variantId, {currency, priceListIds})` returning integer cents) as a pure read over tx.

**Out (explicitly deferred):**
- Order-level tax fields + reverse-charge/Kleinunternehmer ORDER tests (b6 owns those, on the Order model b6 creates).
- The bought tax-engine call, OSS accumulation, invoice rendering (E8).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | edit | ADD PriceSet/Price/PriceRule/PriceList + Product/Variant.tax_class + CreditNote. `prisma` shared-state (serial after b4) |
| `prisma/migrations/**` | new | pricing + tax_class + CreditNote. `migrations` shared-state |
| `src/server/commerce/repository/pricing.ts` | new | PricingRepository, resolvePrice (integer cents) |
| `src/server/commerce/repository/__tests__/pricing.itest.ts` | new (integration) | cents round-trip, price-list resolution, CreditNote no-DELETE |

## Test plan

- [ ] Integration: price amounts round-trip as integer cents (never floats).
- [ ] `resolvePrice` applies price-list rules and returns integer cents for a variant.
- [ ] A `CreditNote` is created and there is NO DELETE path for invoices (the corrective-invoice contract); the FK to the corrected Order is finalized in b6 (asserted there).
- [ ] `tax_class` on product/variant is set and read.

## Definition of done

- [ ] PriceSet/Price (integer cents)/PriceRule/PriceList land; `tax_class` on product/variant; `CreditNote` entity with the no-DELETE contract.
- [ ] b5 adds NO `Order.*` fields and does NOT create the Order model (verify: schema diff touches no Order model).
- [ ] `resolvePrice` returns integer cents over tx; cents round-trip + price-list tests pass.
- [ ] `pnpm exec prisma generate` + migration apply succeed.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- CreditNote->corrected-document FK target: confirmed to be the Order/invoice owned by b6. b5 builds the CreditNote entity + no-DELETE contract; b6 wires the FK when it creates Order. (Resolves the circular-ownership flag.)

## References

- Cross-check doc section 3.4 (tax model is more than a bare tax_rate Int), 4.5 (money is Layer-B authoritative, never Yjs).
- Critique (major, fixed): order-level tax fields moved to b6; b5 owns only catalog-side tax_class + pricing + CreditNote.
- Depends on: `b4-catalog-schema`
