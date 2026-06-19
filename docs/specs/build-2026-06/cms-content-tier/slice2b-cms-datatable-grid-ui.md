---
name: slice2b-cms-datatable-grid-ui
track: cms-content-tier
wave: 2
priority: P0
status: completed
type: plan
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-content-type-management-ui, slice2-cms-server-adapter-and-repo, slice2-admin-guard-stub]
supersedes: editing-UI portion of slice2-content-type-management-ui (FieldEditor + RowEditor)
touchesSharedState: false
sharedState: []
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: Marlin
date: 2026-06-19
---

# CMS content grid: data-table-react parity (Notion-style editing grid)

> Rebuild the editor-side Content panel so it drives the FULL `@marlinjai/data-table-react`
> grid (all 13 column types, inline edit, select/multi-select, relations, files, search,
> filter, sort, grouping, footer, views) instead of the hand-rolled FieldEditor + RowEditor.
> The receipt-OCR dashboard is the reference implementation. The CMS backend
> (`src/server/cms` + `/api/cms/*`) is DONE and stays; this slice only rebuilds the editing UX
> and adds the client/server-action bridge to the existing `PrismaAdapter`.

## Goal

A builder opens the **Content** tab in the left sidebar, sees a compact list of collections,
and opens any collection into a **full-screen grid overlay** (over the canvas) that is the
same Notion-like `TableView` the receipt-OCR app uses. The collections edited here are exactly
the ones the gallery/slider/Collection components bind to (same `dt_*` store), so the
"Events to gallery" flow works end to end.

## Key decisions (locked 2026-06-19)

1. **Bridge = server-actions adapter** (mirrors receipt-OCR `server-actions-adapter.ts`), NOT an
   HTTP adapter over `/api/cms/*`. Rationale: the full `DatabaseAdapter` is 41 methods spanning
   views/relations/file-refs/select-options that the existing 8-type routes do not cover, and
   `getCmsAdapter()` already returns a live `PrismaAdapter`. A server-actions adapter exposes all
   41 methods natively with zero new route handlers.
   - **Auth is NOT regressed.** Today every CMS write is `requireAdmin`-guarded. The write
     *actions* reuse the exact same contract: a server-only `requireAdminAction()` reads the
     `admin_secret` cookie via `next/headers` and compares it to `FRAMER_CLONE_ADMIN_SECRET`
     (the same env + cookie `requireAdmin` uses), throwing a typed forbidden error on mismatch.
     Every MUTATING action (`create*/update*/delete*/reorder*/archive*/bulk*/add*/remove*`) calls
     it first; read actions stay unauthenticated, matching the public read-route policy.
2. **Placement = full-screen overlay** launched from the Content tab. Sidebar = compact collection
   list; opening a collection mounts the grid full-width over the canvas (editor chrome stays).
3. **File columns = deferred upload, flagged loudly.** The `file` column type is creatable and
   bindable now. Inline upload is wired to a `FileStorageAdapter` that REJECTS with a clear
   "file storage not configured" error (loud, never a silent success). Real binary storage
   (Storage Brain / R2) is its own scoped slice. This matches the receipt-OCR reference, which
   also does not wire grid-inline upload.
4. **Collection-level CRUD stays on `cmsClient` / `/api/cms`** (preserves name-uniqueness +
   `CollectionExistsError` 409 contract + the binding-store read path). The grid uses the adapter
   only for in-collection edits (columns/rows/options/relations/files/views). Both hit the same
   `dt_*` tables, so a column added in the grid (even a non-binding type like `url`/`formula`)
   appears in the binding picker via the repository's 13->8 `mapDataTableColumnType` projection.
   This is exactly the stated "grid exposes 13, binding layer maps for rendering" split.

## Scope

**In:**
- Add `@marlinjai/data-table-core` as a direct dependency (gives `DatabaseAdapter` + input types;
  it is currently only transitive). Pin to the version `data-table-react@0.3.1` resolves (`^0.2.0`).
- `src/server/cms/actions.ts` (`'use server'`): the 41 `DatabaseAdapter` methods, each delegating to
  `getCmsAdapter()`. Server-only; no client import of Prisma.
- `src/components/cms/grid/cmsServerActionsAdapter.ts` (client-safe): builds a `DatabaseAdapter`
  from those actions (mirror of receipt-OCR `server-actions-adapter.ts`).
- `src/components/cms/grid/unconfiguredFileAdapter.ts`: a `FileStorageAdapter` whose `upload`/`delete`
  reject with a typed "storage not configured" error.
- `src/components/cms/grid/CmsGrid.tsx` (`'use client'`): `DataTableProvider` (dbAdapter +
  unconfigured fileAdapter + `workspaceId = CMS_WORKSPACE_ID`) wrapping a `useTable`/`useViews`-driven
  `TableView` with the full handler set (cell edit, add/delete row, add-property for ALL 13 types,
  column resize/align/reorder, select-option CRUD, relation picker, file upload [loud], selection,
  sort, filter, search, grouping, footer, `onRowOpen` -> `RowDetailPanel`, `ViewSwitcher` for
  table-type views). `dbAdapter` is injectable (default = the server-actions adapter) for tests.
- `src/components/cms/grid/CmsGridOverlay.tsx`: fixed full-screen overlay shell (header with
  collection name + close, mounts `CmsGrid`).
- `src/components/cms/ContentManagerPanel.tsx` (REWRITE): compact `CollectionList` in the sidebar
  pane + overlay host. Keeps `cmsClient` collection CRUD, the inline typed-error banner, and the
  empty state. "Open" affordance per collection sets the open collection and mounts the overlay.
- `src/components/cms/CollectionList.tsx` (EDIT): add an explicit "Open" affordance (`onOpen`).
- Import data-table CSS globally: `@marlinjai/data-table-react/dist/styles/base.css` +
  `.../variables.css` (matches receipt-OCR; classes/vars are `dt-*`-namespaced, no editor bleed).
- Commit the already-staged LeftSidebar "Content" tab wiring as part of this slice (closes the
  "built but never wired into the editor chrome" gap the spec required).

**Out (explicitly deferred, each its own slice, no half-built code shipped):**
- Real file/image binary storage (Storage Brain / R2 + `/api/cms/files`). Tracked as a follow-on.
- Board + Calendar views (need per-collection group/date-column pickers; TableView ships fully).
- Multi-tenancy (`withTenant` real seam, E7).

## Dead-branch cleanup (instructed: no tech debt, no orphaned code)

Superseding the FieldEditor/RowEditor UI orphans the narrow **column/row WRITE** path (its only
caller was that UI via `cmsClient`). Verified by grep: `cmsClient` is used ONLY inside
`components/cms/`; the binding/storefront/preview read path (`prismaProvider.ts`,
`TableViewRenderer`, `CollectionRenderer`, `hydrateBindings`) uses its OWN fetch and only hits the
**GET** routes. So the following are removed in the same PR (not parked):

**Removed (orphaned by this change):**
- `src/app/api/cms/collections/[id]/columns/route.ts` (POST-only) - delete file.
- `src/app/api/cms/collections/[id]/columns/[colId]/route.ts` (PATCH/DELETE-only) - delete file.
- `rows/route.ts`: remove `POST` (keep `GET`); trim now-unused imports/schemas.
- `rows/[rowId]/route.ts`: remove `PATCH` + `DELETE` (keep `GET`); trim imports.
- `cmsClient.ts`: remove `addColumn/renameColumn/retypeColumn/deleteColumn/createRow/updateRow/
  deleteRow/listRows` (+ `NewField`/`RowValues` if unused). Keep `listCollections/createCollection/
  renameCollection/deleteCollection` (the panel still uses these, admin-guarded, live).
- `repository.ts`: remove the `CmsWriteRepository` column/row methods (`addColumn/renameColumn/
  retypeColumn/deleteColumn/createRow/updateRow/deleteRow`) and the helpers that lose their only
  caller (`mapBindingColumnType`, `mapRowValuesToCells`). Keep `createCollection/renameCollection/
  deleteCollection`. Update the `src/server/cms/index.ts` barrel + `NewField`/`RowValues` exports.
- `FieldEditor.tsx`, `RowEditor.tsx` - delete.
- Tests: drop the column/row blocks in `repository.write.test.ts` and `write-routes.test.ts`
  (keep their collection blocks). `routes.test.ts` (GET) stays.

**Kept (verified live, NOT dead):**
- All `/api/cms` **GET** routes (binding/storefront/preview read path).
- Collection **WRITE** routes + repo methods (panel via `cmsClient`, admin-guarded).
- `requireAdmin`, `mapDataTableColumnType` (13->8 read projection), the whole read repository.

The toolchain backstops the audit: after removal, `tsc --noEmit` + `lint` (no-unused) flag any
straggler unused helper/import/export, and the full test suite proves nothing live was cut.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `package.json` | edit | add `@marlinjai/data-table-core` dep; `pnpm install` |
| `src/server/cms/actions.ts` | new | `'use server'`, 41 adapter methods over `getCmsAdapter()` |
| `src/components/cms/grid/cmsServerActionsAdapter.ts` | new | client-safe `DatabaseAdapter` over actions |
| `src/components/cms/grid/unconfiguredFileAdapter.ts` | new | loud "storage not configured" `FileStorageAdapter` |
| `src/components/cms/grid/CmsGrid.tsx` | new | `DataTableProvider` + `useTable`/`useViews` + `TableView` |
| `src/components/cms/grid/CmsGridOverlay.tsx` | new | full-screen overlay shell |
| `src/components/cms/ContentManagerPanel.tsx` | rewrite | compact list + overlay host (keep cmsClient + errors) |
| `src/components/cms/CollectionList.tsx` | edit | add `onOpen` affordance |
| `src/components/cms/FieldEditor.tsx` | delete | replaced by grid |
| `src/components/cms/RowEditor.tsx` | delete | replaced by grid |
| `src/app/globals.css` (or `layout.tsx`) | edit | import data-table base.css + variables.css |
| `src/components/sidebars/LeftSidebar.tsx` | commit | Content tab wiring (already staged) |
| `src/components/cms/grid/__tests__/cmsServerActionsAdapter.test.ts` | new | all 41 methods forward; `transaction` runs `fn(this)` |
| `src/components/cms/grid/__tests__/unconfiguredFileAdapter.test.ts` | new | upload/delete reject with clear message |
| `src/components/cms/grid/__tests__/CmsGrid.test.tsx` | new | fake adapter; renders grid; add-property `url`/`formula` reaches adapter; cell edit persists |
| `src/components/cms/__tests__/ContentManagerPanel.test.tsx` | rewrite | list renders, open->overlay->grid, close; CmsClientError still surfaces inline; empty state |

## Test plan (headless `.test.ts(x)` only, in the `pnpm test` gate)

- [ ] `cmsServerActionsAdapter`: every one of the 41 `DatabaseAdapter` methods forwards its args to
      the matching action (mocked actions module); `transaction(fn)` invokes `fn(adapter)`.
- [ ] `unconfiguredFileAdapter`: `upload`/`delete` reject with the typed "storage not configured"
      message (proves the loud, non-silent contract).
- [ ] `CmsGrid` with a fake in-memory `DatabaseAdapter`: `TableView` renders seeded columns + rows;
      invoking add-property with a NON-binding type (`url`, `formula`) calls `adapter.createColumn`
      with that exact type (proves the full 13-type set is exposed, not the narrowed 8); an inline
      cell edit calls `updateCell` -> `adapter.updateRow`.
- [ ] `ContentManagerPanel`: renders the collection list; clicking "Open" mounts the overlay grid;
      close unmounts it; a `CmsClientError` from collection CRUD still renders inline with its typed
      `code`; empty state shows "Create your first collection".
- [ ] Existing `/api/cms` route + repository tests stay green (no backend change).

## Manual verification (real app, not just jsdom)

- [ ] `docker start fc-dev-pg`; `DATABASE_URL=... pnpm dev`; open the editor, Content tab.
- [ ] Create collection `Events`; open it; add columns of several types incl. `url` + `formula` +
      `select` (with options) + `relation`; add rows; inline-edit cells; reload -> data persists.
- [ ] File column: inline upload shows the loud "storage not configured" state (no silent success).
- [ ] The new collection + its columns appear in the gallery binding picker (same `/api/cms` store).
- [ ] Screenshot the grid to confirm visual parity with the receipt-OCR reference.
      (Per project rule, drag/resize interactions are verified manually by Marlin, not via DevTools.)

## Definition of done

- [ ] Content tab opens a full-screen overlay grid with full data-table-react parity for editing.
- [ ] Server-actions bridge + injectable adapter; no new `/api/cms` routes needed.
- [ ] File upload fails LOUDLY (storage-not-configured), never silently.
- [ ] Collections/columns created in the grid appear in the binding picker (13->8 mapped).
- [ ] FieldEditor + RowEditor removed; LeftSidebar Content tab committed.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; this STATUS -> in-progress -> completed.

## Outcome (shipped 2026-06-19)

All gates green: `pnpm test` (560), `tsc --noEmit`, `lint`, `build`. Live-verified in the running
editor on :3001 (screenshots): Content tab reachable, collection list renders the seeded
`Events`/`Team`, the grid overlay mounts full-screen, and the add-property menu exposes the FULL
13-type set (Text/Number/Date/Checkbox/Select/Multi-select/URL/Files/Formula/Relation/Rollup/
Created/Last-edited). The admin-guarded collection route returns 201 with a secret and 401 without.

Notable deltas from the draft, all intentional:
- **Overlay is portaled to `document.body`** (`z-[1000]`). The panel lives deep in the left
  sidebar's stacking context, so a nested `fixed` overlay painted BELOW the right properties
  sidebar; portaling fixes the layering so it is truly full-screen. (Caught in live verification.)
- **Auth not regressed**: added `src/server/auth/adminAction.ts` (`requireAdminAction`, cookie via
  next/headers) + `adminAction.test.ts`. Every mutating server action calls it.
- **File adapter**: shipped our own `cmsFileAdapter` (loud typed `CmsFileStorageUnconfiguredError`
  on upload, no-op delete) rather than leaning on the engine's NoopFileAdapter, so the contract is
  ours and tested.
- **Client-safe `CMS_WORKSPACE_ID`** extracted to `src/lib/cms/constants.ts` (re-exported from the
  server adapterClient) so the client grid and server adapter share one source of truth.
- **Deferred (own slices, NOT shipped half-built)**: real file/image binary storage; `ViewSwitcher`
  + saved views + Board/Calendar layouts (single `TableView` ships; search/filter/sort/group/footer
  are in-session component state); `onRowOpen` detail panel. Grid-internal interactions (cell edit,
  column add via the menu, drag) are covered by the headless `CmsGrid` test + are Marlin's manual
  pass (synthetic events are unreliable against this engine).

## References

- Reference impl: `receipt-ocr-app/src/app/app/dashboard/{DashboardClient,server-actions-adapter,actions}.ts(x)`.
- Engine surface: `data-table/packages/{core/src/db-adapter.ts, react/src/index.ts}` (41-method
  `DatabaseAdapter`; `DataTableProvider` props; `useTable`/`useViews`/`TableView`).
- Backend (unchanged): `src/server/cms/{adapterClient,repository,columnTypeMap}.ts`, `/api/cms/*`.
- Supersedes the FieldEditor/RowEditor editing UI from `slice2-content-type-management-ui.md`
  (that spec's write-repo + routes remain the source of truth).
