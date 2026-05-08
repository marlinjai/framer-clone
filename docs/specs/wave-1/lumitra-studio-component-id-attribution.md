---
name: lumitra-studio-component-id-attribution
track: lumitra-studio
wave: 1
priority: P0
status: draft
depends_on: []
estimated_value: 9
estimated_cost: 3
owner: unassigned
---

# Headless renderer emits stable component IDs to published DOM

## Goal

Make `data-component-id` and `data-component-type` (plus `data-inner-component-id` where applicable) survive into the published DOM by attaching them inside `HeadlessComponentRenderer.tsx`, not only in the editor renderer. This is the single must-fix bug called out in the renderer plan and the strategic thesis: today the headless path emits no IDs, so a published Framer-clone site has nothing for Lumitra Studio to fingerprint clicks against. Fixing it now unblocks every later Lumitra Studio integration spec (Phase A snippet injection, Phase B heatmap overlay, Phase C variants-as-alternatives) and is a precondition for the whole track.

## Scope

**In:**
- Attach `data-component-id`, `data-component-type`, and `data-inner-component-id` (when the component renders an inner editable region) on the root element emitted by `HeadlessComponentRenderer.tsx`.
- Attach the same attributes on the inner editable element where applicable (currently text components), mirroring the editor renderer behavior.
- Update `createComponentElement.tsx` if needed so HOST and FUNCTION dispatches both surface the attributes.
- Unit tests asserting attributes are present in headless render output across both HOST and FUNCTION components.
- Snapshot test pinning the attribute names (so analytics-platform side can rely on the contract).

**Out (explicitly deferred):**
- Lumitra snippet injection (separate spec: `lumitra-studio-snippet-injection`).
- DOM fingerprint feature emission like `data-lumitra-component`, `data-lumitra-id` (deferred to Wave 2 spec, which decides naming alignment with analytics-platform Pillar 3).
- Floating element coordinate attribution (out of scope for this spec; floating elements are not on the published site critical path).
- Editor-side changes (already shipping `data-component-id`).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/HeadlessComponentRenderer.tsx` | edit | Add `data-component-id`, `data-component-type` to `finalProps` before dispatch |
| `src/lib/renderer/createComponentElement.tsx` | edit | Ensure attributes pass through HOST and FUNCTION paths uniformly |
| `src/lib/renderer/__tests__/HeadlessComponentRenderer.test.tsx` | new | Unit tests asserting attribute emission |
| `src/lib/renderer/__tests__/headless-attributes.snapshot.test.tsx` | new | Snapshot pinning the contract |

## API surface

```ts
// No new exports. Behavioral change inside HeadlessComponentRenderer.

// The published DOM now carries (per emitted element):
//   data-component-id="<MST node id>"
//   data-component-type="<HOST tag or FUNCTION component name>"
//   data-inner-component-id="<MST node id>"   // on the inner editable node, when applicable
```

## Data shapes

```ts
// Contract for downstream Lumitra Studio consumers (analytics-platform tracker)
interface PublishedDomAttributionContract {
  // Attached on every rendered MST node's root DOM element in the published site.
  'data-component-id': string;        // stable across rebuilds, same id used in editor MST tree
  'data-component-type': string;      // e.g. "div", "Button", "Text"
  'data-inner-component-id'?: string; // present when the component has an inner editable region
}
```

## Test plan

- [ ] Unit: render a `Text` component via `HeadlessComponentRenderer`, assert root has `data-component-id`, `data-component-type="Text"`, and inner span has `data-inner-component-id`.
- [ ] Unit: render a `Container` (HOST `div`) and a `Button` (FUNCTION) at the same level, assert both carry the attributes.
- [ ] Unit: render a tree 3 levels deep, assert every level carries its node id (not collapsed to root).
- [ ] Snapshot: top-level page render fixtures pinned to current attribute names.
- [ ] Manual: load `/preview` for a sample project, inspect DOM in DevTools, confirm `data-component-id` is present on every visible element.

## Definition of done

- [ ] `HeadlessComponentRenderer.tsx` emits the contracted attributes in HOST and FUNCTION paths.
- [ ] All unit and snapshot tests pass (`pnpm test`).
- [ ] No regressions in editor-side renderer (`ComponentRenderer.tsx` continues to attach the same attributes via its existing path; the attributes are not duplicated or lost).
- [ ] Published DOM (via `/preview`) carries IDs on every node.
- [ ] Status moved to `done` in STATUS.md.

## Open questions

- **Attribute naming alignment with analytics-platform.** The renderer plan calls these `data-component-id`. The analytics-platform plan (`2026-04-28-framework-agnostic-analytics-architecture.md`, Phase A) calls them `data-lumitra-component` and `data-lumitra-id`. Decision needed before the snippet injection spec lands: do we ship the framer-clone-native names (`data-component-id`, `data-component-type`) and have the tracker fingerprint look for them, or do we ALSO emit `data-lumitra-*` aliases? Recommended: ship framer-clone-native names only, and the tracker fingerprint reads them as a privileged feature (zero-cost: the names are arbitrary strings on the analytics side). Surface to Marlin.
- **`data-inner-component-id` semantics.** Today only Text uses it. As the component registry grows (Carousel, Accordion, Form), inner editable regions multiply. Spec stays narrow on what exists today and lets future component additions extend the contract.

## References

- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (section "Current renderer architecture", line 33: "they are NOT attached in the headless path today. That is a bug for Lumitra Studio")
- Plan: `analytics-platform/docs/superpowers/plans/2026-04-28-framework-agnostic-analytics-architecture.md` (Phase A, line 178)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` ("`data-component-id` headless-path bug remains a must-fix regardless")
- Code touchpoints: `src/lib/renderer/HeadlessComponentRenderer.tsx`, `src/lib/renderer/createComponentElement.tsx`, `src/components/ComponentRenderer.tsx` (for the editor-side reference behavior)
