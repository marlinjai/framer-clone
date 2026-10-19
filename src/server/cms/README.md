# CMS server tier (`src/server/cms`)

Server-only, React-free document tier for the framer-clone CMS. It wires
`@marlinjai/data-table-adapter-prisma` to the Track-0 PrismaClient singleton and
exposes a READ repository mapped onto the binding-layer shapes in
`src/lib/bindings/dataSource/types.ts`.

This is the foundation both the live read provider
(`slice2-prisma-datasource-provider`) and the build-time hydrator
(`slice2-publish-read-binding-hydration`) read from. Everything here is
Node-callable (no React import anywhere under this directory) so the hydrator
can run it at build time.

## Modules

- `adapterClient.ts`: `getCmsAdapter()` builds one `PrismaAdapter` over the
  shared `getPrismaClient()`, pinned to the constant single-tenant schema
  (`CMS_SCHEMA = 'public'`) and workspace (`CMS_WORKSPACE_ID`). `server-only`.
- `columnTypeMap.ts`: `mapDataTableColumnType(dt)`, the lossy 13 -> 8 map.
- `repository.ts`: the read repository (`listCollections` / `getCollection` /
  `listRows` / `getRow`), constructed per workspace; a collection or row of
  another workspace reads as missing. `server-only`.
- `readScope.ts`: `resolveCmsReadContext(req)`, which decides the workspace a
  `/api/cms/*` GET may read. Editor host: a verified session, the active
  workspace and `viewSite` on it (401 / 403 / 503 otherwise). Published-site
  host: the workspace of the site the Host resolves to, never the session
  (decision D2). Any other host: 404. `server-only`.
- `publishedVisibility.ts`: THE rule for which rows a published site shows
  (no Status field: every non-archived row; a Status field: only rows whose
  status is Published; never archived rows). `getPublishedCmsRepository` in
  `repository.ts` applies it, caps pages at 100 rows, and is what the
  storefront render and the published-site `/api/cms` plane read through.
  `ensureStatusField` stamps the rows that exist when it first creates the
  field as Published, so introducing the workflow unpublishes nothing.
- `tableScopedAdapter.ts`: an adapter whose table discovery is narrowed to one
  table, so a published row-by-id read never walks every tenant's tables.
- `editorScope.ts`: `requireCmsEditorScope(action)`, the first check of every
  grid server action in `actions.ts` (reads and writes): refused off the editor
  host, then the session's active-workspace scope. `server-only`.
- `actions.ts` + `workspaceGuard.ts`: the grid's server actions; writes assert
  entity ownership, reads answer a foreign entity like a missing one.
- `withTenant.ts`: the E7 multi-tenant seam (designed, not built).
- `types.ts`: derives adapter-prisma entity types structurally from
  `PrismaAdapter` (see "Why no data-table-core import" below).
- `index.ts`: the server barrel.

## Lossy 13 -> 8 column-type map

adapter-prisma has 13 column types; the binding layer has 8. The collapse:

| adapter-prisma     | binding        | note                              |
| ------------------ | -------------- | --------------------------------- |
| `text`             | `text`         | lossless                          |
| `number`           | `number`       | lossless                          |
| `date`             | `date`         | lossless                          |
| `boolean`          | `boolean`      | lossless                          |
| `select`           | `select`       | lossless                          |
| `relation`         | `relation`     | lossless                          |
| `file`             | `file`         | lossless                          |
| `multi_select`     | `multi-select` | underscore normalized to hyphen   |
| `url`              | `text`         | lossy fallback (no url type)      |
| `formula`          | `text`         | lossy fallback (computed value)   |
| `rollup`           | `text`         | lossy fallback (computed value)   |
| `created_time`     | `date`         | lossy fallback (timestamp)        |
| `last_edited_time` | `date`         | lossy fallback (timestamp)        |

## Transaction semantics (verified no-op)

`adapter.transaction()` in adapter-prisma
(`data-table/packages/adapter-prisma/src/adapter.ts:894`) is a verified NO-OP:

```ts
async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
  return fn(this);
}
```

It opens no surrounding database transaction. Consequences:

- Multi-row atomicity is the CONSUMER's concern: wrap multi-step work in the
  underlying `getPrismaClient().$transaction(...)` (or `withTenant`), not in
  `adapter.transaction()`.
- Single-entity DDL is already atomic on its own per the adapter's `atomicDDL`
  (`data-table/packages/adapter-prisma/src/ddl.ts`).
- The read repository in this slice issues only single statements, so this is a
  non-issue here; it matters for the write slices.

## Why no `@marlinjai/data-table-core` import

adapter-prisma re-exports its entity types (`Table`/`Column`/`Row`/...) only
from `@marlinjai/data-table-core`, which is a TRANSITIVE dependency. Under
pnpm's strict, non-hoisted layout that package is not resolvable from a direct
`import ... from '@marlinjai/data-table-core'` in framer-clone source. Adding it
as a direct dependency is out of scope for this slice (the only declared
dependency add is adapter-prisma). So `types.ts` derives the core types
structurally from `PrismaAdapter`'s public method signatures, keeping the
repository fully type-checked against the real shapes with a single dependency
line and no hand-copied unions that could drift.

## Pagination cursor

The binding `Query.cursor` / `RowsPage.nextCursor` is the opaque token this
repository owns. It encodes the absolute row offset as a decimal string, which
matches the adapter's `getRows` cursor (`String(offset + limit)`), so it decodes
straight back into `offset`.
