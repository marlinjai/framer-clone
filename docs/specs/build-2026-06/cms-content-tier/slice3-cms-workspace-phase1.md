---
name: slice3-cms-workspace-phase1
track: cms-content-tier
wave: 3
priority: P0
status: decided
type: plan
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2b-cms-datatable-grid-ui]
supersedes: the single-collection CmsGridOverlay launch (overlay now hosts a rail + grid)
touchesSharedState: true
sharedState: [src/lib/bindings/dataSource/types.ts, src/server/cms/repository.ts]
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: CMS Workspace Engineer
date: 2026-06-20
---

# CMS workspace phase 1: collections rail + items grid + item counts

> Turn the single-collection grid overlay into a full **content workspace**: a full-screen
> `[ collections rail | items grid ]` surface where you see every collection at once, switch
> between them without closing, and edit the active one in the existing data-table grid. Matches
> the LEFT + CENTER of the approved mockup `docs/specs/build-2026-06/cms-workspace-agent-mockup.html`.
> The RIGHT **content agent** column is **phase 2** (separate spec) — leave room for it but do not
> build it here.

## Visual target (the mockup, distilled — LEFT + CENTER only)

- **Top bar** (full width, 48px): a brand cluster `[database tile] Content / <ActiveCollection ▾>`
  breadcrumb on the left; on the right an **Import CSV** button (render it **disabled** with a
  "coming soon" affordance — it is a phase-2 agent feature, do not wire it) and a **Close** button.
- **Collections rail** (left, ~248px, `bg-muted/40`-ish "rail" surface, `border-r`):
  - **Tabs**: `Collections` / `Fields` / `Bindings` as a segmented row. `Collections` is active and
    functional; `Fields` and `Bindings` render as **disabled "coming soon"** tabs (do not build them).
  - **Toolbar**: a row of icon buttons — `+` (new collection, wired), and `sort` / `filter` / `search`
    / `more` rendered as **disabled placeholders** (phase 1 ships the `+` + the list; the rest are
    visual-only so the toolbar matches the mockup without shipping half-built controls).
  - **Collection rows**: each row = a 22x22 rounded **icon tile** (resolved via `resolveCollectionIcon`,
    `bg-background`+hairline; active → `bg-brand/12` `text-brand`) + name (13px, 500) + a right-aligned
    **item-count** (`mono`, `text-muted-foreground`). Active row → `bg-brand/10` + 2px `bg-brand` left
    rail + `text-brand` name. Hover reveals the existing overflow menu (Open / Rename / Settings /
    Delete) — preserve those actions. Clicking a row sets it active and swaps the center grid.
  - A **"New collection"** affordance at the bottom (the existing inline-create flow).
  - **Flat list for phase 1.** Groups (e.g. "Marketing") and sub-collections (Categories) in the
    mockup need a data-model feature (a parent/group on the table) — **explicitly deferred**; render a
    single flat list, no group headings.
- **Items grid** (center, `1fr`): the header from the mockup (`<ActiveCollection> · N items`, a
  `Table / Board / Calendar` view segment with Board+Calendar **disabled** coming-soon, a Filter
  button, and the iris **New item** button) sits atop the **existing `CmsGrid`**. **Reuse `CmsGrid`
  as-is for the center** — do not hand-roll a table; the status pills, cover thumbnails, and
  featured toggle in the mockup are data-table cell renderers (select field colors, file column,
  boolean column) the engine already provides. The selection footer (`N items · M selected ·
  Publish`) is the grid's existing selection footer.

## Key decisions (locked 2026-06-20 by the Lead)

1. **The overlay becomes the workspace.** `CmsGridOverlay` (single collection) is replaced by a
   `CmsWorkspaceOverlay` (or `CmsGridOverlay` is widened) that is the same `document.body`-portaled
   full-screen `fixed z-[1000]` surface, but its body is `[rail | grid]` instead of a lone grid.
   The portal + Escape-to-close (guarded against in-cell editing) + `.light` theme pin are preserved
   exactly (do not regress the dark-theme fix from `079adb5`).
2. **`ContentManagerPanel` stays the state owner.** It already holds `collections`, the open id, the
   `CmsClient`, the typed-error banner, and `busy`. Phase 1: rename the "open id" to an **active
   collection id**; when set, mount the workspace overlay with the full collection list + active id.
   The sidebar Content tab keeps its compact list as the launcher (clicking a collection's **Open**
   opens the workspace with that collection active). All collection CRUD stays on `cmsClient` →
   `/api/cms/*` (admin-guarded), unchanged contract, errors still surfaced inline.
3. **The rail is a new presentational component** (`CollectionRail.tsx`) fed the same handlers the
   sidebar `CollectionList` uses (`onOpen`→setActive, `onCreate`, `onRename`, `onUpdate`, `onDelete`),
   plus `activeId` and the per-collection `itemCount`. Do NOT fork the CRUD logic — both the sidebar
   list and the rail call into the same `ContentManagerPanel` handlers. Reuse `collectionIcon` /
   `resolveCollectionIcon` and the existing `CollectionSettingsDialog` + delete `AlertDialog`.
4. **Item counts** are added to the `Collection` contract and populated server-side (below).
5. **Rail tabs / toolbar placeholders are disabled, not stubbed-with-fake-behavior.** A disabled
   control that says "coming soon" is honest; a control that looks live but no-ops is a silent
   failure. Render Fields/Bindings/sort/filter/search/Board/Calendar/Import-CSV as visibly disabled.

## Item-count plumbing

- `src/lib/bindings/dataSource/types.ts` — add `itemCount?: number` to the `Collection` interface
  (optional, so the read path + binding consumers are unaffected; the rail/grid header show it when
  present).
- `src/server/cms/repository.ts` `listCollections()` (≈ line 251) — populate `itemCount` per table.
  Use the **cheapest count the PrismaAdapter exposes**: verify whether the adapter has a dedicated
  count; if not, `adapter.getRows(table.id, { limit: 1 })` and read `.total` (the `RowsPage.total`
  the binding layer already surfaces). Map it through `mapCollection(table, columns, itemCount)`.
  This is an N+1 over collections — acceptable for phase 1 (single-tenant, few collections); add a
  one-line comment noting it and that a batched count is a later optimization (do NOT silently cap).
  `getCollection()` may also include the count for the active-collection header.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/bindings/dataSource/types.ts` | edit | add `itemCount?: number` to `Collection` |
| `src/server/cms/repository.ts` | edit | populate `itemCount` in `listCollections` (+ `mapCollection` signature) |
| `src/components/cms/CollectionRail.tsx` | new | the rail: tabs + toolbar + rows (icon/name/count/active/actions) + new-collection |
| `src/components/cms/grid/CmsWorkspaceOverlay.tsx` | new (or widen CmsGridOverlay) | full-screen `[rail | grid]` + top bar; reuse the portal/Escape/`.light` shell |
| `src/components/cms/ContentManagerPanel.tsx` | edit | active-collection state; mount the workspace; pass collections+counts+handlers to the rail |
| `src/components/cms/grid/CmsGrid.tsx` | edit (light) | accept the active collection name for the center header / "N items"; no engine change |
| `src/components/cms/CollectionList.tsx` | keep | still the sidebar-tab compact launcher (unchanged behavior) |
| `src/components/cms/__tests__/*` | edit/new | rail renders rows + counts + active state; switching active swaps grid; disabled placeholders are disabled; ContentManagerPanel still surfaces CmsClientError |
| `src/server/cms/__tests__/*` | edit/new | `listCollections` returns `itemCount`; an empty collection → 0 |

## Tests (headless `.test.ts(x)`, in the `pnpm test` gate)
- `repository.listCollections` returns `itemCount` per collection (fake/seeded adapter): a collection
  with 3 rows → `itemCount: 3`; an empty collection → `0`. Count failure must not crash the list.
- `CollectionRail`: renders one row per collection with its icon, name, and `itemCount`; the active
  row carries the active classes; clicking a non-active row calls `onOpen(id)`; the `+`/new-collection
  affordance calls `onCreate`; Fields/Bindings tabs and the sort/filter/search/Import-CSV placeholders
  are rendered `disabled`.
- `ContentManagerPanel`: opening mounts the workspace overlay (rail + grid) with the clicked
  collection active; switching the active collection in the rail re-mounts/keys `CmsGrid` to the new
  `tableId` (assert the grid receives the new id) without closing; Close unmounts; a `CmsClientError`
  from collection CRUD still renders inline with its typed `code`.
- Existing CmsGrid / adapter / route / repository tests stay green.

## Manual verification (Lead, real app)
- `docker start fc-dev-pg`; `DATABASE_URL=... FRAMER_CLONE_ADMIN_SECRET=dev-local-verify pnpm dev`;
  set the `admin_secret=dev-local-verify` cookie. Open the editor → Content → Open.
- The workspace shows all collections in the rail with counts; clicking `Team` swaps the center grid
  to Team without closing; the active row + breadcrumb update; counts match the grid's row count.
- Create a collection from the rail `+`; it appears with count 0; rename/settings/delete still work
  and still surface typed errors inline. The grid stays `.light`/on-brand (no dark regression).
- Screenshot the workspace against the mockup (Lead does this at integration).

## Conventions (hard)
- **data-table-react IS the engine** for the center — never hand-roll a grid. In-collection writes
  stay on the admin-guarded server-actions adapter; collection CRUD stays on `cmsClient` → `/api/cms/*`;
  reads public. Reserved Status field via `ensureStatusField` unchanged.
- **Studio tokens only** (no hardcoded gray/blue/red); reuse `ui/*` primitives + `button` `brand`
  variant + the existing dialogs. Keep the grid `.light` (do not touch `cms-grid-theme.css`/the
  `.light` pin). No new shared `ui/*` primitive — build the rail tabs locally.
- Production-grade: empty state (no collections → "Create your first collection" in the rail),
  loading state, and the typed-error banner all preserved. Disabled placeholders are honestly disabled.

## Out (deferred, each its own slice — do not half-build)
- The content agent column (phase 2, separate spec).
- Collection groups / sub-collections (needs a parent/group on the table data-model).
- Board / Calendar views; Fields / Bindings rail tabs; CSV import; the sort/filter/search rail tools.

## Definition of done
- [ ] Full-screen `[rail | grid]` workspace; rail lists all collections with icon + name + count +
      active state + Open/Rename/Settings/Delete; clicking a row swaps the center grid without closing.
- [ ] `Collection.itemCount` added + populated in `listCollections`; counts shown in rail + header.
- [ ] Reuses `CmsGrid` for the center; grid stays `.light`; no dark-theme regression.
- [ ] Placeholders (Fields/Bindings/Board/Calendar/Import-CSV/sort/filter/search) honestly disabled.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; status → in-progress → completed.
