---
name: data-bindings-binding-shape-on-component-model
track: data-bindings
wave: 1
priority: P0
status: draft
depends_on: []
estimated_value: 9
estimated_cost: 4
owner: unassigned
---

# Binding shape on ComponentModel

## Goal

Establish the canonical data-binding shape stored on every ComponentModel node. This is the load-bearing schema decision for the data-bindings track: get it wrong now and Phase 2 (Form, LoginForm, write-bindings) needs a registry-format breaking change. Phase 1 only USES the read-mode of this shape, but the schema must reserve write-mode slots so adding them later is a non-breaking extension. Ref strategic thesis: "componentRegistry.ts should evolve toward data-bound components (form, list, table view, auth gate) before scaling layout primitives."

## Scope

**In:**

- New optional `bindings` field on `ComponentBase` in `src/models/ComponentModel.ts`, holding a frozen `BindingsRecord` map keyed by binding slot name (e.g. `collection`, `row`, `text`, `src`, `href`, `visible`).
- Discriminated union per binding entry: `{ mode: 'read', expression: string, scope?: 'page' | 'parent' }` for Phase 1, with the mode field reserved for `'write'` and `'two-way'` in Phase 2 (NOT implemented, but the type union must allow them so the persisted snapshot survives a Phase 2 upgrade).
- MST actions `setBinding(slot, binding)`, `clearBinding(slot)`, `clearAllBindings()`. All MST-WRITE.
- View `getBinding(slot)` and `hasBindings` boolean.
- Snapshot migration: existing `props` snapshots without a `bindings` field load as `bindings: {}` (no migration needed; field is optional).
- Pre-MVP rule applies: no backwards compatibility shim for snapshots in flight, persisted store will rewrite on next save.

**Out (explicitly deferred):**

- Write-mode and two-way-mode evaluation (Phase 2).
- Template expression evaluation runtime (deferred to wave-2 spec `data-bindings-read-binding-resolver-runtime`).
- Editor UI for declaring bindings (deferred to wave-2 spec `data-bindings-editor-binding-picker`).
- Yjs routing of binding mutations (deferred until multiplayer track lands; this spec writes directly to MST as the canvas tree does today).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/models/ComponentModel.ts` | edit | Add `bindings` frozen field, type union, MST actions, views. |
| `src/models/__tests__/ComponentModel.bindings.test.ts` | new | Unit tests for setBinding/clearBinding/getBinding and snapshot round-trip. |
| `src/lib/bindings/types.ts` | new | Exported types: `BindingMode`, `BindingEntry`, `BindingsRecord`. Used by registry, resolver, picker. |

## API surface

```ts
// src/lib/bindings/types.ts
export type BindingMode = 'read' | 'write' | 'two-way';

export interface ReadBinding {
  mode: 'read';
  // Template expression. Phase 1 syntax: `{{collection.fieldName}}`,
  // `{{row.fieldName}}`, `{{page.params.id}}`. Parsed by the resolver
  // runtime. Stored as a raw string here so the editor and serializer don't
  // need the parser.
  expression: string;
  // Which scope frame this binding resolves against. Default 'parent'.
  // 'page' resolves against the page-level scope (page params, route).
  scope?: 'page' | 'parent';
}

// Phase 2 placeholder, NOT implemented in Phase 1. The discriminator MUST
// be present in the type so persisted snapshots with mode='write' don't
// blow up a Phase 1 client. Phase 1 readers ignore non-'read' entries.
export interface WriteBinding {
  mode: 'write';
  collectionId: string; // resolved at edit time
  field: string;        // column name on collection
  // Phase 2 expansion: validation, default values, etc.
}

export interface TwoWayBinding {
  mode: 'two-way';
  collectionId: string;
  field: string;
}

export type BindingEntry = ReadBinding | WriteBinding | TwoWayBinding;

export type BindingsRecord = Record<string, BindingEntry>;

// src/models/ComponentModel.ts (additions)
// ComponentBase gains:
//   bindings: types.optional(types.frozen<BindingsRecord>(), {})
// ComponentModel gains actions:
//   setBinding(slot: string, binding: BindingEntry): void
//   clearBinding(slot: string): void
//   clearAllBindings(): void
// ComponentModel gains views:
//   getBinding(slot: string): BindingEntry | undefined
//   get hasBindings(): boolean
//   get readBindings(): Record<string, ReadBinding>  // filters mode==='read'
```

## Data shapes

```ts
// Persisted MST snapshot example for a Text node bound to a row field
{
  id: 'cmp_abc',
  type: 'p',
  componentType: 'host',
  props: { style: { fontSize: '16px' } },
  bindings: {
    children: { mode: 'read', expression: '{{row.title}}', scope: 'parent' },
  },
  children: [],
}

// Future Phase 2 example (NOT created in Phase 1, but the schema accepts it)
{
  id: 'cmp_xyz',
  type: 'input',
  componentType: 'host',
  props: { ... },
  bindings: {
    value: { mode: 'two-way', collectionId: 'app_users', field: 'email' },
  },
}
```

> **MST-WRITE callout.** This spec adds three MST mutations (`setBinding`, `clearBinding`, `clearAllBindings`) on `ComponentModel`. They are direct MST writes today. Once the multiplayer track lands and Yjs becomes canonical for canvas mutations, these mutations MUST route through the Yjs binding-application path the multiplayer track defines (the `bindings` field is canvas tree data, same as `props`). Coordinate with the multiplayer track's MST-projection design before merging this spec into `done`. See cross-track dependency below.

## Test plan

- [ ] Unit: `setBinding('children', { mode: 'read', expression: '{{row.title}}' })` then `getBinding('children')` returns the entry.
- [ ] Unit: `clearBinding` removes the slot.
- [ ] Unit: `hasBindings` toggles correctly across set + clear cycles.
- [ ] Unit: snapshot round-trip preserves `bindings` exactly (`getSnapshot` then `applySnapshot` to a new tree, deep-equal).
- [ ] Unit: an existing snapshot WITHOUT a `bindings` field loads cleanly with `bindings: {}` (forward-compat from pre-bindings tree).
- [ ] Unit: a snapshot containing a `mode: 'write'` entry loads without throwing in a Phase 1 client (Phase 1 just ignores it on render).
- [ ] Unit: `readBindings` view filters to only `mode === 'read'` entries.

## Definition of done

- [ ] Code lands and typechecks.
- [ ] All unit tests pass via `pnpm test`.
- [ ] No regressions in existing ComponentModel snapshot tests.
- [ ] `src/lib/bindings/types.ts` exports the union type and is consumed by at least the unit test file (full consumption lands in wave-2 specs).
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- **CMS API contract for collection / row identifiers.** This spec stores `collectionId: string` and `field: string` on Phase 2 binding shapes. Confirm with the `cms` track that:
  - Collection identifiers are stable string IDs (UUID or slug), not numeric.
  - Field/column identifiers are stable string slugs scoped per-collection (the `cms` track owns whether renaming a column is allowed and how it propagates).
  - Page route params surface as a `page.params` scope. Confirm with the static-html publish track that `page.params.<name>` is a documented scope.
- **Expression syntax commitment.** This spec stores `expression` as an opaque string and defers parsing to the resolver. The expression syntax decision is locked in by the resolver spec (`data-bindings-read-binding-resolver-runtime`). Two viable choices: Mustache-style `{{path.to.value}}` (chosen as default here) vs full JS-expression evaluator (Plasmic-style). Marlin to confirm Mustache-style for Phase 1 to keep the surface small.
- **Yjs mutation path.** Once multiplayer ships, do `setBinding` / `clearBinding` route through the same Yjs binding-application path as `addChild` / `removeChild`? Multiplayer track owns the answer; this spec assumes yes, and the migration is a swap of the MST action body.
- **Slot naming convention.** Suggested: bindings keyed by intrinsic-prop name (`children`, `src`, `href`, `style.color`). For style sub-properties, use dot-path keys. Confirm with the editor binding-picker spec that this matches the picker UX.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Revision F decision 5: "Component registry shape allows write-bindings")
- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Research question 5: data-binding layer breakdown)
- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (Yjs canonical, MST as projection)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` (componentRegistry should evolve toward data-bound components)
- Memory: `memory/feedback_pre_mvp_no_backcompat.md` (no migration shims pre-launch)
- Code: `src/models/ComponentModel.ts` (target file)
- Code: `src/lib/componentRegistry.ts` (consumer of binding-slot metadata, see `data-bindings-component-registry-bindable-slots`)
