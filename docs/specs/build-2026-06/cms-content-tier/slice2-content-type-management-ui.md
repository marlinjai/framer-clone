---
name: slice2-content-type-management-ui
track: cms-content-tier
wave: 2
priority: P0
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-cms-server-adapter-and-repo, slice2-prisma-datasource-provider, slice2-admin-guard-stub]
touchesSharedState: false
sharedState: []
estimateDays: 5
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Content-type + custom-field management UI (define an Events collection with fields)

> The write-repository extension lands in framer-clone `src/server/cms/repository.ts` (NOT `packages/doc-tier-core` in lumitra-web). NO `@marlinjai/doc-tier-core`. Mutations go through `/api/cms/*` write routes guarded by the `slice2-admin-guard-stub` `requireAdmin`. KEEP the adapter-prisma `createTable`/`createColumn` DDL + the specific-error-contract surfacing.

## Goal

Editor-side UI letting a builder create a content type (collection) and define its custom fields against the single-tenant adapter-prisma store, producing the Events collection the gallery/slider repeating components later bind to. Writes go through admin-guarded `/api/cms/*` routes calling a WRITE-capable extension of the `src/server/cms` repository (adapter-prisma `createTable`/`createColumn`/`createRow`/`updateRow`).

## Scope

**In:**
- WRITE extension of `src/server/cms/repository.ts`: `createCollection`/`renameCollection`/`deleteCollection`, `addColumn`/`renameColumn`/`retypeColumn`/`deleteColumn`, `createRow`/`updateRow`/`deleteRow`, calling adapter-prisma DDL (NOT MST, NOT the no-op `adapter.transaction()`; single-entity DDL is atomic per adapter-prisma `atomicDDL/ddl.ts`).
- `/api/cms/*` WRITE routes (POST/PATCH/DELETE for collections, columns, rows), each guarded by `requireAdmin(req)`; `runtime = 'nodejs'`; Track-0 error envelope.
- Editor UI: a management panel reachable from the editor chrome (a "CMS"/"Content" panel), NOT a canvas component. Collection create/rename/delete; column (field) add/rename/retype/delete using the binding-layer `ColumnType` union; basic row create/edit/delete.
- Errors surface LOUDLY: the route catches adapter-prisma's SPECIFIC collision/DDL error type (verified against `ddl.ts` and the adapter's error types), returns a typed envelope, and the UI renders it inline. Empty state (`Create your first collection`).

**Out (explicitly deferred):**
- Multi-row atomic writes (not needed here).
- MST writes (this spec writes no MST).
- `withTenant` real multi-tenancy (E7; the constant-schema seam is used).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/cms/repository.ts` | edit | EXTEND with write methods (adapter createTable/createColumn/createRow/updateRow) |
| `src/app/api/cms/collections/route.ts` | edit | add POST (create), guarded |
| `src/app/api/cms/collections/[id]/route.ts` | edit | add PATCH/DELETE, guarded |
| `src/app/api/cms/collections/[id]/columns/route.ts` | new | POST add column, guarded |
| `src/app/api/cms/collections/[id]/columns/[colId]/route.ts` | new | PATCH/DELETE column, guarded |
| `src/app/api/cms/collections/[id]/rows/route.ts` | edit | add POST create row, guarded |
| `src/app/api/cms/collections/[id]/rows/[rowId]/route.ts` | edit | add PATCH/DELETE, guarded |
| `src/components/cms/ContentManagerPanel.tsx` | new | panel root |
| `src/components/cms/CollectionList.tsx` | new | collection CRUD |
| `src/components/cms/FieldEditor.tsx` | new | column CRUD |
| `src/components/cms/RowEditor.tsx` | new | row CRUD |
| `src/server/cms/__tests__/repository.write.test.ts` | new (node project) | write repo against a test schema |
| `src/components/cms/__tests__/*.test.tsx` | new | panel UI + inline-error rendering |

## API surface

```ts
// EXTEND CmsReadRepository in src/server/cms (write methods):
export interface CmsWriteRepository extends CmsReadRepository {
  createCollection(name: string): Promise<Collection>;
  renameCollection(id: string, name: string): Promise<void>;
  deleteCollection(id: string): Promise<void>;
  addColumn(id: string, field: NewField): Promise<Column>;
  renameColumn(id: string, colId: string, name: string): Promise<void>;
  retypeColumn(id: string, colId: string, type: BindingColumnType): Promise<void>;
  deleteColumn(id: string, colId: string): Promise<void>;
  createRow(id: string, values: RowValues): Promise<Row>;
  updateRow(id: string, rowId: string, values: Partial<RowValues>): Promise<Row>;
  deleteRow(id: string, rowId: string): Promise<void>;
}
// Write routes: 200/201 the entity; 401/403 via requireAdmin; the specific
// adapter collision -> 409 envelope { error: { code: 'collection_exists', ... } }.
```

## Test plan

- [ ] Builder can create a collection `Events` with fields (title:text, date:date, cover:file, tags:multi-select), rename/delete fields, add/edit/delete rows; the collection appears in `listCollections` (same store the binding picker reads).
- [ ] Mutations persist to the adapter-prisma schema and survive reload.
- [ ] Duplicate-slug and DDL errors: the route catches the SPECIFIC adapter-prisma collision/DDL error type and returns a typed 409/400 envelope; the UI renders it inline, never silently fails.
- [ ] Write routes reject when `requireAdmin` fails (401/403); read still works unauthenticated.
- [ ] Empty state shows a create-first-collection affordance.

## Definition of done

- [ ] Full collection/field/row CRUD from the UI; Events collection appears in `listCollections`.
- [ ] Write repo + write routes land in `src/server/cms` + `src/app/api/cms`; NO `packages/doc-tier-core`, NO lumitra-web file.
- [ ] Specific-error-contract surfacing test passes (not a generic try/catch).
- [ ] Write routes guarded by `requireAdmin`.
- [ ] Empty state affordance; panel does NOT write MST.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- Confirm the adapter-prisma collision error shape during build; if it throws an opaque error, add a typed wrapper in `src/server/cms` and surface that.

## References

- Re-scope brief (2026-06-16): write repo extension lands in `src/server/cms/repository.ts`, not lumitra-web; keep adapter DDL + specific-error contract.
- Code touchpoints: `data-table/packages/adapter-prisma/src/adapter.ts` (createTable/createColumn/createRow/updateRow), `.../src/ddl.ts` (atomicDDL), `src/server/cms/repository.ts`, `src/server/auth/guard.ts` (requireAdmin)
- Depends on: `slice2-cms-server-adapter-and-repo` (read repo + adapterClient), `slice2-prisma-datasource-provider` (route conventions), `slice2-admin-guard-stub` (requireAdmin)
