---
name: slice2-read-only-data-components
track: cms-content-tier
wave: 2
priority: P0
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-read-binding-resolver-runtime, slice2-prisma-datasource-provider]
touchesSharedState: false
sharedState: []
estimateDays: 5
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Read-only data components: Collection + RecordView renderers + scope threading

> SPLIT from the original 7-day spec per the critique (it bundled three renderers + scope threading + the data-table-react integration). This spec is the ~5-day CORE: `CollectionRenderer`, `RecordViewRenderer`, and the scope-prop threading through BOTH `ComponentRenderer` and `HeadlessComponentRenderer`. The `TableViewRenderer` (the `@marlinjai/data-table-react` wrap, which has its own dep/fallback risk) is a separate ~2-day leaf: `slice2-tableview-renderer`. NO doc-tier-core refs. Consumes the resolver's provider-free `applyBindings` signature. NO lockfile change here (data-table-react add lives in the TableView spec).

## Goal

`CollectionRenderer` reads its `collection` binding, calls `useDataSource().listRows`, pushes a row frame per row, and repeats its FIRST child as a per-row template (the Events->gallery repeating component). `RecordViewRenderer` resolves a single row from `{{page.params.id}}`. Thread a `scope` prop through both component renderers so descendants resolve `{{row.field}}`.

## Scope

**In:**
- `CollectionRenderer`: reads `collection` binding, `useDataSource().listRows(collectionId, query)`, `pushRowFrame` per row, renders ONLY `children[0]` as the per-row template. Owns its children construction BEFORE the generic `children.map`.
- `RecordViewRenderer`: resolves a single row from `{{page.params.id}}`, pushes one row frame.
- Renderer integration: `createComponentElement.tsx` dispatches on `dataComponentKind` (the surviving `data-component-kind` attribute, confirmed present on the 3 registry entries `collection`/`recordView`/`tableView`) to the renderers, replacing the wave-1 dashed-box placeholder for BOUND nodes only. `ComponentRenderer` + `HeadlessComponentRenderer` accept a `scope` prop and call `applyBindings`, passing scope to children. `ResponsivePageRenderer` constructs the root `BindingScope` from page params.
- Structured filter/sort/limit as a `Query` object on `props.query` (not a template expression).
- Each component subscribes via `dataSource.subscribe` for polling reactivity.
- `tableView` `dataComponentKind` dispatch is reserved (the dispatch branch exists) but its renderer ships in `slice2-tableview-renderer`; until then a bound TableView falls back to the dashed-box placeholder with a `TableView pending` note.

**Out (explicitly deferred):**
- `TableViewRenderer` (the data-table-react wrap): `slice2-tableview-renderer`.
- Loading/empty/error directives (`slice2-data-loading-empty-error-states` provides the helper; this spec calls it once that lands, or threads a minimal inline state until then).
- Write bindings.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/data/CollectionRenderer.tsx` | new | repeat children[0] per row, push row frame |
| `src/lib/renderer/data/RecordViewRenderer.tsx` | new | single row from page params |
| `src/lib/renderer/createComponentElement.tsx` | edit | dispatch on dataComponentKind; remove placeholder for bound Collection/RecordView nodes |
| `src/components/ComponentRenderer.tsx` | edit | accept scope prop, call applyBindings, pass scope to children |
| `src/lib/renderer/HeadlessComponentRenderer.tsx` | edit | mirror |
| `src/components/ResponsivePageRenderer.tsx` | edit | construct root BindingScope from page params |
| `src/lib/renderer/data/__tests__/*.test.tsx` | new | Collection + RecordView renderers |

## API surface

```ts
// data renderers own children construction; invoked BEFORE the generic children.map
function CollectionRenderer(props: { node, scope, query?: Query }): ReactNode; // renders children[0] N times
function RecordViewRenderer(props: { node, scope }): ReactNode;
// ComponentRenderer / HeadlessComponentRenderer signatures gain `scope: BindingScope`
```

## Test plan

- [ ] CollectionRenderer bound to an Events fixture with N rows renders N template instances; each descendant `{{row.field}}` resolves to that row's value; a filter on `props.query` narrows the rendered rows.
- [ ] RecordViewRenderer with `page.params.id` resolves the right row and exposes `{{row.*}}` to descendants; a non-existent id hits empty/error.
- [ ] `subscribe` re-renders on store mutation.
- [ ] ComponentRenderer and HeadlessComponentRenderer produce IDENTICAL output for the same bound tree.
- [ ] The dashed-box placeholder only shows when UNBOUND (Collection/RecordView).

## Definition of done

- [ ] Two renderers land; dispatch is on `dataComponentKind`; first-child-as-template owned by the data renderers; scope threaded through both renderers.
- [ ] All renderer tests pass; editor/headless parity test green.
- [ ] Dashed-box only when UNBOUND.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References
- Critique (minor): the original 7-day spec bundled four deliverables; TableView (data-table-react) split into its own leaf.
- Code touchpoints: `createComponentElement.tsx`, `ComponentRenderer.tsx`, `HeadlessComponentRenderer.tsx`, `ResponsivePageRenderer.tsx`, `componentRegistry.ts` (dataComponentKind on the 3 entries)
- Consumes: resolver (`applyBindings`/`pushRowFrame`), `useDataSource()`
