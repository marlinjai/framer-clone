---
name: b2-inventory-ledger-schema
track: commerce-engine
wave: 1
priority: P0
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [b1-commerce-module-skeleton]
touchesSharedState: true
sharedState: [prisma, migrations]
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Owned inventory ledger schema: inventory_item / inventory_level (generated available_quantity) / stock_movement (append-only) / reservation / stock_location

> The genuine correctness win the commerce doc puts FIRST (smallest-correct-v1): the event-sourced inventory ledger, purpose-built Prisma (NOT data-table). This is the FIRST commerce schema writer; per the ORCHESTRATION-LOOP one-writer-at-a-time rule, the `prisma`-tagged commerce schema specs form a SERIAL CHAIN: `track0` (creates schema.prisma with dt_*) -> `b2` (this, inventory) -> `b3` (triggers) -> `b4` (catalog) -> `b5` (pricing) -> `b6` (orders). Each depends on the prior's merge so no two Workers edit `prisma/schema.prisma` concurrently.

## Goal

Add the five inventory models to `prisma/schema.prisma` (TOUCHES SHARED SCHEMA) with the exact constraints that make oversell structurally impossible at the schema level: the generated `available_quantity` column, the `CHECK (reserved <= stocked)` backstop, the append-only `stock_movement` ledger, the optimistic-concurrency `version`, and the composite UNIQUE. Schema + generated column + append-only REVOKE + CHECK + indexes only; NO write logic, NO reservation guards (b3).

## Scope

**In:**
- `inventory_item` (iitem; sku/dims/title; partial-unique sku WHERE deleted_at IS NULL).
- `inventory_level` (ilev; location_id + inventory_item_id; `stocked_quantity` + `reserved_quantity` Int; a GENERATED column `available_quantity = stocked_quantity - reserved_quantity` STORED (DB-filterable, via a raw-SQL migration step since Prisma cannot express generated columns natively); composite UNIQUE (inventory_item_id, location_id); `version` Int default 0 for optimistic concurrency; CHECK (reserved_quantity <= stocked_quantity)).
- `stock_movement` (smov; APPEND-ONLY ledger: inventory_item_id, location_id, movement_type enum receive/reserve/release/fulfill/adjust/transfer, quantity, request_id UNIQUE, ref_type, ref_id, transfer_group_id nullable, created_at; the source of truth, level is its projection).
- `reservation` (resitem; line_item_id nullable, location_id NOT NULL, quantity, request_id).
- `stock_location` (sloc; name).
- A migration applies `REVOKE UPDATE,DELETE ON stock_movement FROM commerce_app` (using the b1 role topology), enforcing append-only.

**Out (explicitly deferred):**
- Write logic / reservation guards / the guarded decrement (b3).
- REST reads (b7).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `prisma/schema.prisma` | edit | ADD 5 inventory models. `prisma` shared-state (serial after track0 + b1) |
| `prisma/migrations/**` | new | the 5 tables + generated-column raw SQL + REVOKE + CHECK. `migrations` shared-state |
| `src/server/commerce/inventory/__tests__/schema.itest.ts` | new (integration) | generated col, CHECK, append-only REVOKE |

## Data shapes

```prisma
// inventory_level: stocked_quantity Int, reserved_quantity Int, version Int @default(0)
//   available_quantity  -> GENERATED ALWAYS AS (stocked_quantity - reserved_quantity) STORED (raw-SQL migration)
//   @@unique([inventory_item_id, location_id])
//   CHECK (reserved_quantity <= stocked_quantity)        (raw-SQL migration)
// stock_movement: movement_type enum, request_id @unique, transfer_group_id String?
//   REVOKE UPDATE,DELETE ON stock_movement FROM commerce_app  (raw-SQL migration; append-only)
// reservation.location_id NOT NULL
```

## Test plan

- [ ] Integration (Dockerized Postgres): `available_quantity` auto-updates when stocked/reserved change.
- [ ] The CHECK rejects `reserved > stocked`.
- [ ] UPDATE on `stock_movement` as `commerce_app` is DENIED (append-only REVOKE).
- [ ] `inventory_item` partial-unique sku frees on soft-delete.
- [ ] `stock_movement.request_id` UNIQUE.

## Definition of done

- [ ] The 5 inventory models land with composite UNIQUE, CHECK, version, generated `available_quantity` (raw-SQL migration), partial-unique sku, append-only REVOKE.
- [ ] `pnpm exec prisma generate` + a migration apply against Dockerized Postgres succeed.
- [ ] Integration test confirms generated col, CHECK rejection, and the denied UPDATE on stock_movement.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Cross-check doc sections 3.1 (GoBD immutable correction-only ledger), 4.3 (ledger as source of truth, level as projection), 4.4.
- Critique (major, fixed): serialized after b1; b4 now depends on b2 (not parallel) so concurrent schema.prisma edits are impossible.
- Depends on: `b1-commerce-module-skeleton` (role topology, withTenant, repo interfaces)
