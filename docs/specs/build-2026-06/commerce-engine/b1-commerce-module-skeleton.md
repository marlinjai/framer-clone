---
name: b1-commerce-module-skeleton
track: commerce-engine
wave: 1
priority: P0
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [track0-backend-foundation]
touchesSharedState: false
sharedState: []
estimateDays: 2
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Commerce bounded-module skeleton: withTenant constant-schema seam, commerce_app/commerce_ddl role topology, transport-agnostic repository interface

> The commerce engine shares the ONE Track-0 backend foundation (`track0-backend-foundation` in `cms-content-tier`): same PrismaClient singleton, same single `prisma/schema.prisma`, same single Postgres, same node-env vitest + Dockerized-Postgres test substrate. There is NO separate commerce `b0-backend-foundation`; the shared Track 0 IS b0. This spec stands up the `src/server/commerce/` bounded module that every later commerce spec hangs off, with NO domain tables yet (those are b2/b4/b5/b6). data-table is NOT the system of record for stock/money (its `transaction()` is a verified no-op at `adapter.ts:894`); commerce uses purpose-built Prisma exclusively and never imports adapter-prisma.

## Goal

Stand up the server-only `src/server/commerce/` module with three load-bearing seams: (1) the `withTenant` SET LOCAL search_path seam collapsed to a constant schema for single-tenant v1; (2) the transport-agnostic repository interfaces (every method takes a `Prisma.TransactionClient`); (3) the `commerce_app`/`commerce_ddl` Postgres role topology so the append-only REVOKE in b2 is meaningful under PgBouncer. Pure scaffolding + the constant-schema withTenant + the role SQL; adds ZERO models to `prisma/schema.prisma`.

## Scope

**In:**
- `src/server/commerce/withTenant.ts`: `withTenant(prisma, schema, fn)` opens a `prisma.$transaction`, runs `SET LOCAL search_path TO ...` FIRST on the same connection (SET LOCAL scopes to the tx so a PgBouncer-pooled connection cannot leak one tenant's path into the next), then runs `fn` against the tx client; `schema` defaults to one exported `COMMERCE_SCHEMA` constant. The registry/outbox-consumer/N-schema-runner are explicitly NOT built (E7).
- `src/server/commerce/repository/types.ts`: the transport-agnostic repo interfaces (`CatalogRepository`, `InventoryRepository`, `PricingRepository`, `OrderRepository`); every method takes `tx: Prisma.TransactionClient` and never knows about HTTP/WS.
- `prisma/sql/commerce-roles.sql`: SQL creating `commerce_app` (DML-only, the role the `REVOKE UPDATE,DELETE ON stock_movement` applies to, used by the pooled app connection) and `commerce_ddl` (CREATE/ALTER, migration/provisioning, connects outside the tx pool). A docs note on why REVOKE is only meaningful under two roles + the PgBouncer `server_reset_query` requirement.
- `src/server/commerce/auth/guard.ts` is NOT re-created: commerce mutation routes REUSE the `slice2-admin-guard-stub` `requireAdmin` / `can()` seam (one constant workspace). Document this reuse.
- `import 'server-only'` on all module code.

**Out (explicitly deferred):**
- Any domain model in `prisma/schema.prisma` (b2/b4/b5/b6 own those).
- The tenant registry + outbox provisioning consumer + N-schema runner (E7).
- Real per-tenant search_path (E7; constant for v1).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/commerce/withTenant.ts` | new | constant-schema SET LOCAL seam, server-only |
| `src/server/commerce/repository/types.ts` | new | transport-agnostic repo interfaces |
| `prisma/sql/commerce-roles.sql` | new | commerce_app / commerce_ddl roles + REVOKE rationale note |
| `src/server/commerce/index.ts` | new | server barrel |
| `src/server/commerce/__tests__/withTenant.test.ts` | new (node project) | SET LOCAL issued inside tx; no leak |

## API surface

```ts
// src/server/commerce/withTenant.ts
export const COMMERCE_SCHEMA: string;
export function withTenant<T>(prisma: PrismaClient, schema: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
// src/server/commerce/repository/types.ts
export interface CatalogRepository  { /* methods take tx: Prisma.TransactionClient */ }
export interface InventoryRepository { /* ... */ }
export interface PricingRepository   { /* ... */ }
export interface OrderRepository     { /* ... */ }
```

## Test plan

- [ ] `withTenant` issues `SET LOCAL search_path` inside the tx (mockable) BEFORE `fn`; two sequential calls do not leak (constant, asserted as the seam contract).
- [ ] Repo interfaces in `types.ts` declare methods taking `Prisma.TransactionClient`.
- [ ] `prisma/sql/commerce-roles.sql` creates both roles; the docs note explains the REVOKE-under-two-roles rationale + PgBouncer `server_reset_query`.
- [ ] `git diff prisma/schema.prisma` is EMPTY in this spec (no model added).

## Definition of done

- [ ] `withTenant<T>(prisma, schema, fn)` wraps `$transaction`, issues SET LOCAL before fn, defaults to `COMMERCE_SCHEMA`.
- [ ] Repo interfaces declared; commerce reuses the `slice2-admin-guard-stub` guard (documented, not re-created).
- [ ] `commerce-roles.sql` + docs note land.
- [ ] No model added to `prisma/schema.prisma` (verify diff empty).
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Cross-check doc: `knowledge-base/research/2026-06-01-owned-realtime-commerce-architecture.md` sections 3.5, 5.1, 5.5, 6.
- Code touchpoints: `data-table/packages/adapter-prisma/src/adapter.ts:894` (no-op transaction proving stock cannot live in the grid), `src/server/auth/guard.ts` (reused guard from the CMS track)
- Depends on: `track0-backend-foundation` (PrismaClient + schema.prisma + Postgres + test substrate)
