---
name: slice2-editor-binding-picker
track: cms-content-tier
wave: 3
priority: P0
status: done
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-read-only-data-components, slice2-content-type-management-ui]
touchesSharedState: true
sharedState: [mst-tree]
estimateDays: 6
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Editor binding picker UX (bind a component slot to a collection field)

> NO doc-tier-core coupling; the single MST-WRITE `setQuery` action stands. This is the ONLY CMS-track spec that touches `mst-tree`. `setBinding`/`clearBinding` exist (with MST-WRITE comments) and are reused. The QueryBuilder's `props.query` write REQUIRES one new MST ACTION (`setQuery`), tagged MST-WRITE, writing into the existing frozen props record (NO new `.props()` FIELDS on the model).

## Goal

A builder can attach a read binding to any bindable slot of the selected component from the right sidebar, plus a visual filter/sort/limit QueryBuilder for Collection/TableView. Keep new MST write surface MINIMAL so the later Yjs cutover stays cheap; tag every picker-driven MST write `MST-WRITE`.

## Scope

**In:**
- `BindingControl` next to each prop control declared in the registry's `bindableSlots` (`getBindableSlotsFor`): unbound shows the static control + a link icon; bound shows a read-only chip (`{{row.title}}`) + unlink.
- `BindingPicker` popover: a scope tree (Page params, plus, when an ancestor is a Collection/RecordView, each column of the bound collection as `{{row.<column>}}`, columns resolved live via `useDataSource().getCollection`), plus a free-form `{{...}}` input that red-borders on parse failure.
- `scopeIntrospection.getAvailableScopeFrames`: walks ancestry to find the available row frame.
- Committing a binding calls `node.setBinding(slot, binding)` (EXISTING). QueryBuilder writes `node.props.query` via a NEW small `setQuery(query)` action (tagged MST-WRITE).
- A broken binding (column deleted) shows a `column not found` warning chip (no auto-migrate).
- The picker's `scopeHint` switch must default/`any`-branch on UNKNOWN hints so Track C's additive commerce `scopeHint` values (`product`/`variant`/`availability`) do not break it.

**Out (explicitly deferred):**
- Hocuspocus/Yjs (epic E4).
- Write bindings/Form/LoginForm (epic E8/P6).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/components/sidebars/right/BindingControl.tsx` | new | per-slot bind/unbind control |
| `src/components/sidebars/right/BindingPicker.tsx` | new | scope-tree popover + free-form input; default-branch on unknown scopeHint |
| `src/components/sidebars/right/QueryBuilder.tsx` | new | filter/sort/limit, writes props.query |
| `src/components/sidebars/right/sections/DataSourceSection.tsx` | new | section wiring |
| `src/lib/bindings/scopeIntrospection.ts` | new | getAvailableScopeFrames |
| `src/models/ComponentModel.ts` | edit | NEW setQuery(query) action, tagged MST-WRITE (NO new .props() fields) |
| `src/components/sidebars/right/__tests__/*.test.tsx` | new | BindingPicker, QueryBuilder |

## API surface

```ts
export function getAvailableScopeFrames(node: ComponentModel): ScopeFrameInfo[]; // Collection ancestor's collectionId for deep nodes
// ComponentModel:
//   setBinding(slot, binding)  // EXISTING, reused (MST-WRITE)
//   clearBinding(slot)         // EXISTING, reused (MST-WRITE)
//   setQuery(query: Query)     // NEW action, writes into the existing frozen props record. TAG: MST-WRITE. No new .props() field.
```

## Test plan

- [ ] `getAvailableScopeFrames` returns the Collection ancestor's collectionId for a deeply-nested node.
- [ ] The picker shows Page>params and, under a Collection bound to Events, that collection's LIVE columns as `{{row.<col>}}`.
- [ ] Clicking a column commits `{mode:'read', expression:'{{row.title}}'}` via `setBinding`; the canvas re-renders.
- [ ] Free-form `{{rowx.title}}` red-borders (parser returns null).
- [ ] Unlink calls `clearBinding`.
- [ ] QueryBuilder add/remove filter and sort writes `props.query` via `setQuery` (MST-WRITE).
- [ ] A broken binding (column deleted) shows a `column not found` warning chip (no auto-migrate).
- [ ] An UNKNOWN `scopeHint` does not break the picker switch (default/any branch).
- [ ] No regression in existing right-sidebar property tests.

## Definition of done

- [ ] A builder can set up Collection>Text-bound-to-row.title entirely from the UI.
- [ ] Every picker MST write carries an `MST-WRITE` comment; NO new MST `.props()` fields added; the new `setQuery` action is the only new action.
- [ ] The picker tolerates unknown scopeHint values.
- [ ] All picker/QueryBuilder tests pass; no right-sidebar regressions.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Code touchpoints: `ComponentModel.ts` (setBinding/clearBinding already MST-WRITE; updateResponsiveStyle / setTextContent are the only existing props writers), `componentRegistry.ts` (getBindableSlotsFor, `bindableSlots`), `useDataSource()`
- Depends on: `slice2-read-only-data-components`, `slice2-content-type-management-ui`
