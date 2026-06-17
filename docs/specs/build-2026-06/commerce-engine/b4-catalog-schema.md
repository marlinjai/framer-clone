---
name: b4-catalog-schema
track: commerce-engine
wave: 2
priority: P0
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [b3-guarded-reservation]
touchesSharedState: true
sharedState: [prisma, migrations]
estimateDays: 5
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Owned catalog schema: product / option / option_value / variant + the variant<->option_value matrix with composite FK + option_signature trigger + partial-unique

> The purpose-built typed catalog (the graph data-table failed hardest at). SERIALIZATION FIX (critique major): `dependsOn: [b3-guarded-reservation]` (NOT parallel off b1) so the `prisma`-tagged schema writers form a strict chain b2 -> b3 -> b4 -> b5 -> b6; no two Workers edit `prisma/schema.prisma` concurrently. b4 has no logical dependency on b3's reserve code, only on its merged schema state; the edge is a serialization edge by design.

## Goal

Add the typed catalog to `prisma/schema.prisma` (TOUCHES SHARED SCHEMA) with the two correctness-closing must-fixes: the composite FK (one-value-per-option becomes DB-enforced) and the option_signature trigger (no two variants can share an option combination). Catalog CONTENT only; NO price, NO inventory linkage, NO Yjs (deferred E5).

## Scope

**In:**
- `product` (prod; title/handle/description/status enum draft|published; partial-unique handle WHERE deleted_at IS NULL).
- `product_option` (opt; title; belongsTo product; unique (product_id, title) on live rows).
- `product_option_value` (optval; value; belongsTo option; unique (option_id, value) on live rows; PLUS a UNIQUE (id, option_id) to serve as the composite-FK target).
- `product_variant` (variant; title/sku/barcode; belongsTo product; partial-unique sku/barcode on live rows; `option_signature` with a DB-enforced UNIQUE).
- `product_variant_option` (the matrix; composite FK `(option_value_id, option_id) -> product_option_value(id, option_id)` so the DB REJECTS a wrong option_id).
- A raw-SQL migration adds the BEFORE INSERT/UPDATE `option_signature` trigger that recomputes the signature by sorting the variant's option_value_ids from `product_variant_option`.
- `src/server/commerce/repository/catalog.ts` implements the `CatalogRepository` read/write interface from b1 (createProduct/addOption/addOptionValue/addVariant/setVariantOptions, all take tx).

**Out (explicitly deferred):**
- Price/sku-as-money (b5), inventory linkage (already in b2/b3), Yjs (E5).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | edit | ADD 5 catalog models + composite FK + UNIQUE FK target. `prisma` shared-state (serial after b3) |
| `prisma/migrations/**` | new | option_signature BEFORE INSERT/UPDATE trigger. `migrations` shared-state |
| `src/server/commerce/repository/catalog.ts` | new | CatalogRepository impl over tx |
| `src/server/commerce/repository/__tests__/catalog.itest.ts` | new (integration) | composite FK rejection, signature collisions |

## Test plan

- [ ] Integration: inserting a `product_variant_option` with a mismatched `option_id` is REJECTED by the composite FK.
- [ ] Two variants with the same option-value combination collide on `option_signature` (the trigger computes identical signatures).
- [ ] Editing a variant's options recomputes the signature.
- [ ] A soft-deleted handle frees the partial-unique.

## Definition of done

- [ ] The 5 catalog models land with: product partial-unique handle (live); product_option unique (product_id, title) live; product_option_value unique (option_id, value) live AND UNIQUE (id, option_id) FK target; product_variant partial-unique sku+barcode live AND option_signature UNIQUE; product_variant_option composite FK.
- [ ] The option_signature BEFORE INSERT/UPDATE trigger ships as a raw-SQL migration.
- [ ] `pnpm exec prisma generate` + migration apply succeed; the 4 integration assertions pass.
- [ ] `src/server/commerce/repository/catalog.ts` implements the b1 CatalogRepository over tx.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Cross-check doc sections 3.1, 3.3 (the two must-fixes: composite FK + option_signature trigger).
- Critique (major, fixed): serialized as b3 -> b4 so schema.prisma writers are a chain, not a fork.
- Depends on: `b3-guarded-reservation` (serialization edge on the shared schema)
