---
name: data-bindings-states-pagination-and-polish
track: data-bindings
wave: 3
priority: P1
status: draft
depends_on: [data-bindings-read-only-data-components, data-bindings-editor-binding-picker]
estimated_value: 7
estimated_cost: 5
owner: unassigned
---

# Loading / error / empty states, pagination UX, broken-binding warnings

## Goal

Take the read-only data-bindings flow from "works in the happy path" to "feels right when things go sideways". Wave-2 ships sensible defaults; this wave-3 spec adds the polish layer Bubble has spent years on. Per the CMS plan: "Loading / error / empty states... 1.0 weeks each data-bound component has at least 3 states the customer designs." This spec ships the editor surface for designing those states.

## Scope

**In:**

- Editor UI for designing per-data-component loading / empty / error content. The customer can drop arbitrary subtrees into named slots: `Default`, `Loading`, `Empty`, `Error`. Phase 1 only `Default` is interactive; the others render at design time when the customer toggles a "preview state" segmented control.
- State storage: extend the data component's children to be slot-keyed instead of position-indexed. New `slot` field on the child component (optional, default `'default'`). Backwards-compatible: existing children with no slot stay as `'default'`.
- Pagination UX: a `Next page` and `Previous page` default-rendered on `Collection` and `TableView` when `props.query.limit` is set and the data source returns `nextCursor`. Customer can replace the default buttons with their own subtree via a `Pagination` slot.
- Broken-binding warnings: when `applyBindings` resolves to `undefined` against a known-broken path (column not found in the collection schema), the editor renders a yellow chip on the affected component in the canvas + a warning row in the right sidebar. Preview / publish modes silently fall back to empty.
- Skeleton loading defaults: data components ship a sensible default skeleton (gray bars) that fade in while loading.
- Style sub-property bindings: extend the binding-picker to allow binding individual `style.*` properties (e.g. `style.backgroundColor` to `{{row.brandColor}}`). Registry's `bindableSlots` already supports this via dot-path slot keys; this spec ships the picker UI for it.

**Out (explicitly deferred):**

- Custom optimistic updates (Phase 2).
- Real-time push reactivity (Phase 2 decision: LISTEN/NOTIFY+SSE vs Supabase Realtime).
- Cross-component state ("when this collection refreshes, scroll that other component to top"). Out of scope.
- Form validation states (Phase 2; Form ships in Phase 2).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/models/ComponentModel.ts` | edit | Add optional `slot?: string` to ComponentBase. Default missing = 'default'. MST-WRITE on setSlot action. |
| `src/lib/renderer/data/CollectionRenderer.tsx` | edit | Render `Loading` slot subtree while fetching, `Empty` when zero rows, `Error` on caught error, `Pagination` slot at the bottom. |
| `src/lib/renderer/data/RecordViewRenderer.tsx` | edit | Same `Loading` / `Empty` / `Error` slot logic. |
| `src/lib/renderer/data/TableViewRenderer.tsx` | edit | Same. |
| `src/components/sidebars/right/sections/StatePreviewSelector.tsx` | new | Segmented control to toggle which state slot is editable in the canvas. |
| `src/components/sidebars/right/sections/SlotsSection.tsx` | new | Lists the four slots, allows the customer to add / remove a subtree per slot. |
| `src/components/sidebars/right/BindingPicker.tsx` | edit | Add style-sub-property tab to the picker. |
| `src/lib/bindings/resolver/applyBindings.ts` | edit | When resolution returns undefined for a known-bad column path, mark a `brokenBindings` array on the result. Renderer surfaces this as a chip. |
| `src/lib/renderer/data/__tests__/states.test.tsx` | new | Loading / Empty / Error rendering tests. |

## API surface

```ts
// ComponentModel additions
ComponentBase.props({
  slot: types.maybe(types.string), // 'loading' | 'empty' | 'error' | 'pagination' | 'default' (or any custom)
});

// applyBindings extension
export interface BindingApplyResult {
  resolvedProps: PropsRecord;
  isLoading: boolean;
  brokenBindings: Array<{ slot: string; reason: string }>;
}

// Selecting which state to preview in the editor
EditorUIStore.previewedState: 'default' | 'loading' | 'empty' | 'error';
```

## Data shapes

```ts
// Collection node with state slots
{
  id: 'cmp_collection_1',
  type: 'div',
  bindings: { collection: { mode: 'read', expression: '{{collection.posts}}' } },
  props: { query: { limit: 10 } },
  children: [
    { id: 'tmpl', slot: 'default',     type: 'div', children: [/* row template */] },
    { id: 'load', slot: 'loading',    type: 'div', props: { children: 'Loading posts...' }, children: [] },
    { id: 'empt', slot: 'empty',      type: 'div', props: { children: 'No posts yet.' }, children: [] },
    { id: 'err',  slot: 'error',      type: 'div', props: { children: 'Could not load.' }, children: [] },
    { id: 'pag',  slot: 'pagination', type: 'div', children: [/* Prev / Next buttons */] },
  ],
}
```

> **MST-WRITE callout.** `setSlot(slot: string)` is a new MST mutation on ComponentModel and `previewedState` writes to EditorUIStore. The first must route through Yjs canonical once multiplayer lands; the second is editor-only state and stays in MobX.

## Test plan

- [ ] Unit: Collection with no `loading` slot child renders the default skeleton during fetch.
- [ ] Unit: Collection with a `loading` slot child renders that subtree during fetch.
- [ ] Unit: zero rows renders `empty` slot.
- [ ] Unit: a thrown fetch error renders `error` slot.
- [ ] Unit: pagination Next button advances cursor; Prev goes back.
- [ ] Unit: applyBindings flags a binding to a missing column in `brokenBindings`.
- [ ] Unit: editor preview-state selector renders the corresponding slot at design time even if data would otherwise be loaded.
- [ ] Unit: style.backgroundColor binding picker writes a `style.backgroundColor` slot binding entry.
- [ ] Manual: a customer can drop a custom Empty subtree into a Collection, toggle the preview-state to "Empty", and edit it in place.
- [ ] Manual: rename a column on the in-memory provider's fixture; confirm the broken-binding chip appears on the Text bound to it.

## Definition of done

- [ ] All four states render correctly in editor + preview + headless renderer.
- [ ] Tests pass via `pnpm test`.
- [ ] No regressions on the wave-2 happy-path tests.
- [ ] Pagination works against in-memory provider with limit=2 over a 5-row fixture.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- **Slot semantics in Yjs.** Once multiplayer lands, `slot` is just another field on a child node. No new Yjs op needed. Confirm with multiplayer track.
- **Skeleton design.** Phase 1 ships a generic 3-bar skeleton. Confirm with design that this is acceptable or pull in the section-based property panel's loading visual.
- **Error message visibility.** Should the in-canvas error subtree be visible to end-users in published apps? Default: yes (the customer designed it). Confirm.
- **CMS API contract: how do we know a column is "missing"?** This relies on `useDataSource().getCollection` returning the column list. If a column is renamed (not deleted), is the old name returned in some `aliases` field? This is the schema-evolution UX question the CMS plan flagged as Phase 2 unowned. Confirm with `cms` track that Phase 1 returns canonical column IDs only and Phase 2 may add aliasing.
- **Pagination defaults.** Should default Pagination buttons be present on Collection at all (or only when `limit` is set)? Spec says only when limit is set. Confirm.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Research question 5: Loading / error / empty 1.0 weeks; Pagination 1.0 weeks)
- Spec: `data-bindings-read-only-data-components` (target of the slot extensions)
- Spec: `data-bindings-editor-binding-picker` (target of the style-sub-property picker extension)
- Spec: `data-bindings-read-binding-resolver-runtime` (target of the brokenBindings extension)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` (Phase 1 polish quality bar: "Phase 1 read-only subset has to feel right or the whole product feels rough")
