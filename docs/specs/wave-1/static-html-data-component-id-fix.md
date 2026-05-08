---
name: static-html-data-component-id-fix
track: static-html
wave: 1
priority: P0
status: draft
depends_on: []
estimated_value: 9
estimated_cost: 2
owner: unassigned
---

# Fix data-component-id emission on the headless render path

## Goal

The editor renderer (`ComponentRenderer.tsx`) attaches `data-component-id` and `data-inner-component-id` to every emitted element, but the headless renderer (`HeadlessComponentRenderer.tsx`) does not. The published preview surface (and the upcoming static HTML target) therefore ship DOM with no stable component identifiers. This breaks Lumitra Studio cross-domain matching (heatmaps, A/B variant fingerprints) and blocks any future runtime that needs to address a node by its MST id. The strategic thesis flags this as a must-fix regardless of every other architectural decision. This spec moves the attribute emission into the shared dispatch so all renderers (editor, headless preview, static HTML) get it for free.

## Scope

**In:**
- Add `data-component-id` and `data-inner-component-id` emission inside the headless render path so `HeadlessComponentRenderer` and any string-emitting static HTML emitter inherit them.
- Decide the canonical attachment site: either inside `createComponentElement` (preferred, single source of truth) OR inside `HeadlessComponentRenderer` mirroring the editor.
- Keep the editor renderer working (no double-attribution, no regression on selection / drag-resolve / cross-viewport highlighting).
- Verification test that asserts both attributes survive on a headless render.

**Out (explicitly deferred):**
- Static HTML string emitter itself (separate spec: `static-html-spike`).
- CSS flattening, multi-page publish pipeline (later specs).
- Renaming the attributes or changing the `${breakpointId}-${component.id}` shape (downstream selectors in `crossViewportHighlighting.ts`, `HudSurface.tsx`, `SecondarySelectionOverlays.tsx`, drag resolver depend on it).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/createComponentElement.tsx` | edit | Accept a `dataAttributes` shape (or compute from `component`) and inject `data-component-id` / `data-inner-component-id` on the emitted element. Void-tag path included. Function-component path: pass through as props (registry components are expected to spread to their root, see Open Questions). |
| `src/lib/renderer/HeadlessComponentRenderer.tsx` | edit | Pass `breakpointId` and `component.id` into `createComponentElement` so it can build the attributes. Remove the comment that says headless does not attach data-* IDs. |
| `src/components/ComponentRenderer.tsx` | edit | Remove the local `data-component-id` / `data-inner-component-id` keys from `finalProps` (now centralized) OR keep them and verify no double-emit. Pick one and document. |
| `src/lib/renderer/__tests__/headlessDataAttributes.test.tsx` | new | Vitest renders a small MST tree through `HeadlessPageRenderer` and asserts `data-component-id` and `data-inner-component-id` appear on every host element. |

## API surface

```ts
// src/lib/renderer/createComponentElement.tsx
export interface CreateComponentElementOptions {
  // When present, the dispatch attaches these attributes to the emitted element.
  // The editor and headless paths both supply them; only the registry path for
  // FUNCTION components depends on the user component spreading props to its root.
  identity?: { breakpointId: string; componentId: string };
}

export function createComponentElement(
  component: ComponentInstance,
  finalProps: Record<string, unknown>,
  children: React.ReactNode[],
  rawTextChildren?: React.ReactNode,
  options?: CreateComponentElementOptions,
): React.ReactNode;
```

The exact placement (whether identity comes via options or via finalProps merge) is the worker's call. The constraint is: one source of truth, both renderers exercise it, and FUNCTION components do not silently drop the attributes.

## Data shapes

```ts
// Emitted DOM attributes (unchanged shape; just now emitted in more places):
{
  'data-component-id': `${breakpointId}-${component.id}`, // e.g. "bp-mobile-abc123"
  'data-inner-component-id': component.id,               // e.g. "abc123"
}
```

The renderer touches MST in read-only mode: `component.getResolvedProps`, `component.children`, `component.id`, `component.type`. No MST writes from the headless or static HTML paths, ever.

## Test plan

- [ ] Unit: new `src/lib/renderer/__tests__/headlessDataAttributes.test.tsx`. Build a 3-node MST tree (root container, two children, one nested), render via `HeadlessPageRenderer`, assert every host element carries both attributes with the expected `${breakpointId}-${id}` shape.
- [ ] Unit: extend the same test to cover a void tag (`img`) and assert attributes survive.
- [ ] Unit: extend to cover a FUNCTION component path (register a fake component on `window.__componentRegistry` that spreads props to its root) and assert attributes reach the DOM.
- [ ] Manual: open the existing /preview surface, inspect a rendered element, confirm both attributes are present (they are absent today).
- [ ] Manual: open the editor, click a component, drag a component, confirm selection and drag still resolve (no double-attribution regression).

## Definition of done

- [ ] Code lands and typechecks
- [ ] `pnpm test` passes including the new headless data-attribute test
- [ ] No regression in editor selection (`SecondarySelectionOverlays`, `HudSurface`), drag resolution (`resolveDropTarget`), or cross-viewport highlighting (`crossViewportHighlighting`)
- [ ] `HeadlessComponentRenderer.tsx` header comment updated (no longer says "no `data-component-id` attributes")
- [ ] Status field moved to `done` in STATUS.md

## Open questions

- Should the identity attributes live in `createComponentElement` (single source of truth) or be supplied by the caller via `finalProps` (current editor pattern, just extended to headless)? The first is cleaner; the second is the smaller diff. Worker should propose, Marlin decides before merging.
- For FUNCTION components in `__componentRegistry`, the attributes only land if the component spreads props to its root element. Today's registry (Container, Stack, Grid, Flex, Card, etc.) does this, but it is an unwritten contract. Should we document it, lint it, or wrap registry components in an identity-emitting host span? Surface to Marlin.
- The `${breakpointId}-${componentId}` shape only makes sense when a breakpoint is in scope. Static HTML publish emits per-breakpoint CSS but a single DOM tree. Is the `data-component-id` value still breakpoint-scoped on static output, or does it become bare `componentId` there? Defer the call to `static-html-css-flattener` but raise it now.

## References

- Plan: `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` (recommendation 2: emit data-* in headless path)
- Memory: `memory/project_strategic_thesis_bubble_killer.md` ("data-component-id headless-path bug remains a must-fix regardless")
- Code touchpoints: `src/lib/renderer/createComponentElement.tsx`, `src/lib/renderer/HeadlessComponentRenderer.tsx`, `src/components/ComponentRenderer.tsx`, `src/utils/crossViewportHighlighting.ts`, `src/components/HudSurface.tsx`
- Cross-track: lumitra-studio (consumer of these attributes once integration starts)
