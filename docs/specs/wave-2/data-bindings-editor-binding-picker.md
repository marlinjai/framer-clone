---
name: data-bindings-editor-binding-picker
track: data-bindings
wave: 2
priority: P0
status: draft
depends_on: [data-bindings-binding-shape-on-component-model, data-bindings-component-registry-bindable-slots, data-bindings-data-source-provider-interface]
estimated_value: 9
estimated_cost: 6
owner: unassigned
---

# Editor binding picker UX

## Goal

Give the customer a "Bind to..." UI in the right sidebar that lets them attach a read binding to any bindable slot of the selected component. Without this, customers can't actually use bindings; the resolver runtime would only be reachable via dev console. This is the editor-binding-UX line item from the CMS plan (~2 weeks of the 12-13 week binding total) for the read-only Phase 1 subset.

## Scope

**In:**

- A `BindingControl` component that renders next to each bindable prop in the right sidebar. Two visual states:
  - Unbound: shows the static prop control (text input, color picker, etc.) plus a small "link" icon button. Clicking the icon opens the binding picker.
  - Bound: replaces the static control with a read-only chip showing the binding label (e.g. `{{row.title}}`) plus an "unlink" button.
- Binding picker popover with a tree:
  - **Page**: `params.id`, `params.<other>` (read from page model).
  - **Collection (when nested under a Collection or RecordView)**: each column of the bound collection appears as `{{row.<column>}}`.
  - **Free-form expression input** for power-users to type `{{...}}` directly.
- Filter / sort / limit visual builder for `Collection` and `TableView` `props.query`. UI appears as a separate "Source" panel section. Customer picks columns from the bound collection's column list (resolved via `useDataSource().getCollection`). Builder writes a structured `Query` object to `props.query`.
- Live integration: setting a binding via the picker calls `node.setBinding(slot, binding)` (MST-WRITE), the canvas re-renders immediately.
- Slot-to-prop mapping: registry's `bindableSlots` declares the displayable slots; picker only renders controls for those.
- Section integration: lands inside the existing right-sidebar section primitives (the in-flight property panel rework).

**Out (explicitly deferred):**

- Write-binding picker (Phase 2): would offer `mode: 'write'` slots like form-field-to-column. Phase 1 picker only displays `read` mode.
- Binding history / undo at the binding level beyond what HistoryStore already provides for MST writes.
- Computed / derived bindings (`{{row.title | uppercase}}` filters). Phase 1 has no expression filters.
- Cross-component bindings ("bind this Text to that other Component's hover state"). Out of scope; Phase 2.
- Visual scope-debugging tooling (which scope frame am I in). Wave-3 polish.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/components/sidebars/right/BindingControl.tsx` | new | Renders the link / unlink icon next to a prop control. |
| `src/components/sidebars/right/BindingPicker.tsx` | new | The popover with the scope tree. |
| `src/components/sidebars/right/QueryBuilder.tsx` | new | Filter / sort / limit visual builder for data components. |
| `src/components/sidebars/right/sections/DataSourceSection.tsx` | new | Right-sidebar section shown when a data component is selected; hosts BindingControl for `collection` slot + QueryBuilder. |
| `src/components/sidebars/right/RightSidebar.tsx` (or equivalent property panel root) | edit | Wire BindingControl into existing prop sections via the registry's `bindableSlots`. |
| `src/lib/bindings/scopeIntrospection.ts` | new | Walks up the selected node's ancestry to determine which scope frames are available (Collection ancestor → row scope, RecordView ancestor → row scope, page-level always). |
| `src/components/sidebars/right/__tests__/BindingPicker.test.tsx` | new | Tests for picker selection, free-form input parsing, link/unlink. |
| `src/components/sidebars/right/__tests__/QueryBuilder.test.tsx` | new | Tests for adding / removing filter rows, sort changes. |

## API surface

```ts
// BindingControl
interface BindingControlProps {
  node: ComponentInstance;
  slot: string; // matches a key in registry.bindableSlots
  slotMeta: BindableSlotMeta;
  // The static control to render when unbound. Picker replaces it with a chip when bound.
  staticControl: React.ReactNode;
}

// BindingPicker
interface BindingPickerProps {
  node: ComponentInstance;
  slot: string;
  slotMeta: BindableSlotMeta;
  onCommit: (binding: ReadBinding) => void;  // calls node.setBinding under the hood
  onCancel: () => void;
}

// scopeIntrospection
export function getAvailableScopeFrames(
  node: ComponentInstance,
  page: PageModel,
): {
  page: { params: string[] }; // names of route params
  rowFrame?: { collectionId: string }; // present if any ancestor is Collection or RecordView
};
```

## Data shapes

```ts
// What the picker writes via node.setBinding
{
  mode: 'read',
  expression: '{{row.title}}',
  scope: 'parent',
}

// What QueryBuilder writes via node.props.query
{
  filter: [
    { column: 'published', op: 'eq', value: true },
  ],
  sort: [
    { column: 'published_at', direction: 'desc' },
  ],
  limit: 10,
}
```

> **MST-WRITE callout.** Both `node.setBinding(...)` and writing `props.query` are MST mutations on a ComponentModel node. Once the multiplayer track lands, these mutations MUST route through the Yjs binding-application path (this is the same Yjs canonical rule that applies to `addChild` / `removeChild` / `props` changes today). The picker UI itself doesn't need to change; the underlying MST action body becomes a Yjs-aware no-op + Yjs op when multiplayer ships.

## Test plan

- [ ] Unit: `getAvailableScopeFrames` for a node deep inside a Collection returns `{ rowFrame: { collectionId: 'col_posts' } }`.
- [ ] Unit: BindingPicker shows `Page > params.id` always, plus `Collection (Posts) > title, body, published_at` when ancestor is a Collection bound to `col_posts`.
- [ ] Unit: clicking a column in the picker calls `onCommit` with `{ mode: 'read', expression: '{{row.title}}' }`.
- [ ] Unit: typing a free-form expression `{{page.params.id}}` and pressing enter commits that binding.
- [ ] Unit: clicking unlink on a bound slot calls `node.clearBinding(slot)`.
- [ ] Unit: QueryBuilder add-filter writes a new filter entry; remove-filter removes it.
- [ ] Integration: select a Text inside a Collection, click the link icon next to the Text content control, pick `row > title`. Canvas re-renders with the row title. Repeat for unlink.
- [ ] Manual: drag a Collection onto a viewport, click its `Source > collection` binding control, pick `Posts`. Confirm 5 fixture rows render with no further wiring beyond the default child template.

## Definition of done

- [ ] Picker renders for every entry in `bindableSlots` of the selected component.
- [ ] Tests pass via `pnpm test`.
- [ ] No regressions in existing right-sidebar property tests.
- [ ] Visual: a customer can set up a Collection > Text-bound-to-row.title pattern entirely from the editor UI without dev tools.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- **Free-form expression input safety.** Customer types `{{rowx.title}}`: parser returns null. Show a red border and error tooltip. Confirm UX with design.
- **Cross-track contract: schema-evolution.** When CMS column is renamed, existing bindings reference the old column ID. The CMS plan flags schema-evolution UX as Phase 2 unowned. This picker SHOULD show a warning chip on broken bindings ("column not found") but doesn't auto-migrate. Confirm scope with `cms` track.
- **Picker ergonomics for nested scopes.** A Collection inside a Collection (rare but legal) creates a stacked row scope. Picker shows both with disambiguation (`Outer.row.x`, `row.x`). Confirm Marlin wants this in Phase 1 or defer.
- **Section primitives reuse.** The right sidebar is mid-rework into section-based primitives (per recent commits). Confirm with the right-sidebar maintainer that BindingControl and DataSourceSection plug into the new primitives cleanly. May need to coordinate with whoever owns `RightSidebar.tsx`.
- **Style sub-property bindings.** A customer wants to bind `style.backgroundColor` to `{{row.brandColor}}`. This spec only ships top-level prop slot bindings; style sub-property bindings are listed in registry-spec as wave-3 polish. Confirm.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Research question 5: editor binding UX 2.0 weeks; visual filter / sort / limit builder 1.5 weeks)
- Spec: `data-bindings-binding-shape-on-component-model` (consumed via `node.setBinding`)
- Spec: `data-bindings-component-registry-bindable-slots` (consumed via `getBindableSlotsFor`)
- Spec: `data-bindings-data-source-provider-interface` (consumed via `useDataSource().getCollection`)
- Code: existing right-sidebar property primitives (recent commits, section-based)
- Code: `src/stores/HistoryStore.ts` (binding mutations should land in undo history same as other MST writes)
