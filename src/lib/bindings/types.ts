/**
 * Canonical data-binding shape stored on every ComponentModel node.
 *
 * Phase 1 only USES the read-mode of this union. The `'write'` and
 * `'two-way'` discriminators are reserved so persisted snapshots emitted by a
 * future Phase 2 client (Form / LoginForm / write-bindings) survive a
 * round-trip through a Phase 1 client without throwing. Phase 1 readers
 * simply ignore non-`'read'` entries on render.
 *
 * See `docs/specs/wave-1/data-bindings-binding-shape-on-component-model.md`.
 */
export type BindingMode = 'read' | 'write' | 'two-way';

/**
 * Read-mode binding (Phase 1).
 *
 * `expression` is stored as an opaque template string. The parser lives in
 * the resolver runtime spec (`data-bindings-read-binding-resolver-runtime`);
 * Phase 1 syntax is Mustache-style: `{{collection.fieldName}}`,
 * `{{row.fieldName}}`, `{{page.params.id}}`.
 *
 * `scope` defaults to `'parent'`. `'page'` resolves against the page-level
 * scope frame (page params, route).
 */
export interface ReadBinding {
  mode: 'read';
  expression: string;
  scope?: 'page' | 'parent';
}

/**
 * Write-mode binding. Phase 2 placeholder. NOT implemented in Phase 1.
 *
 * The discriminator and minimal field set must be present in the type union
 * so persisted snapshots with `mode: 'write'` deserialise cleanly in a Phase
 * 1 client. Phase 2 will expand this with validation, default values, etc.
 */
export interface WriteBinding {
  mode: 'write';
  collectionId: string;
  field: string;
}

/**
 * Two-way binding. Phase 2 placeholder. NOT implemented in Phase 1.
 *
 * Reserved so a snapshot emitted by Phase 2 round-trips through a Phase 1
 * client.
 */
export interface TwoWayBinding {
  mode: 'two-way';
  collectionId: string;
  field: string;
}

export type BindingEntry = ReadBinding | WriteBinding | TwoWayBinding;

/**
 * Map of binding-slot name to a single binding entry.
 *
 * Slot keys follow the intrinsic-prop name convention (`children`, `src`,
 * `href`, `visible`). For style sub-properties, dot-path keys are used
 * (`style.color`). The exact slot vocabulary per component is owned by the
 * componentRegistry binding-slot spec.
 */
export type BindingsRecord = Record<string, BindingEntry>;
