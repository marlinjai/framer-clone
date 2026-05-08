---
name: cms-collection-crud-api
track: cms
wave: 2
priority: P0
status: draft
depends_on: [cms-service-scaffold, cms-tenant-schema-bootstrap, cms-auth-middleware-dual-principal]
estimated_value: 10
estimated_cost: 6
owner: unassigned
---

# Collection and column CRUD API

## Goal

Ship the CMS service's first user-facing endpoints: collection (table) CRUD and column CRUD, both delegated to `@marlinjai/data-table-adapter-prisma` running inside the request's resolved tenant schema. This is what the framer-clone editor calls when a customer creates a "Contacts" collection with columns "name", "email", "phone". The endpoint surface is intentionally bounded: no arbitrary SQL, just CMS-shaped collection management. End-user principals are blocked from these routes (collection management is site-owner only forever; end-users only ever read or write rows, never DDL).

## Scope

**In:**
- `POST /v1/collections` (create collection): site-owner only, body `{ name, description?, columns?: [...] }`, calls `adapter.createTable(workspaceId, ...)` then optionally `createColumn` per provided column
- `GET /v1/collections` (list workspace's collections): site-owner only, returns collection metadata
- `GET /v1/collections/:id` (get one collection with columns): site-owner only
- `PATCH /v1/collections/:id` (rename collection, update description): site-owner only
- `DELETE /v1/collections/:id` (soft-delete: marks `_archived`, does NOT drop the underlying real table): site-owner only
- `POST /v1/collections/:id/columns` (add column): site-owner only
- `PATCH /v1/collections/:id/columns/:columnId` (rename, change type with TEXT-everywhere semantics): site-owner only
- `DELETE /v1/collections/:id/columns/:columnId` (soft-delete column): site-owner only
- All routes go through `requireAuth('site_owner')` and `withTenantSearchPath`
- Zod request/response schemas exported via `@cms-brain/shared` for SDK consumers
- Adapter-prisma instantiated per-request inside the tenant transaction (NOT a singleton, because search_path is transaction-scoped)

**Out (explicitly deferred):**
- Row CRUD (separate spec: `cms-row-crud-api`)
- Hard-delete / data wipe (Phase 2: GDPR delete on whole tenant, not per-collection)
- Schema-evolution UX (open architectural decision per handover; don't expose a "rename column with data migration" endpoint until UX is decided)
- View CRUD (Phase 2 expansion: views are presentation, not data)
- Permissions beyond "site_owner" (separate spec: `cms-permission-registry`)
- Optimistic UI / versioning headers (Phase 2)
- AI-driven schema generation (lives in AI track, calls these endpoints)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/packages/api/src/routes/collections.ts` | new | Hono router |
| `projects/lumitra-infra/cms-brain/packages/api/src/routes/columns.ts` | new | Sub-router under `/v1/collections/:id/columns` |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/adapter-factory.ts` | new | `getAdapterForTenant(tx, schemaName)` returns adapter-prisma instance bound to the transaction |
| `projects/lumitra-infra/cms-brain/packages/shared/src/schemas/collections.ts` | new | Zod schemas |
| `projects/lumitra-infra/cms-brain/packages/sdk/src/collections.ts` | new | `client.collections.create()`, etc. |

## API surface

```ts
// Endpoints
// POST   /v1/collections
// GET    /v1/collections
// GET    /v1/collections/:id
// PATCH  /v1/collections/:id
// DELETE /v1/collections/:id
// POST   /v1/collections/:id/columns
// PATCH  /v1/collections/:id/columns/:columnId
// DELETE /v1/collections/:id/columns/:columnId

// Request shapes (from packages/shared/src/schemas/collections.ts)
import { z } from 'zod';

export const CreateCollectionBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  columns: z.array(z.object({
    name: z.string(),
    type: z.enum([
      'text', 'number', 'select', 'multi_select',
      'date', 'checkbox', 'url', 'email',
      'relation', 'file', 'formula', 'rollup',
    ]),
    config: z.record(z.unknown()).optional(),
  })).optional(),
});

export type Collection = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Column = {
  id: string;
  collectionId: string;
  name: string;
  type: ColumnType;
  config: Record<string, unknown>;
  order: number;
  archived: boolean;
};
```

```ts
// lib/adapter-factory.ts
import { PrismaAdapter } from '@marlinjai/data-table-adapter-prisma';

export function getAdapterForTenant(
  tx: PrismaClient,
  schemaName: string,
): PrismaAdapter;
// Returns an adapter instance bound to the transaction `tx`.
// The transaction has already had `SET LOCAL search_path` applied by `withTenantSearchPath`.
// Adapter must NOT cache the prisma client across requests.
```

## Data shapes

```ts
// Reuses adapter-prisma's existing tables, but inside the per-tenant schema:
//   dt_tables, dt_columns, dt_relations, dt_files, dt_row_select_values, ...
// No new persistent shape in this spec.

// The tenantSchema attached to request context determines which schema's `dt_tables`
// the operation hits. workspaceId is also stored on `dt_tables.workspace_id` as a
// belt-and-suspenders check (a tenant could in principle host multiple workspaces in
// the future, though Day 1 it's 1:1).
```

## Test plan

- [ ] Unit: `routes/collections.test.ts` create returns 201 with collection id, list returns it, get returns columns
- [ ] Unit: `routes/collections.test.ts` create rejects invalid column type (Zod 400)
- [ ] Unit: `routes/columns.test.ts` add column returns 201, list reflects, delete soft-archives
- [ ] Unit: `routes/collections.test.ts` end-user principal hits site-owner-only route, returns 501 (per stub) or 403 (when end-user is real)
- [ ] Integration: provision tenant A and B, create same-named collection in each, verify they coexist (no global namespace collision because real-table names are `tbl_<id>` with cross-tenant unique ids per adapter-prisma)
- [ ] Integration: rename column does NOT migrate data (TEXT-everywhere) but updates `dt_columns.name`
- [ ] Integration: type-change from `text` to `number` is metadata-only, expression index added
- [ ] Manual: from framer-clone editor (after data-bindings spec lands), create a collection, refresh, see it in the list

## Definition of done

- [ ] Code lands and typechecks
- [ ] All 8 endpoints implemented and tested
- [ ] Site-owner / end-user principal enforcement verified
- [ ] Adapter is properly transaction-scoped (no leaks of `search_path` across requests)
- [ ] SDK package exposes typed clients
- [ ] OpenAPI schema generated (or hand-written) for the routes
- [ ] No regressions in tenant bootstrap or auth middleware
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **Soft-delete vs hard-delete on collections:** Recommended soft-delete (`_archived` flag) for v1. Restore is "unset the flag". Hard-delete needs ops tooling and GDPR thinking, deferred.
- **Column type change semantics:** Plan says TEXT-everywhere with expression indexes makes type change metadata-only. But UX implication: if a user enters "abc" in a text column, then changes to number, what does the API return? Recommended: return the raw text, let the renderer/binding resolve via expression cast. Document the contract.
- **Relation columns:** Creating a relation requires another collection to exist in the same workspace. What if the target is in a different workspace (cross-workspace relations)? Recommended: NOT supported in v1. Reject with 400 if `target_collection_id` is not in the requesting workspace.
- **Column reorder endpoint:** Out of scope or in scope? Plan doesn't say. Recommended: include `PATCH /columns/:id` accepts `{ order: number }` since it's free with adapter-prisma.
- **Pagination on list endpoints:** A workspace could have hundreds of collections theoretically. Recommended: cap at 200 collections per workspace via a soft policy in v1, no pagination yet. Add pagination if customer feedback shows it's needed.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Recommendation paragraph 1)
- Spec dependencies: `cms-service-scaffold`, `cms-tenant-schema-bootstrap`, `cms-auth-middleware-dual-principal`
- Adapter docs: `projects/data-table/docs/architecture.md`
- Adapter source: `projects/data-table/packages/adapter-prisma/src/adapter.ts:91`, `:181`, `src/ddl.ts:21`, `:61`
