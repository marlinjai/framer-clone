---
name: slice2-cms-server-adapter-and-repo
track: cms-content-tier
wave: 1
priority: P0
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [track0-backend-foundation]
touchesSharedState: true
sharedState: [lockfile]
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# CMS server tier: adapterClient + read repository + 13->8 column-type map (replaces doc-tier-core)

> REPLACES the dropped `slice2-doc-tier-shared-package`. There is NO `@marlinjai/doc-tier-core` package and NO lumitra-web dependency: framer-clone consumes `@marlinjai/data-table-adapter-prisma@^0.2.2` DIRECTLY from npm and keeps all repo-mapping code internal under `src/server/cms/`. lumitra-web offers is a separate parked workstream that will independently consume adapter-prisma; the two do NOT share a package (different data). The package-home open question is DELETED (moot).

> OWNS the adapter-prisma dependency add. The earlier `workspace:*` blocker is RESOLVED: `@marlinjai/data-table-adapter-prisma@0.2.2` (and adapter-shared@0.2.2) are published with real semver deps and install cleanly. Pin `"@marlinjai/data-table-adapter-prisma": "^0.2.2"` (adapter-shared comes transitively). No republish, no vendor fallback.

## Goal

Build the server-only CMS document tier under `src/server/cms/`: wire a schema-bound `PrismaAdapter` from adapter-prisma against the Track-0 `DATABASE_URL`, expose a read repository (`listCollections`/`getCollection`/`listRows`/`getRow`) mapping adapter-prisma `Table`/`Column`/`Row` to the existing binding-layer shapes in `src/lib/bindings/dataSource/types.ts`, and implement the lossy 13->8 column-type map. This is the server-side foundation both the live read provider (`slice2-prisma-datasource-provider`) and the build-time hydrator (`slice2-publish-read-binding-hydration`) read from.

## Scope

**In:**
- **Dependency add:** `"@marlinjai/data-table-adapter-prisma": "^0.2.2"` (direct from npm, real semver deps, no `workspace:*` leak; pulls `@marlinjai/data-table-adapter-shared@^0.2.2` + `@marlinjai/data-table-core@^0.3.0` transitively). Its `@prisma/client` dep is the Track-0 6.x one, one PrismaClient.
- `src/server/cms/adapterClient.ts`: `getCmsAdapter()` building a `PrismaAdapter` from the Track-0 `getPrismaClient()`, bound to the constant single-tenant schema. `import 'server-only'`.
- `src/server/cms/columnTypeMap.ts`: `mapDataTableColumnType(dt)` mapping all THIRTEEN adapter-prisma input types (`text/number/date/boolean/select/multi_select/url/file/formula/relation/rollup/created_time/last_edited_time`) to the 8 binding `ColumnType` outputs. LOSSY with explicit documented fallbacks.
- `src/server/cms/repository.ts`: the READ repository over the adapter, mapping `Table->Collection`, `Column->Column` (via the type map), `Row->Row` (cells keyed by column id, multi-select arrays, file URLs as strings), `Query` passthrough/translation, `RowsPage` with cursor.
- `src/server/cms/withTenant.ts`: `withTenant(prisma, schema, fn)` with the `SET LOCAL search_path` SIGNATURE, body collapsed to the constant schema, tagged as the E7 multi-tenant seam (designed not built).
- `src/server/cms/index.ts`: the server barrel (re-exports `getCmsRepository`, types).

**Out (explicitly deferred):**
- WRITE methods (content-type create/field DDL): `slice2-content-type-management-ui`.
- The client-facing React provider: `slice2-prisma-datasource-provider`.
- The build-time hydrator: `slice2-publish-read-binding-hydration`.
- Any MST involvement; any multi-tenant chassis (E7).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `package.json` | edit | add `"@marlinjai/data-table-adapter-prisma": "^0.2.2"` (adapter-shared transitive); `lockfile` shared-state |
| `src/server/cms/adapterClient.ts` | new | `getCmsAdapter()`, schema-bound PrismaAdapter, server-only |
| `src/server/cms/columnTypeMap.ts` | new | 13->8 lossy map |
| `src/server/cms/repository.ts` | new | read repo, adapter->binding shape mapping |
| `src/server/cms/withTenant.ts` | new | SET LOCAL signature, constant-schema body, E7 seam |
| `src/server/cms/index.ts` | new | server barrel |
| `src/server/cms/__tests__/columnTypeMap.test.ts` | new (node project) | all 13 INPUTS covered |
| `src/server/cms/__tests__/repository.test.ts` | new (node project) | listRows -> RowsPage mapping (multi-select + file) |

## API surface

```ts
// src/server/cms/index.ts (server-only)
export function getCmsRepository(): CmsReadRepository;
export interface CmsReadRepository {
  listCollections(): Promise<Collection[]>;
  getCollection(id: string): Promise<Collection | null>;
  listRows(id: string, query?: Query): Promise<RowsPage>;
  getRow(id: string, rowId: string): Promise<Row | null>;
}
export function mapDataTableColumnType(dt: DataTableColumnType): BindingColumnType;
export function withTenant<T>(prisma: PrismaClient, schema: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
```

## Data shapes

```ts
// 13 adapter-prisma inputs -> 8 binding outputs (LOSSY, explicit fallbacks):
//   text->text, number->number, date->date, boolean->boolean, select->select,
//   multi_select->'multi-select'  (UNDERSCORE to HYPHEN normalization),
//   relation->relation, file->file,
//   url->text (fallback), formula->text, rollup->text,
//   created_time->date, last_edited_time->date   (best-effort, documented)
// Binding shapes are the EXISTING src/lib/bindings/dataSource/types.ts
// (Collection/Column/Row/Query/RowsPage). This spec does NOT change those.
```

## Test plan

- [ ] Unit: `mapDataTableColumnType` covers ALL 13 adapter-prisma INPUT values; asserts underscore->hyphen for `multi_select`; asserts the documented fallback for `url`/`formula`/`rollup`/`created_time`/`last_edited_time`.
- [ ] Unit: repository maps an adapter `listRows` result (cells keyed by column id) into a binding-layer `RowsPage` (values keyed by `Column.id`), including multi-select arrays and file URLs as strings.
- [ ] Unit: `withTenant` present with the `SET LOCAL search_path` signature, constant-schema body, E7-seam comment.
- [ ] Integration (`pnpm test:integration`, Track-0 Dockerized Postgres): `getCmsRepository().listCollections()` returns mapped `Collection[]`.
- [ ] No React import anywhere under `src/server/cms/` (grep/lint check; it must be Node-callable for the hydrator).

## Definition of done

- [ ] `pnpm add @marlinjai/data-table-adapter-prisma@^0.2.2` resolves and installs cleanly in framer-clone (no `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`; adapter-shared@^0.2.2 pulled transitively). NO `@marlinjai/doc-tier-core`, NO lumitra-web dep.
- [ ] `pnpm why @prisma/client` still resolves to the single Track-0 6.x instance (adapter and `src/server/db.ts` agree).
- [ ] All 13-input column-type mapping tests pass.
- [ ] Repository read-mapping test passes (multi-select arrays + file URLs).
- [ ] `src/server/cms/**` is server-only (no React import) and Node-callable.
- [ ] A doc note records `adapter.transaction()` is a verified no-op (`adapter.ts:894`) so multi-row atomicity is the consumer's `prisma.$transaction` concern; single-entity DDL is atomic per the adapter's `atomicDDL/ddl.ts`.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.
- [ ] No MST involvement.

## Open questions

- None. The adapter-prisma availability question is RESOLVED: `^0.2.2` is published with real semver deps and installs cleanly; pin it directly.

## References

- Re-scope brief (2026-06-16): drop doc-tier-core; consume adapter-prisma directly into `src/server/cms`.
- Critique (RESOLVED): the earlier adapter-prisma@0.2.1 + adapter-shared@0.2.1 `workspace:*` leak is fixed; `0.2.2` is republished with real semver deps (`^0.3.0` / `^0.2.2`) and installs cleanly.
- Code touchpoints: `src/lib/bindings/dataSource/types.ts` (binding Collection/Column/Row/Query/RowsPage), `data-table/packages/core/src/types.ts` (13-value ColumnType), `data-table/packages/adapter-prisma/src/adapter.ts:894` (no-op transaction), `data-table/packages/adapter-prisma/src/ddl.ts` (atomicDDL)
- Depends on: `track0-backend-foundation` (PrismaClient singleton + DATABASE_URL + the 8 dt_* models + test substrate)
