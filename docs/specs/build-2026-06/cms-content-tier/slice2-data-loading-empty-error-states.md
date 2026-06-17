---
name: slice2-data-loading-empty-error-states
track: cms-content-tier
wave: 2
priority: P1
status: done
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [slice2-read-only-data-components]
touchesSharedState: false
sharedState: []
estimateDays: 2
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Loading / empty / error states for data-bound components

> Stands as scoped; no doc-tier-core coupling. A small shared pure helper `resolveDataState` mapping a fetch state to a render directive, used by all data renderers (CMS + later commerce) so the "errors surface, never swallow" contract is verified once. Distinguishes editor vs preview/headless mode.

## Goal

A pure `resolveDataState({isLoading, rows, error, mode})` mapping to a directive (`loading|empty|error|content`), used by CollectionRenderer/RecordViewRenderer/TableViewRenderer (and the Track C storefront renderers) so the loading/empty/error contract is verified once. LOADING -> `props.loadingContent` or a minimal `Loading...`; EMPTY -> `props.emptyContent` or `No items`/`Not found`; ERROR -> in editor an inline error chip with the real message, in preview/headless render nothing for the slot (no broken layout, no thrown render during SSR/static emit).

## Scope

**In:**
- `src/lib/renderer/data/resolveDataState.ts`: the pure helper.
- Wire all three CMS renderers through it.

**Out (explicitly deferred):**
- Pagination (wave-3 `data-bindings-states-pagination-and-polish`).
- Write-binding states.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/data/resolveDataState.ts` | new | pure directive helper |
| `src/lib/renderer/data/__tests__/resolveDataState.test.ts` | new | all four directives, both modes |
| `src/lib/renderer/data/CollectionRenderer.tsx` | edit | route through resolveDataState |
| `src/lib/renderer/data/RecordViewRenderer.tsx` | edit | route through resolveDataState |
| `src/lib/renderer/data/TableViewRenderer.tsx` | edit | route through resolveDataState |

## API surface

```ts
export function resolveDataState(input: {
  isLoading: boolean;
  rows: Row[] | null;
  error: Error | null;
  mode: 'editor' | 'preview';
}): { kind: 'loading' | 'empty' | 'error' | 'content'; message?: string };
```

## Test plan

- [ ] `resolveDataState` is pure and unit-tested across all four directives in both modes.
- [ ] Editor mode shows an inline error chip with the real message on a forced fetch error.
- [ ] Preview/headless renders nothing for the errored slot and does NOT throw during SSR/static emit.
- [ ] Empty/loading defaults render the configured or fallback content.
- [ ] All three renderers route through it; no regression to happy-path renders.

## Definition of done

- [ ] `resolveDataState` pure + unit-tested (four directives, both modes).
- [ ] Editor error chip carries the real message; preview/headless renders nothing and never throws.
- [ ] All three renderers route through it.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Code touchpoints: the three CMS data renderers (`slice2-read-only-data-components`), `HeadlessComponentRenderer.tsx`
- Depends on: `slice2-read-only-data-components`
