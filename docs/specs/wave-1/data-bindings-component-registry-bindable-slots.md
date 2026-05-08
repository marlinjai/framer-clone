---
name: data-bindings-component-registry-bindable-slots
track: data-bindings
wave: 1
priority: P0
status: draft
depends_on: [data-bindings-binding-shape-on-component-model]
estimated_value: 8
estimated_cost: 3
owner: unassigned
---

# Component registry: bindable-slot metadata and data-component placeholders

## Goal

Extend `COMPONENT_REGISTRY` to declare per-component which prop slots are bindable and in what mode (read in Phase 1, write reserved for Phase 2). Add the registry entries for the three Phase 1 read-only data components (`Collection`, `RecordView`, `TableView`) as placeholders so they appear in the ComponentsPanel and can be dropped on the canvas. Their actual rendering is implemented in wave-2; this spec is the registry-shape side of the seam.

This spec is the SECOND of the two Phase 1 must-design-not-build seams from the CMS plan: registry shape allows read AND write bindings on the same primitive (Revision F decision 5).

## Scope

**In:**

- New optional fields on `ComponentRegistryEntry`:
  - `bindableSlots?: Record<string, BindableSlotMeta>` describing which prop paths can be bound, with allowed modes per slot.
  - `category` extended to include `'data'`.
  - `dataComponentKind?: 'collection' | 'record-view' | 'table-view'` for the Phase 1 data components (lets the renderer dispatch to the right wave-2 handler).
- Register three new placeholder entries: `collection`, `recordView`, `tableView`. Each entry:
  - Sets `category: 'data'` and a unique `dataComponentKind`.
  - Declares its bindable slots (`collection` for the data source, `filter`/`sort`/`limit` as transient props, `row` scope for child template).
  - Renders as a visible "Data: Collection (no binding)" placeholder in the editor when no binding is attached. Empty/unbound rendering is handled by a wave-2 renderer; this spec ships only the registry entry plus a stub createComponentElement branch that returns the placeholder dashed-box.
- Categorize for ComponentsPanel: a new `'data'` group surfaces the three entries.
- Helper `getBindableSlotsFor(componentTypeId)` for the editor binding-picker (wave-2 spec).
- Phase 2 reservation: `bindableSlots` map MUST allow declaring slots whose `allowedModes` include `'write'` even though no Phase 1 component declares them. Schema must accept and persist write-mode declarations now so the picker UI can grow into Phase 2 without a registry breaking change.

**Out (explicitly deferred):**

- Actual data-fetching, scope-propagation, and template-resolution wiring for the three new components (deferred to wave-2 spec `data-bindings-read-only-data-components`).
- Form, LoginForm, OwnerOnly, RelationField (Phase 2).
- Editor binding picker UI (deferred to wave-2 spec `data-bindings-editor-binding-picker`).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/componentRegistry.ts` | edit | Add `bindableSlots`, `dataComponentKind`, extend `ComponentCategory` with `'data'`, register the three placeholders. |
| `src/lib/bindings/types.ts` | edit | Add `BindableSlotMeta` type. |
| `src/lib/renderer/createComponentElement.tsx` | edit | Recognize `dataComponentKind` and render a dashed-box placeholder when no binding is attached. Wave-2 swaps this for the real renderer. |
| `src/components/sidebars/left/ComponentsPanel.tsx` | edit | Add a `'Data'` category section that lists the three new entries. |
| `src/lib/__tests__/componentRegistry.bindings.test.ts` | new | Test that `getBindableSlotsFor('text')` returns the expected slots, and that the three data components are present with their `dataComponentKind`. |

## API surface

```ts
// src/lib/bindings/types.ts (additions)
export interface BindableSlotMeta {
  // The display label for the binding picker. e.g. 'Text', 'Image source'.
  label: string;
  // Which modes this slot accepts. Phase 1: most slots are ['read'] only.
  // Phase 2 will add 'write' / 'two-way' for Form-field components.
  allowedModes: BindingMode[];
  // The expected scope context the slot should resolve in. Used by the
  // picker to filter what fields/collections show up.
  scopeHint?: 'row' | 'collection' | 'page' | 'any';
  // For write-mode slots in Phase 2: the column-type compatibility filter.
  // Phase 1 ignores this field. Reserved here so Phase 2 doesn't need a
  // registry breaking change.
  columnTypeFilter?: string[];
}

// src/lib/componentRegistry.ts (additions to ComponentRegistryEntry)
export type ComponentCategory = 'basic' | 'layout' | 'data';

export interface ComponentRegistryEntry {
  // ...existing fields...
  bindableSlots?: Record<string, BindableSlotMeta>;
  dataComponentKind?: 'collection' | 'record-view' | 'table-view';
}

export function getBindableSlotsFor(
  componentTypeId: string
): Record<string, BindableSlotMeta>;
```

## Data shapes

```ts
// Example new registry entries
{
  collection: {
    id: 'collection',
    label: 'Collection',
    category: 'data',
    dataComponentKind: 'collection',
    icon: ListIcon, // lucide-react
    iconClassName: 'bg-emerald-100 text-emerald-600',
    htmlType: 'div',
    defaultProps: {
      style: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', minHeight: '120px', border: '1px dashed #d1d5db', borderRadius: '8px' },
    },
    defaultSize: { width: 360, height: 240 },
    bindableSlots: {
      collection: {
        label: 'Source collection',
        allowedModes: ['read'],
        scopeHint: 'collection',
      },
      // Phase 1 children inside the Collection get a `row` scope auto-injected
      // by the wave-2 renderer; not declared as a bindable slot here.
    },
  },

  // Existing entries gain bindableSlots. Examples:
  text: {
    // ...existing...
    bindableSlots: {
      children: { label: 'Text', allowedModes: ['read'], scopeHint: 'any' },
    },
  },
  image: {
    // ...existing...
    bindableSlots: {
      src: { label: 'Image source', allowedModes: ['read'], scopeHint: 'any' },
      alt: { label: 'Alt text', allowedModes: ['read'], scopeHint: 'any' },
    },
  },
}
```

## Test plan

- [ ] Unit: `getBindableSlotsFor('text')` returns `{ children: { label: 'Text', allowedModes: ['read'], scopeHint: 'any' } }`.
- [ ] Unit: `getBindableSlotsFor('collection')` returns the `collection` slot with `allowedModes: ['read']`.
- [ ] Unit: `COMPONENT_REGISTRY.collection.dataComponentKind === 'collection'`.
- [ ] Unit: A registry entry whose `bindableSlots` contains `allowedModes: ['write']` is accepted by the type system (compile-time test via `tsc --noEmit` covered by build).
- [ ] Unit: `listComponentsByCategory('data')` returns exactly the three new entries.
- [ ] Manual: open editor, ComponentsPanel shows a "Data" section with three items. Drag `Collection` onto a viewport: a dashed placeholder labeled "Collection (no binding)" appears.

## Definition of done

- [ ] Code lands and typechecks.
- [ ] Tests pass via `pnpm test`.
- [ ] No regressions in existing drag/drop tests (the new entries follow the same drag contract).
- [ ] ComponentsPanel renders the new Data category.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- **Data-component default sizes and visuals.** The placeholder design is intentionally minimal here. Marlin / design-pass to decide if Phase 1 ships polished empty-state visuals for unbound data components or if it stays dashed-box-with-label.
- **Naming.** `Collection` follows the CMS-plan naming. Bubble calls these "Repeating Group". Confirm `Collection` is the customer-facing label.
- **Slot keys for nested style props.** Image's `style.objectFit` could also be bindable. Phase 1 only declares the top-level slots that ship in the wave-2 picker. Defer style-sub-property bindings to wave-3 polish.
- **Registry entry for `Container` should it expose any bindable slots?** Probably `style.backgroundImage` for hero images, but defer until the picker UX is real (wave-2). Add to a wave-3 polish spec if customers ask.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Revision F #5; Research question 5 component table)
- Spec: `data-bindings-binding-shape-on-component-model` (depends on)
- Code: `src/lib/componentRegistry.ts` (target)
- Code: `src/components/sidebars/left/ComponentsPanel.tsx` (consumer)
