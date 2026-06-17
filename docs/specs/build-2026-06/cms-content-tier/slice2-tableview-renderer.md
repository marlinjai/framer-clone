---
name: slice2-tableview-renderer
track: cms-content-tier
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-read-only-data-components]
touchesSharedState: true
sharedState: [lockfile]
estimateDays: 2
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# TableView renderer: read-only @marlinjai/data-table-react wrap (with hand-rolled fallback)

> SPLIT from `slice2-read-only-data-components` per the critique (the data-table-react wrap is independently testable and carries its own dep/fallback risk). `@marlinjai/data-table-react@0.3.1` IS published correctly (`@marlinjai/data-table-core: "*"`, React 18/19 peer) and DOES install (verified against the live npm registry) so this dep is NOT subject to the adapter-prisma `workspace:*` blocker. The only data-table dep here is `data-table-react`.

## Goal

`TableViewRenderer` wraps `@marlinjai/data-table-react` TableView in READ-ONLY mode, fed columns+rows from the resolved collection, dispatched via the `tableView` `dataComponentKind` branch reserved in `slice2-read-only-data-components`.

## Scope

**In:**
- Add dep `@marlinjai/data-table-react@^0.3.1` (clean on npm; `lockfile` shared-state).
- `src/lib/renderer/data/TableViewRenderer.tsx`: wraps `@marlinjai/data-table-react` TableView read-only, fed columns+rows from the resolved collection via `useDataSource()`, scope threaded.
- Wire the `tableView` dispatch branch in `createComponentElement.tsx` (reserved in the core spec) to this renderer.
- Routes through the `resolveDataState` helper if it has landed; otherwise a minimal inline state.

**Out (explicitly deferred):**
- Write/edit-in-table (read-only only).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `package.json` | edit | add `@marlinjai/data-table-react@^0.3.1`; `lockfile` shared-state |
| `src/lib/renderer/data/TableViewRenderer.tsx` | new | wraps data-table-react read-only |
| `src/lib/renderer/createComponentElement.tsx` | edit | wire the reserved `tableView` dispatch branch |
| `src/lib/renderer/data/__tests__/TableViewRenderer.test.tsx` | new | columns+rows match the collection |

## API surface

```ts
function TableViewRenderer(props: { node, scope }): ReactNode;
```

## Test plan

- [ ] TableViewRenderer renders columns+rows matching the resolved collection.
- [ ] `subscribe` re-renders on store mutation.
- [ ] `@marlinjai/data-table-react` installs cleanly (read-only mode pulls no editor-only deps; if it does, fall back to a hand-rolled read-only table and flag).
- [ ] The `tableView` dispatch branch routes to this renderer (no longer the placeholder for bound nodes).

## Definition of done

- [ ] `@marlinjai/data-table-react@^0.3.1` installs cleanly (verified clean on npm).
- [ ] TableViewRenderer renders the resolved collection read-only; subscribe re-renders.
- [ ] If read-only mode pulls editor-only deps into the bundle, the hand-rolled fallback ships and is flagged to Marlin.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- If `@marlinjai/data-table-react` read-only mode pulls editor-only deps into the published bundle, fall back to a hand-rolled read-only table and flag to Marlin.

## References

- Code touchpoints: `createComponentElement.tsx` (the reserved tableView branch), `componentRegistry.ts` (tableView entry), `useDataSource()`
- Depends on: `slice2-read-only-data-components` (the dispatch + scope threading)
