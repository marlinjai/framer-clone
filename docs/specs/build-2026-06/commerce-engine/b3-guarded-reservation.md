---
name: b3-guarded-reservation
track: commerce-engine
wave: 1
priority: P0
status: done
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [b2-inventory-ledger-schema]
touchesSharedState: true
sharedState: [prisma, migrations]
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Guarded conditional decrement with the 3 stacked guards + location-selection + kit lock-ordering + transfer-balance, inside a real prisma.$transaction

> The heart of the correctness story. `src/server/commerce/inventory/reserve.ts` holds the guarded conditional decrement (the single oversell lock) inside a REAL `prisma.$transaction` (NEVER `adapter.transaction()`, the verified no-op). Serial schema position: after b2, before b4 (this spec ADDS the deferred transfer-balance trigger + default-location config via migration SQL, so it holds the `prisma`/`migrations` tags in the chain).

> ISOLATION LEVEL (critique fix): the structural-oversell-impossibility proof relies on Postgres DEFAULT READ COMMITTED re-evaluation semantics (a blocked UPDATE re-evaluates its WHERE against the committed row after the lock releases, matching the doc scenario-1 T4). The reserve `$transaction` MUST NOT be opened at REPEATABLE READ / SERIALIZABLE (those raise a 40001 serialization failure instead of cleanly matching zero rows, changing the `{ok:false,shortages}` contract into a thrown error the caller must retry). The race test asserts the isolation level under test is READ COMMITTED.

## Goal

The guarded UPDATE inside a real `$transaction` with three stacked guards so oversell is structurally impossible, plus location selection, kit lock-ordering, transfer-balance, and the release/fulfill/adjust effect functions. Concurrency proven by a real two-transaction race test.

## Scope

**In:**
- `src/server/commerce/inventory/reserve.ts`: the guarded UPDATE
  `UPDATE inventory_level SET reserved_quantity = reserved_quantity + :needed, version = version + 1 WHERE inventory_item_id = :item AND location_id = :loc AND (stocked_quantity - reserved_quantity) >= :needed`
  inside a READ COMMITTED `prisma.$transaction`. Three guards stack: (1) the guarded UPDATE...WHERE available>=needed takes a row write-lock so concurrent reservers serialize and the loser matches zero rows -> `{ok:false, shortages}`; (2) the b2 `CHECK(reserved<=stocked)` backstop aborts any forgotten-guard path; (3) `UNIQUE(request_id)` on `stock_movement` makes the op idempotent against retries. Each reserve writes the append-only `stock_movement(reserve)` + the `reservation` row + the conditional level UPDATE in ONE `$transaction`.
- LOCATION SELECTION: `reserve` takes an explicit `locationId`; when omitted, a per-workspace default fulfillment location resolves it; NO reservation is ever created without a concrete location (`reservation.location_id` NOT NULL).
- KIT LOCK-ORDERING: a kit (one variant -> N items via `required_quantity`) locks its N item rows in ASCENDING `inventory_item_id` order inside the reservation transaction (removes the deadlock).
- TRANSFER-BALANCE: paired transfer movements share a `transfer_group_id`; a DEFERRED constraint trigger (migration SQL) asserts the two halves sum to zero and both exist at commit, so a half-transfer cannot commit.
- `applyInventoryEffect` for reserve/release/fulfill/adjust running the same atomic pattern.

**Out (explicitly deferred):**
- Orders (b6), pricing (b5), catalog (b4), REST (b7).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/commerce/inventory/reserve.ts` | new | guarded decrement + applyInventoryEffect + resolveLocation; READ COMMITTED |
| `prisma/migrations/**` | new | deferred transfer-balance trigger + default-location config. `prisma`/`migrations` shared-state |
| `src/server/commerce/inventory/__tests__/reserve.itest.ts` | new (integration) | two-transaction race + 6 guarantees |

## API surface

```ts
export async function reserve(tx, args: { inventoryItemId; locationId?; needed; requestId; refType; refId }):
  Promise<{ ok: true; reservationId: string } | { ok: false; shortages: Shortage[] }>;
export async function applyInventoryEffect(tx, e: { type: 'reserve'|'release'|'fulfill'|'adjust'; /* ... */ }): Promise<void>;
export async function resolveLocation(tx, lineLocationId?: string): Promise<string>; // per-workspace default
// Lock order: ORDER BY inventory_item_id ASC. Isolation: READ COMMITTED (default).
```

## Test plan

- [ ] Integration (Dockerized PG, READ COMMITTED): two concurrent reserves of the last unit -> exactly one `ok:true`, one `ok:false` with shortages.
- [ ] A forgotten-guard path is caught by the CHECK.
- [ ] A duplicate `request_id` is a no-op (idempotent).
- [ ] Omitting `locationId` resolves the per-workspace default and never creates a NULL-location reservation.
- [ ] A kit reservation locks item rows in ASCENDING inventory_item_id order (deterministic deadlock-free test).
- [ ] A half-completed transfer fails to commit (deferred trigger).
- [ ] The test documents/asserts the isolation level is READ COMMITTED.

## Definition of done

- [ ] `reserve` runs the guarded UPDATE + reservation + stock_movement(reserve) in the caller's READ COMMITTED `$transaction`; `applyInventoryEffect` handles all four effects with request_id idempotency.
- [ ] The deferred transfer-balance trigger ships as a migration.
- [ ] All 6 race/guard guarantees + the isolation-level assertion pass.
- [ ] NO setStock/setPrice/merge anywhere (read-only-author rule); NO `adapter.transaction()`.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Cross-check doc section 4.3 (guarded decrement, scenario 1), 3.5 (location/kit/transfer must-fixes).
- Critique (minor, fixed): isolation level stated explicitly as READ COMMITTED; the proof is tied to it.
- Depends on: `b2-inventory-ledger-schema`
