---
name: data-bindings-read-only-data-components
track: data-bindings
wave: 2
priority: P0
status: draft
depends_on: [data-bindings-component-registry-bindable-slots, data-bindings-data-source-provider-interface, data-bindings-read-binding-resolver-runtime]
estimated_value: 9
estimated_cost: 7
owner: unassigned
---

# Read-only data-bound components: Collection, RecordView, TableView

## Goal

Implement the three Phase 1 read-only data components registered in wave-1. `Collection` repeats a child template once per row of a bound collection. `RecordView` renders a single row resolved from page params. `TableView` wraps the existing data-table TableView component, hiding adapter wiring behind a `collectionId` prop. Each pushes the right `BindingFrame` into the scope so descendant bindings (`{{row.title}}` etc.) resolve correctly.

These three are the load-bearing data-display surface of the Phase 1 customer experience. Without them, the registry has placeholders and the resolver runtime has no callers.

## Scope

**In:**

- `Collection` runtime: reads its `collection` binding to resolve a collection ID, calls `useDataSource().listRows(collectionId, query)`, iterates rows, pushes a `row` frame for each iteration, renders its first child as a template repeated per row. Falls back to dashed placeholder if no binding.
- `RecordView` runtime: reads its `collection` binding plus a `rowId` source (page params or explicit prop), calls `useDataSource().getRow`, pushes a single `row` frame, renders children once.
- `TableView` runtime: thin wrapper that imports the data-table React TableView (already in suite per `@marlinjai/data-table-react`) and feeds it columns + rows from the resolved collection. Read-only mode (no edit). Falls back to dashed placeholder if no binding.
- Filter / sort / limit props on `Collection` and `TableView`. Stored as a structured `Query` object on `props.query` (NOT bound, NOT a template expression in Phase 1). The wave-2 editor binding picker spec adds the UI for editing this structure.
- Polling reactivity: each component subscribes to its query via `dataSource.subscribe`, re-fetches on change.
- Empty state: when query returns zero rows, render `props.emptyContent` (string or default "No items"). Custom empty content design deferred to wave-3 polish.
- Error state: caught fetch error renders a small inline error in the editor; preview mode renders nothing for the slot.
- Page-route integration: `RecordView` reads `{{page.params.id}}` (or whatever its `rowId` binding says) and reactively re-fetches when the param changes.

**Out (explicitly deferred):**

- Form, LoginForm, OwnerOnly, RelationField, FileField (Phase 2).
- BoardView and CalendarView (deferred per CMS plan, not in Phase 1 scope).
- Optimistic updates (Phase 2 + 2-3 weeks).
- Pagination UI controls (cursor handling exists in the provider, but UI to advance pages is wave-3 polish).
- Custom loading / empty / error component editing UX (wave-3 polish, this spec ships only sensible defaults).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/data/CollectionRenderer.tsx` | new | Renders a Collection node by iterating rows + pushing scope frames. |
| `src/lib/renderer/data/RecordViewRenderer.tsx` | new | Renders a RecordView node by resolving rowId. |
| `src/lib/renderer/data/TableViewRenderer.tsx` | new | Wraps `@marlinjai/data-table-react` TableView. |
| `src/lib/renderer/createComponentElement.tsx` | edit | Dispatch on `entry.dataComponentKind` to the three renderers above (replaces the wave-1 dashed-box placeholder). |
| `src/lib/bindings/dataSource/inMemoryProvider.ts` | edit | Add 5+ rows per fixture collection so list / table renders show realistic content during dev. |
| `src/lib/renderer/data/__tests__/CollectionRenderer.test.tsx` | new | Render Collection with 3-row fixture, assert child template renders 3 times with correct `{{row.title}}`. |
| `src/lib/renderer/data/__tests__/RecordViewRenderer.test.tsx` | new | Render RecordView with `page.params.id = 'r2'`, assert correct row resolved. |
| `src/lib/renderer/data/__tests__/TableViewRenderer.test.tsx` | new | Render TableView, assert columns and rows match fixture. |

## API surface

```ts
// CollectionRenderer.tsx
interface CollectionRendererProps {
  node: ComponentInstance;
  scope: BindingScope;
  // pass-through render context (breakpoint, etc.)
}
export const CollectionRenderer: React.FC<CollectionRendererProps>;

// Internally:
// 1. const dataSource = useDataSource();
// 2. const collectionBinding = node.getBinding('collection') as ReadBinding | undefined;
// 3. if no binding: render dashed placeholder
// 4. const collectionId = evaluateExpression(parseExpression(collectionBinding.expression), scope);
// 5. const [page, setPage] = useState<RowsPage | null>(null); useEffect: subscribe + listRows
// 6. const template = node.children[0]; // first child is the template
// 7. for each row: <ComponentRenderer component={template} scope={pushRowFrame(scope, { row, collection })} />

// Same shape for RecordView and TableView.
```

## Data shapes

```ts
// Collection node example with query
{
  id: 'cmp_collection_1',
  type: 'div',
  componentType: 'host',
  bindings: {
    collection: { mode: 'read', expression: '{{collection.posts}}' }, // or hardcoded ID
  },
  props: {
    query: {
      filter: [{ column: 'published', op: 'eq', value: true }],
      sort: [{ column: 'published_at', direction: 'desc' }],
      limit: 10,
    },
    emptyContent: 'No posts yet',
  },
  children: [/* one template child */],
}

// RecordView node example, route /posts/:id
{
  id: 'cmp_recordview_1',
  type: 'div',
  componentType: 'host',
  bindings: {
    collection: { mode: 'read', expression: '{{collection.posts}}' },
    rowId:      { mode: 'read', expression: '{{page.params.id}}' },
  },
  props: {},
  children: [/* normal subtree, can use {{row.title}} */],
}
```

## Test plan

- [ ] Unit: CollectionRenderer with no binding renders dashed placeholder.
- [ ] Unit: CollectionRenderer bound to `col_posts` with 3 fixture rows renders 3 instances of the template.
- [ ] Unit: A Text descendant inside Collection bound to `{{row.title}}` shows each row's title.
- [ ] Unit: Collection with a filter `{ published: true }` shows only matching rows.
- [ ] Unit: RecordView with `rowId = 'r2'` resolves to row r2 and exposes `{{row.*}}` fields to descendants.
- [ ] Unit: RecordView with a non-existent rowId renders the empty / error state.
- [ ] Unit: TableView renders a table with columns matching the fixture collection.
- [ ] Unit: subscribe callback re-renders Collection when in-memory provider mutates.
- [ ] Manual: drop a Collection on a viewport, set its `collection` binding via dev console (picker is separate spec), drop a Text inside, set its `children` binding to `{{row.title}}`. Confirm 3-5 fixture posts render.

## Definition of done

- [ ] All three components render against the in-memory provider without error.
- [ ] Tests pass via `pnpm test`.
- [ ] No regressions in non-data-component rendering.
- [ ] Static-HTML publish (when integrated by static-html track) can render these components at build time using the same resolver path. Coordination handoff documented.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- **TableView dependency on `@marlinjai/data-table-react`.** Confirm the package is installable in framer-clone's pnpm workspace and that its read-only mode doesn't pull in editor-only deps. If the package surface is too large, fall back to a hand-rolled table for Phase 1.
- **Filter / sort / limit editor UI.** Editor binding picker spec covers the binding side. The structured `Query` editor (visual filter builder per CMS plan, 1.5 weeks) is wave-2 effort, and could go in this spec or in the picker spec. Recommend slotting it into the picker spec (`data-bindings-editor-binding-picker`) so this spec stays focused on the renderer.
- **Pagination UI.** This spec ships data flow but no Next-page button in the editor. The picker exposes `limit`. Wave-3 adds a default Next-page button and "load more" UX.
- **Loading state UX.** Phase 1 just shows nothing while loading or a tiny "Loading..." text. Confirm with design that this is OK and skeleton-loading is wave-3+.
- **CMS API contract: column rename / delete.** If a customer renames a column on the CMS side, all `{{row.<old_id>}}` bindings either break (if cms keys by ID) or auto-rename (if cms keys by name + ID lookup). The CMS track owns this; this spec assumes column IDs are stable.

## References

- Plan: `docs/plans/2026-05-05-cms-data-layer-research.md` (Research question 5: Collection, RecordView, TableView are the read-side components)
- Spec: `data-bindings-component-registry-bindable-slots` (registers placeholders consumed here)
- Spec: `data-bindings-read-binding-resolver-runtime` (provides scope + applyBindings)
- Spec: `data-bindings-data-source-provider-interface` (provides useDataSource)
- Code: `src/lib/renderer/createComponentElement.tsx` (dispatch site)
- External: data-table package `projects/data-table/packages/react/`
