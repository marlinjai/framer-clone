---
name: cms-row-crud-api
track: cms
wave: 2
priority: P0
status: draft
depends_on: [cms-collection-crud-api]
estimated_value: 10
estimated_cost: 7
owner: unassigned
---

# Row CRUD API (read + write, with filter / sort / limit / pagination)

## Goal

Ship the row-level data API: list, get, create, update, delete rows for a given collection, with filter / sort / limit / cursor pagination. This is what the data-bindings track calls at runtime to render `Collection`, `RecordView`, and `TableView` on published apps. It is also what the framer-clone editor calls when the customer opens a collection in the data-table view to add or edit data manually. End-user principals get a stub 501 with a structured "Phase 2" code on the write side; on the read side they get 501 too in v1 (Phase 2 will add row-owner predicates). The shape of the route accepts both principal types so Phase 2 only fills in the predicate logic.

## Scope

**In:**
- `GET /v1/collections/:id/rows`: list rows. Query params: `filter` (JSON-encoded), `sort` (`field:asc,field2:desc`), `limit` (default 50, max 200), `cursor` (opaque base64). Site-owner only in v1; end-user dual-principal route returns 501
- `GET /v1/collections/:id/rows/:rowId`: get one row by id. Site-owner OR end-user (latter 501 in v1)
- `POST /v1/collections/:id/rows`: create row. Site-owner only in v1; end-user dual-principal route stub
- `PATCH /v1/collections/:id/rows/:rowId`: update row fields. Site-owner only in v1
- `DELETE /v1/collections/:id/rows/:rowId`: soft-delete row (`_archived = true`). Site-owner only
- Filter language: subset matching adapter-prisma's filter shape (`{ AND: [...], OR: [...], field: { eq: value, gt: ..., contains: ..., in: [...] } }`). Documented as JSON, not a custom DSL
- Cursor pagination using row id + sort key (stable across inserts)
- Response includes hydrated multi-select, relation, file values (joined from `dt_row_select_values`, `dt_relations`, `dt_files`)
- Formula and rollup columns computed by adapter-prisma's `FormulaEngine` and `RollupEngine` post-query
- ETag header on row responses for future optimistic-concurrency wiring (write rejection on `If-Match` mismatch deferred to Phase 2; v1 just emits the ETag)

**Out (explicitly deferred):**
- Real end-user principal logic (Phase 2: row-owner predicates, `OwnerOnly` semantics)
- Optimistic concurrency enforcement (v1 emits ETag, Phase 2 enforces on write)
- Bulk row import / export (Phase 2)
- File upload row-creation (delegated to storage-brain via the file column adapter; this spec handles file column read joins, not the upload itself)
- Real-time row subscriptions / SSE (Phase 2 per plan Revision E)
- Polling middleware (the data-bindings track owns the polling cadence; this spec just answers requests fast)
- Search / full-text query (Phase 2; v1 supports `contains` filter only)

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `projects/lumitra-infra/cms-brain/packages/api/src/routes/rows.ts` | new | Hono router |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/filter-parser.ts` | new | Parses filter JSON, validates against column types |
| `projects/lumitra-infra/cms-brain/packages/api/src/lib/cursor.ts` | new | Encode/decode opaque cursor |
| `projects/lumitra-infra/cms-brain/packages/shared/src/schemas/rows.ts` | new | Zod schemas |
| `projects/lumitra-infra/cms-brain/packages/sdk/src/rows.ts` | new | Typed SDK methods |

## API surface

```ts
// GET /v1/collections/:id/rows?filter=<json>&sort=name:asc&limit=50&cursor=...
// 200 {
//   rows: Row[],
//   nextCursor: string | null,
//   total?: number   // omitted in v1 (cursor pagination doesn't compute total cheaply)
// }

export type Row = {
  id: string;
  fields: Record<string, RowFieldValue>;   // keyed by column id
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  parentRowId: string | null;
  // computed:
  formulaValues?: Record<string, unknown>;
  rollupValues?: Record<string, unknown>;
};

export type RowFieldValue =
  | string
  | number
  | boolean
  | null
  | { type: 'select'; optionIds: string[] }
  | { type: 'relation'; rowIds: string[] }
  | { type: 'file'; fileIds: string[] };

// POST   body: { fields: Record<columnId, RowFieldValue> }
// PATCH  body: { fields: Partial<Record<columnId, RowFieldValue>> }
// DELETE no body
```

```ts
// Filter shape (JSON)
type FilterNode =
  | { AND: FilterNode[] }
  | { OR: FilterNode[] }
  | { NOT: FilterNode }
  | { field: string; op: FilterOp; value: unknown };

type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'startsWith' | 'endsWith'
  | 'in' | 'notIn'
  | 'isNull' | 'isNotNull';
```

## Data shapes

```ts
// Response hydration logic:
// 1. Run adapter.listRows(collectionId, { filter, sort, limit, cursor })
// 2. Adapter joins dt_row_select_values, dt_relations, dt_files in batch
// 3. FormulaEngine computes formula columns post-query
// 4. RollupEngine computes rollup columns post-query
// 5. Response shape above is returned

// Cursor format (opaque base64):
type CursorPayload = {
  v: 1;                    // version
  sortKeys: Array<[string, unknown]>;   // last row's sort field values
  rowId: string;           // tiebreaker
};
```

## Test plan

- [ ] Unit: `filter-parser.test.ts` parses valid filter JSON, rejects invalid shapes (400)
- [ ] Unit: `filter-parser.test.ts` rejects filter referencing non-existent column
- [ ] Unit: `cursor.test.ts` round-trips encode/decode
- [ ] Unit: `routes/rows.test.ts` create returns 201, list reflects, get returns single row
- [ ] Unit: `routes/rows.test.ts` filter `name contains "ab"` returns matching rows only
- [ ] Unit: `routes/rows.test.ts` sort `name:asc` returns rows in order
- [ ] Unit: `routes/rows.test.ts` cursor pagination returns next page, no overlap
- [ ] Unit: `routes/rows.test.ts` end-user principal returns 501 with structured code
- [ ] Integration: collection with multi-select column, create row with selected options, list returns hydrated `optionIds`
- [ ] Integration: collection with relation column, list returns hydrated `rowIds`
- [ ] Integration: collection with formula column, list returns computed value
- [ ] Integration: tenant A's row query never returns tenant B's rows (cross-tenant isolation regression test)
- [ ] Manual: editor opens a collection with 1000 rows, list with limit=50 + cursor walks through all pages

## Definition of done

- [ ] Code lands and typechecks
- [ ] All 5 endpoints implemented and tested
- [ ] Filter / sort / limit / cursor verified end-to-end
- [ ] Tenant isolation regression test passes
- [ ] End-user stub returns the agreed structured code
- [ ] SDK package exposes typed methods
- [ ] OpenAPI schema generated for the routes
- [ ] No regressions in collection CRUD or earlier specs
- [ ] Status moved to `done` in STATUS.md

## Open questions

- **Filter language: JSON vs string DSL?** Plan Revision D mentions a "template / expression language" for the data-bindings track. That's about render-time bindings. For server-side filters, JSON is simpler and avoids parser implementation. Recommended: JSON for v1, document the shape clearly.
- **Soft-delete row visibility:** should `archived` rows be excluded by default in list? Recommended: yes, exclude unless `?includeArchived=true`. Editor UI may want to show archived rows in a Trash view.
- **Total count on list:** computing `total` requires a separate `COUNT(*)` query. Recommended: omit from v1, add `?includeTotal=true` opt-in if/when customers ask. Cursor pagination doesn't need it.
- **File field upload flow:** does row PATCH accept new file uploads inline, or does the client upload via storage-brain first then PATCH with file ids? Recommended: latter (storage-brain-first), keep this API row-only.
- **Concurrency: write conflicts:** if two editors update the same row at once, last-write-wins in v1. Plan flags this as Phase 2 concern. The ETag is the seam. Recommended: emit ETag in v1, do not enforce.
- **Relation cardinality limits:** `dt_relations` allows many-to-many. What's the cap on relation values per cell? Recommended: hard cap at 1000 in v1, document.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Recommendation paragraph 1, Revision D for downstream binding context)
- Spec dependency: `cms-collection-crud-api`
- Adapter source: `projects/data-table/packages/adapter-prisma/src/adapter.ts` (listRows, createRow, updateRow)
- Engines: `projects/data-table/packages/core/src/formula/`, `projects/data-table/packages/core/src/rollup/`
- Junction tables: `projects/data-table/packages/adapter-prisma/prisma/schema.prisma:51` to `:85`
