---
name: slice1-repository-and-withtenant-seam
track: slice-1-offers-doc-tier
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-web
status: draft
dependsOn: [slice1-doc-tier-provisioning]
touchesSharedState: true
sharedState: [prisma]
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit
---

> **PARKED 2026-06-16:** separate lumitra-web workstream, NOT part of the framer-clone build loop. See `/Users/marlinjai/software-dev/ERP-suite/projects/framer-clone/docs/specs/build-2026-06/ROADMAP.md`. Content preserved for the lumitra-web offers/CRM workstream pickup; do NOT dispatch from the framer-clone orchestrator.

# Transport-agnostic repository interface + withTenant seam (collapsed to a constant schema)

> Slice 1 spec 2 of 8. Critique fixes applied: explicit instruction that the atomic write path RE-IMPLEMENTS raw row writes against the tx client (adapter.createRow escapes the transaction); withTenant validates+quotes the schema identifier.

## Goal

Define the thin transport-agnostic repository interface the domain layer depends on so the P4 generalization to `cms.lumitra.co` is a transport swap, not a rewrite. Provide the single in-process implementation that reads via the adapter-prisma collections AND holds its own `PrismaClient` for the atomic multi-row write path. Design the `withTenant(prisma, schema, fn)` seam with the production `SET LOCAL search_path` signature but collapse it to a constant schema (no registry, no outbox, no N-schema runner).

## Scope

**In:**
- `OffersRepository`, `ClientsRepository`, `ProjectsRepository`, `LineItemsRepository`, `ActivitiesRepository` interfaces in plain TS, zero data-table or HTTP imports in the type surface.
- The single in-process implementation over the provisioned collections for plain CRUD reads.
- `runInTransaction(fn)` using `prisma.$transaction` directly (the domain layer's own `PrismaClient`).
- INSIDE the transaction, raw row writes via `tx.$executeRawUnsafe` against `tbl_<safeTableName(id)>` using `safeColumnName(columnId)` + `serializeCell`, relation links into `dt_relations`, select values into `dt_row_select_values`. Column UUIDs resolved once from the seed-key registry.
- `withTenant(prisma, schema, fn)` issuing `SET LOCAL search_path` inside a transaction for a non-default schema, pass-through for the constant default `DOC_TIER_SCHEMA` (default `'public'`). Schema identifier validated (`^[a-zA-Z_][a-zA-Z0-9_]*$` or reuse data-table `validateIdentifier`) and quoted before interpolation.

**Out (explicitly deferred):**
- Domain logic (numbering/totals/status/Activity) (sibling spec).
- Multi-tenant registry, outbox consumer, N-schema runner (P4, epic E7).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/offers/repository/types.ts` | new | the 5 repository interfaces + `RepositoryTx` |
| `src/server/offers/repository/inProcess.ts` | new | `InProcessRepositories`, `runInTransaction` via `prisma.$transaction`, raw row writes |
| `src/server/offers/repository/withTenant.ts` | new | `withTenant`, `DOC_TIER_SCHEMA`, identifier validation |
| `src/server/offers/docTier/adapterClient.ts` | edit | share the `PrismaClient` instance |
| `src/server/offers/repository/__tests__/atomicity.test.ts` | new | rollback + withTenant SET LOCAL |

## API surface

```ts
export interface RepositoryTx { /* opaque Prisma.TransactionClient wrapper */ }

export interface OffersRepository {
  getById(id: string): Promise<OfferRow | null>;
  list(query?: OfferQuery): Promise<OfferRow[]>;
  insert(tx: RepositoryTx, row: NewOfferRow): Promise<OfferRow>;
  update(tx: RepositoryTx, id: string, patch: Partial<OfferRow>): Promise<OfferRow>;
}
// ...Clients/Projects/LineItems/Activities mirror this shape

export interface Repositories {
  offers: OffersRepository; clients: ClientsRepository; projects: ProjectsRepository;
  lineItems: LineItemsRepository; activities: ActivitiesRepository;
  runInTransaction<T>(fn: (tx: RepositoryTx) => Promise<T>): Promise<T>; // prisma.$transaction
}

export function withTenant<T>(prisma: PrismaClient, schema: string, fn: (tx) => Promise<T>): Promise<T>;
export const DOC_TIER_SCHEMA: string; // from config, default 'public'
```

## Data shapes

```ts
// runInTransaction body, conceptually:
prisma.$transaction(async (tx) => {
  // raw writes, NOT adapter.createRow (that uses adapter's own this.prisma => escapes the tx)
  await tx.$executeRawUnsafe(
    `INSERT INTO "${safeTableName(offersTableId)}" ("id", "${safeColumnName(titleColId)}", ...) VALUES ($1, $2, ...)`,
    rowId, serializeCell(title), ...
  );
  // relation link:
  await tx.$executeRawUnsafe(`INSERT INTO "dt_relations" (...) VALUES (...)`, ...);
  // select values:
  await tx.$executeRawUnsafe(`INSERT INTO "dt_row_select_values" (...) VALUES (...)`, ...);
});
```

## Test plan

- [ ] Unit: `runInTransaction` creates an offer + N line items + an activity; a forced mid-write throw rolls back EVERY row (zero rows persist).
- [ ] Unit: a test asserts `adapter.createRow` is NOT invoked inside the transaction (it would escape it). Spy/grep the impl.
- [ ] Unit: `withTenant` emits `SET LOCAL search_path` for a named non-default schema; pass-through for the constant default.
- [ ] Unit: an invalid schema name (e.g. `foo; DROP`) is rejected by `withTenant` before any SQL runs.

## Definition of done

- [ ] Repository interfaces have zero data-table/HTTP imports in the type surface.
- [ ] In-process impl satisfies them; `runInTransaction` uses `prisma.$transaction`; rollback test green.
- [ ] `adapter.createRow`-not-called-in-tx assertion passes.
- [ ] `withTenant` validates+quotes schema identifier; SET LOCAL test green; invalid-name rejection test green.
- [ ] Doc comment on adapter.transaction() usage explicitly warns it is a no-op (adapter.ts:894) and must not be used for atomicity.
- [ ] `pnpm exec tsc --noEmit` + tests pass.

## Open questions

- None blocking.

## References

- Plan: holistic plan 2.6, commerce plan 5.1, 5.5
- Code touchpoints: data-table adapter.ts:894 (no-op transaction), adapter-shared `src/identifiers.ts` (validateIdentifier/safeTableName/safeColumnName), `src/serialization` (serializeCell)
