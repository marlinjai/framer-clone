---
name: data-bindings-read-binding-resolver-runtime
track: data-bindings
wave: 2
priority: P0
status: draft
depends_on: [data-bindings-binding-shape-on-component-model, data-bindings-data-source-provider-interface]
estimated_value: 9
estimated_cost: 7
owner: unassigned
---

# Read-binding resolver runtime

## Goal

Implement the runtime that takes a ComponentModel node's `bindings` map, resolves each `read` entry's expression against the active scope chain (page params, parent collection rows, parent record), and applies the resolved value to the rendered prop. Without this spec, the wave-1 binding shape is just data sitting in the tree; this spec makes it actually drive what the user sees.

This is the "expression / template language + editor binding UX runtime piece" line item from the CMS plan's data-binding breakdown (~2 weeks of the ~12-13 week total). Phase 1 ships the read side only.

## Scope

**In:**

- Expression parser: Mustache-style `{{path.to.value}}` syntax. Single-segment: `{{title}}` (resolves against innermost scope). Multi-segment: `{{row.title}}`, `{{collection.name}}`, `{{page.params.id}}`. No JS expressions, no method calls, no filters in Phase 1.
- Scope chain runtime: a `BindingScope` object passed down through the renderer that holds:
  - `page`: page-level values (route, params, current url).
  - Stacked frames pushed by data-bound parents: `Collection` pushes a `row` frame for each iteration, `RecordView` pushes a single `row` frame.
- `resolveBinding(binding: ReadBinding, scope: BindingScope): unknown` pure function. Returns `undefined` on miss; never throws on unknown paths.
- Integration in `ComponentRenderer`: before computing `finalProps`, walk `component.bindings`, resolve each `read` slot, write the resolved value into the corresponding prop slot (overrides static props). For `children` slot whose target is a string content node, set the text content. For `style.X` dot-path slots, write into the style sub-object.
- Loading and error states: while a `Collection` or `RecordView` is fetching (returns Promise), the binding resolves to a sentinel `LOADING` value. The renderer displays the user-configured loading content (defaults to "Loading...") if present, else renders nothing for that slot.
- Memoization: `resolveBinding` results memoize per (binding, scope-snapshot) for the duration of a render pass to avoid redundant string parsing.

**Out (explicitly deferred):**

- Write-mode binding application (Phase 2).
- JS expression evaluator (deferred; if Phase 2 wants it, swap the parser).
- Filter / sort / limit declared via expression syntax (these stay as structured `Query` objects on the data component's props in Phase 2).
- Loading / error state CUSTOMIZATION UI (basic defaults only in Phase 1; polish to wave-3).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/bindings/resolver/expression.ts` | new | Parse + evaluate `{{path.segments}}`. Pure, tested in isolation. |
| `src/lib/bindings/resolver/scope.ts` | new | `BindingScope` type + helpers `pushRowFrame`, `pushCollectionFrame`, `lookup(path: string[])`. |
| `src/lib/bindings/resolver/applyBindings.ts` | new | `applyBindings(node, props, scope, dataSource): { resolvedProps, isLoading }`. Walks `node.bindings`. |
| `src/components/ComponentRenderer.tsx` | edit | Receive `scope` prop, call `applyBindings` to merge resolved values into `finalProps`. Pass scope to children. |
| `src/components/ResponsivePageRenderer.tsx` | edit | Construct the root `BindingScope` with page params from the current URL / page model. Pass to `ComponentRenderer`. |
| `src/lib/renderer/HeadlessComponentRenderer.tsx` | edit | Mirror `ComponentRenderer` for the headless path used by preview / static publish. |
| `src/lib/bindings/resolver/__tests__/expression.test.ts` | new | Parser tests. |
| `src/lib/bindings/resolver/__tests__/applyBindings.test.ts` | new | End-to-end resolver tests with fixture scope. |

## API surface

```ts
// src/lib/bindings/resolver/scope.ts
export interface BindingScope {
  page: { params: Record<string, string>; pathname: string };
  frames: BindingFrame[]; // innermost last
}

export type BindingFrame =
  | { kind: 'collection'; collectionId: string; collection?: Collection }
  | { kind: 'row'; row: Row; collection?: Collection };

export function pushRowFrame(scope: BindingScope, frame: { row: Row; collection?: Collection }): BindingScope;
export function pushCollectionFrame(scope: BindingScope, frame: { collectionId: string; collection?: Collection }): BindingScope;
export function lookup(scope: BindingScope, path: string[]): unknown;

// src/lib/bindings/resolver/expression.ts
export interface ParsedExpression {
  // Single-segment: { type: 'identifier', segments: ['title'] }
  // Multi-segment: { type: 'path', segments: ['row', 'title'] }
  segments: string[];
  raw: string;
}
export function parseExpression(input: string): ParsedExpression | null;
export function evaluateExpression(expr: ParsedExpression, scope: BindingScope): unknown;

// src/lib/bindings/resolver/applyBindings.ts
export interface BindingApplyResult {
  resolvedProps: PropsRecord;
  isLoading: boolean;
}

export const LOADING_SENTINEL: unique symbol;

export function applyBindings(
  node: ComponentInstance,
  baseProps: PropsRecord,
  scope: BindingScope,
): BindingApplyResult;
```

## Data shapes

```ts
// Example: a Collection rendering Posts, with a child Text bound to {{row.title}}
//
// Tree:
//   Collection (bindings: { collection: { mode: 'read', expression: '{{collection.posts}}' } })
//   └─ Container
//      └─ Text (bindings: { children: { mode: 'read', expression: '{{row.title}}' } })
//
// At render time:
// 1. Page-level scope: { page: { params: {}, pathname: '/blog' }, frames: [] }
// 2. Collection resolves its `collection` binding -> 'col_posts' (id), fetches via dataSource
// 3. For each row, push a row frame: scope' = { ..., frames: [{ kind: 'row', row, collection }] }
// 4. Text under that frame resolves `{{row.title}}` -> row.values.title -> "Hello world"
// 5. Text's `children` prop becomes "Hello world"
```

## Test plan

- [ ] Unit: parser accepts `{{title}}`, `{{row.title}}`, `{{page.params.id}}`. Rejects `{{a + b}}` (returns null).
- [ ] Unit: `lookup({ page: { params: { id: '42' } }, frames: [] }, ['page', 'params', 'id'])` returns `'42'`.
- [ ] Unit: single-segment `title` looks up against innermost frame's row.
- [ ] Unit: missing path returns `undefined`, not throw.
- [ ] Unit: `applyBindings` merges resolved value into `props.children` for a Text node.
- [ ] Unit: `applyBindings` returns `isLoading: true` if any binding resolves to `LOADING_SENTINEL`.
- [ ] Integration: render a tree (Collection > Text bound to `{{row.title}}`) against `InMemoryDataSourceProvider` with 3 rows; assert 3 Text nodes with the expected titles.
- [ ] Integration: HeadlessComponentRenderer produces the same output as ComponentRenderer for the same bound tree.
- [ ] Manual: in editor, manually set a Text node's `bindings.children = { mode: 'read', expression: '{{row.title}}' }` via devtools / store action (the picker UI is a separate spec); confirm it renders the row title from the in-memory fixture.

## Definition of done

- [ ] Code lands and typechecks.
- [ ] All unit and integration tests pass.
- [ ] No regressions in existing renderer tests (existing Text / Image / Container snapshots still pass when `bindings` is empty).
- [ ] HeadlessComponentRenderer behaves identically for bound trees.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- **Single-segment lookup precedence.** When `{{title}}` is used inside a `row` frame: should it auto-resolve to `row.title`? This spec says yes (innermost frame's row first, then collection, then page). Confirm with editor binding-picker spec that the picker generates fully-qualified paths so users don't accidentally hit ambiguity.
- **CMS API contract dependency.** Resolver assumes `Row.values` is keyed by `Column.id` (stable slug). If the `cms` track keys by display name, the resolver expressions break on rename. Confirm with `cms` track.
- **Static HTML publish.** Static publish needs to evaluate bindings at build time against fully-fetched data. The resolver must work in Node without React hooks. Confirm scope/resolver split lives in `src/lib/bindings/resolver/*` (no React imports there).
- **Yjs canonical mutation path.** The resolver itself is read-only and doesn't write to MST. But when wave-3 polish adds "click row to open detail", that's a `selectComponent`-shaped call that's already MST. Once multiplayer ships, NO new write paths land here without going through the multiplayer track's Yjs binding-application.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Research question 5 breakdown: template language 2.0 weeks, editor binding UX 2.0 weeks; this spec is the runtime side of the first row)
- Spec: `data-bindings-binding-shape-on-component-model` (defines `ReadBinding`, consumed here)
- Spec: `data-bindings-data-source-provider-interface` (defines `useDataSource()` and `Row` shape)
- Code: `src/components/ComponentRenderer.tsx` (target)
- Code: `src/lib/renderer/HeadlessComponentRenderer.tsx` (mirror target)
