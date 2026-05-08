---
type: plan
status: decided
date: 2026-04-19
summary: Architectural plan for collapsing the editor's three overlapping drag systems into one pointer-based drag manager. Keeps MST. Fixes the floating-to-tree gap as a side-effect of the rewrite, not as a point fix.
tags: [drag-drop, architecture, mst, editor, pointer-events]
---

# Drag-and-drop unification: plan

## TL;DR (decision record)

| # | Decision | One-line rationale |
|---|----------|--------------------|
| 1 | Keep MST for the tree model. | Already load-bearing. Multiplayer is Phase 4 of the greedy-wiggling-elephant plan. Design the drag layer so it's state-backend-agnostic, so we can swap to Yjs-backed MST later without touching drag. |
| 2 | Replace all three drag systems with one `DragManager` driven by `PointerEvent`. | Single event model, single hit-test, single drop indicator, single mutation path. Removes the "drag source X knows about drop targets Y" coupling. |
| 3 | Delete HTML5 `DragEvent` from the codebase entirely (panels + viewports + canvas + Layers). | Hostile to our GPU-accelerated transform stack, buys us nothing since we paint our own indicator, and needing two event models is the root of the current coordination hacks. |
| 4 | Keep DOM-based hit-testing via `elementFromPoint` + data-attribute walk. Don't build a canvas-space spatial index yet. | Zero-regression, works under zoom/pan today, no workload that needs it faster. The `resolveDropTarget` API is shaped so a future spatial index swaps in without changing callers. |
| 5 | `page.moveTreeComponent` and `page.insertRegistryComponent` stay. They're already the right actions. `InsertTarget` stays. | The model layer is already unified; the mess is entirely above it. |
| 6 | Ghost-and-indicator for tree-child and panel-create drags; direct-manipulation (live `canvasX/Y`) for floating and viewport drags. Drop indicator paints regardless. | Matches how Framer behaves and what users expect. Ghost for tree children avoids the visual chaos of live-moving an element whose parent layout reflows. |
| 7 | One history entry per drag gesture, via existing `HistoryStore.startBatch` / `commitBatch` / `cancelBatch`. | Batching already works; just plug in. |
| 8 | Back-end integration is NOT a prerequisite. Don't bundle the drag rewrite with any persistence, SSR, or CRDT decision. | Those live in separate plans. The drag layer's contract with state is one action per gesture, which is already the case. |
| 9 | Cut over in one PR after scaffolding lands. No intermediate state where half the drags use the new manager and half use the old. | Incremental cutover is how we got to three systems in the first place. |

The rest of this doc argues each point and lays out the execution plan.

---

## 1. Is MST the right state foundation?

**Short answer: yes, for v1 and for the realistic next twelve months. Don't rewrite now.**

### What MST actually gives us today

- `ComponentModel` + `PageModel` + `ProjectModel`, all with `types.identifier` nodes and `types.safeReference` selections, so deletes don't strand references.
- `createActionTrackingMiddleware2` + `recordPatches` in `HistoryStore.ts`. This is non-trivial to rebuild elsewhere. It gives us a labelled undo/redo stack with per-action patches and per-gesture batching, all in ~240 lines.
- `mobx-react-lite`'s `observer` at the leaf (ComponentRenderer), so re-renders are per-component and precisely scoped. For a canvas editor that will eventually render thousands of nodes, this matters.
- Actions that are already shaped like AI tool calls: `insertRegistryComponent`, `moveTreeComponent`, `updateResponsiveStyle`, `deleteComponent`. The greedy-wiggling-elephant plan is explicit that these are the strategic wedge.

### The honest cons

- **MST patches are operational, not commutative.** Multiplayer via patch-broadcast works for single-writer-at-a-time scenarios, breaks under concurrent edits to the same subtree. CRDTs (Yjs, Automerge, Loro) solve this.
- **Immutable patching gets expensive for large array ops.** Reordering a 10k-item children array produces a patch per moved index. Not hitting that wall, but could matter if individual pages exceed a few thousand nodes.
- **MST-specific API lock-in.** `safeReference`, `getRoot`, `detach`, `applyPatch` are non-portable. Migrating away later means rewriting every store.

### What Figma / Framer / Webflow actually do (and why they didn't pick MST)

| Editor | State engine | Why not MST |
|--------|--------------|-------------|
| **Figma** | Bespoke C++ document engine with a custom CRDT. JS bindings are thin. | JS-based state was never on the table for them: they needed GPU scene-graph, off-main-thread rendering, and native binary serialization. |
| **Framer** | Custom observable layer (predates Framer the site-builder, grew out of their earlier prototyping tool). Uses Yjs for collab. Code components render in isolated contexts. | MST didn't exist or was nascent when they built their engine. Their needs (code execution, timeline, custom renderers) are broader than a typed tree. |
| **Webflow** | Redux for editor state. Collab story is offline-first, not real-time. | Redux was the dominant choice when Webflow was built. They've effectively been fine without CRDT. |

None of these teams would have picked MST today either: their document models are significantly larger than "a typed tree of styled components."

### The decision for us

We are building a web-only editor in React. Real-time collab is **Phase 4** in greedy-wiggling-elephant.md. We do **not** need CRDT correctness right now.

When we do, the practical paths are:

1. **MST + Yjs bridge:** keep MST models, bind each `children: types.array(...)` to a `Y.Array`, each prop map to a `Y.Map`. Apply remote Yjs updates as MST patches (and vice-versa). Feasible but has known edge cases around array moves. Estimated cost: 2 to 4 weeks of focused work when we get there.
2. **Rewrite state layer on Yjs directly**, with a thin MobX-observable wrapper. Loses the MST ergonomics (action decorators, safeReferences, `getSnapshot`). Estimated cost: 4 to 8 weeks when we get there.

**Both paths are open from where we are now.** Neither is blocked by the drag-drop rewrite, because the drag layer only interacts with state through two actions (`moveTreeComponent`, `insertRegistryComponent`) and a handful of views. When we change the underlying storage, the drag manager doesn't care.

### One small cleanup to flag (not a prerequisite)

`ComponentModel.parentId` is a manually-managed mirror of the MST tree's real parent pointer. `setParent` / `clearParent` / `addChild` / `removeChild` all keep it in sync. MST has `getParent(node, depth?)` built in.

`hasParent` → `getParent(component, 2) instanceof ComponentModel`
`parentId` → `getParent(component, 2)?.id`

The mirror is a drift risk. I'd kill it in a follow-up refactor, not as part of this rewrite. Flagging so we don't accidentally build more on top of it.

---

## 2. How Framer actually does drag-and-drop

Some of the below is verifiable (shipping behaviour, public talks, the editor bundle). Some is educated extrapolation from how similar products are built. Where I'm inferring, I'll say so.

### Verifiable

- **One pointer pipeline.** Drags on the canvas use raw pointer events. No HTML5 `dragstart`, no `dataTransfer`. Confirmed by inspecting the Framer editor's event handlers (they attach `pointerdown` / `pointermove` / `pointerup`).
- **Drop indicator is painted by a top-level overlay layer**, not by the candidate target itself. Same for the ghost.
- **Undo reverts a whole gesture in one step.** Framer's undo model is explicitly turn-based; every interaction produces exactly one history entry.
- **Source and target are identified by node id**, not by DOM element. You can see this because dragging a component across viewports still shows the original as the "source" in all three, and the drop is consistent.

### Inferred from architecture and dev-tool talks

- **Canvas-coordinate hit test against the node tree.** Framer maintains per-node bounding boxes and does spatial queries in canvas space. The reason (inferred): they need to hit-test nodes that are off-screen or occluded, which DOM hit-testing can't do. We don't need this yet.
- **Uniform position semantics.** Every node has canvas-space coords. "Tree child vs free-floating" is a property of the layout system, not of the node's identity. Our model already does this: `canvasNodeType` is a discriminator, not a separate type.
- **Drop resolution is a pure function of pointer + node tree + zoom + modifiers.** Runs every frame during drag. The indicator re-paints from its output.

### What we should steal, what we can skip

| Steal | Skip (for now) |
|-------|----------------|
| Single pointer pipeline, pointer capture. | Canvas-space spatial index. DOM hit-test is enough for our scale. |
| Pure drop-resolver function. | Per-node bounding-box cache. Read DOM rects on demand. |
| Single drop-indicator overlay. | Drop animations. Instant snap is fine for v1. |
| Per-gesture undo. | Multi-select + marquee drag. Different gesture, out of scope here. |
| Ghost rendering for tree moves. | Cross-document drag (drag a component out of Framer into an email). Completely out of scope. |

**Caveat:** if later investigation of Framer's actual client bundle reveals they do something different (e.g., they DO use HTML5 drag for panel items, for some drag-across-apps reason), we'd reconsider. But nothing in their visible behaviour requires that, and the data-attributes in their DOM don't suggest it.

---

## 3. Do we need deeper backend-tree integration?

**Short answer: not for this rewrite. Keep that decision separate.**

### Where the tree lives today

- Entirely in-memory MST. No persistence, no server, no SSR.
- `PageModel.exportData` returns a serializable snapshot (the app tree + breakpoints + metadata). Intended for export but not wired to anything today.
- `ComponentRenderer` reads the same tree that would be exported. SSR-from-MST is plausible: the renderer takes a `breakpointId` and resolves responsive props at render time, which works in Node identically to in the browser.

### What drag needs from the backend

- **Atomic mutations.** One action per gesture so a multi-writer persistence layer sees one operation, not N per-frame writes. Already the case: every drag commits through `moveTreeComponent` or `insertRegistryComponent`, one call on release.
- **Stable identifiers.** MST `types.identifier` with uuid ids. Already the case.
- **Cycle-safe moves.** `moveTreeComponent` already rejects self/descendant. Already the case.

### What drag does NOT need from the backend

- A decision on SSR.
- A decision on CRDT.
- A decision on export serialization format.

These can all be decided independently of the drag rewrite. The drag layer will behave identically whether the tree is in-memory, synced to a server, or CRDT-backed, as long as actions remain atomic.

### One thing to watch later

When we add persistence, we'll want to debounce or batch writes during a live-manipulation drag (the viewport / floating position drag that writes `canvasX/Y` per frame). Since we batch into one history entry already, the natural hook is to also flush one persistence write per batch commit. Not a decision for now, just a note.

---

## 4. The unified drag architecture

This is the core proposal. Flat list of primitives + invariants + API shapes. No code, just design.

### 4.1 Event model

**One kind of event: `PointerEvent`.**

- `pointerdown` on the source starts a gesture. `setPointerCapture(pointerId)` is called immediately so subsequent moves / up / cancel fire on the source element even if the pointer leaves it.
- `pointermove` on the source (received via capture) drives the resolver + indicator.
- `pointerup` on the source commits. `pointercancel` aborts cleanly (e.g., OS-level interrupt, another touch).
- `keydown` on document watches for Escape.

**No HTML5 DragEvent, anywhere.** The `dataTransfer` channel is replaced by an in-memory `DragManager` singleton that knows the source. The panel items lose `draggable` and `onDragStart`; the Canvas loses `onDragOver` / `onDrop`; viewports and floating wrappers lose their drop handlers.

**No MouseEvent drag code.** The old `onMouseDown` drag blobs in `ComponentRenderer` (tree-child drag) and `ResponsivePageRenderer` (viewport + floating position drag) go away. Selection `onClick` and text-editing `onDoubleClick` stay untouched.

**Why this matters**: `PointerEvent` + `setPointerCapture` has none of the `transform + contain + fixed + will-change` pathology that killed HTML5 drag inside GroundWrapper. The fix that made tree-child drag work (`e.preventDefault()` on GroundWrapper, then the ancestor-guard to protect inner `[draggable="true"]` children) can be deleted entirely. The multi-layer `stopPropagation` dance goes away.

### 4.2 Drag sources

Every drag entry point passes one of two source shapes to the manager:

```ts
type DragSource =
  | { kind: 'create'; registryId: string }
  | { kind: 'moveNode'; nodeId: string };
```

There is no third source type. "Viewport position drag" and "floating position drag" and "tree child reparent" are all `moveNode` with different node kinds; the resolver decides what to do with them.

**Entry points (all five use the same `useDragSource` hook):**

| Source element | Source shape | Notes |
|----------------|--------------|-------|
| `ComponentsPanel` item | `{ kind: 'create', registryId }` | Replaces `draggable + onDragStart` |
| `LayersPanel` row | `{ kind: 'moveNode', nodeId }` | Replaces `draggable + onDragStart` |
| Tree child in `ComponentRenderer` (hasParent) | `{ kind: 'moveNode', nodeId }` | Replaces the current mouse-based drag blob |
| Viewport frame `GroundWrapper` | `{ kind: 'moveNode', nodeId }` | Viewport-specific policy applied in resolver (never reparents) |
| Floating-element `GroundWrapper` | `{ kind: 'moveNode', nodeId }` | The case that's currently broken |

The app-tree root and viewport nodes have their drag refused at `begin()` time, same as today's `moveTreeComponent` guards.

### 4.3 Hit testing

**DOM-based via `elementFromPoint`**, walking up to the first element with a drop-container attribute.

Existing attributes we'll reuse (no renames):

- `data-viewport-id="<id>"` on the viewport frame.
- `data-floating-root-id="<id>"` on each floating-element wrapper.
- `data-inner-component-id="<id>"` on every rendered component (already emitted by `ComponentRenderer`).
- `data-ground="true"` added on `Canvas`'s ground div, so the resolver can distinguish "empty canvas" from "over UI chrome."
- `data-editor-ui="true"` added on Toolbar / LeftSidebar / RightSidebar / HudSurface, so the resolver returns `null` when the pointer is over chrome (→ cancel).

**Resolver walks up from `elementFromPoint(x, y)` until it hits one of these.** Order:

1. `[data-editor-ui]` → return null (cancel silently).
2. `[data-inner-component-id]` → candidate tree drop.
3. `[data-floating-root-id]` → candidate floating-root drop (we resolve to the floating element itself if there's no nested component under cursor).
4. `[data-viewport-id]` → candidate viewport drop (resolves to `{ kind: 'appTree' }` when there's no specific inner).
5. `[data-ground]` → empty canvas → `{ kind: 'floating', x, y }`.
6. Nothing → null.

The same tree renders 3 times (once per viewport). `elementFromPoint` returns one of the three; the `data-inner-component-id` is unqualified (identity-stable across viewports), so the walk-up resolves to a single MST node id regardless of which viewport copy the pointer hit. Cross-viewport drag is transparent.

**Why not a canvas-space spatial index today:**

- No clear performance benefit at our scale. `elementFromPoint` is O(1) at the browser level.
- More code to maintain. An R-tree or quadtree on canvas bounds is 200 to 400 lines and has to be kept in sync with layout.
- Pre-optimizing for marquee-selection-across-10k-nodes, which we don't have.
- **The resolver signature is shaped so we can swap.** `resolveDropTarget(pointer, transform, source, rootStore)` is the full public API. If we later compute hits via a spatial index instead of `elementFromPoint`, nothing above it changes.

### 4.4 Drop target resolution (pure function)

```ts
// Pure function: no side effects, no DOM mutation.
// Inputs come from PointerEvent + TransformContext + RootStore.
function resolveDropTarget(args: {
  pointer: { clientX: number; clientY: number };
  transform: { panX: number; panY: number; zoom: number };
  source: DragSource;
  page: PageInstance;        // read-only view
  excludeNodeId?: string;    // source id, if this is a moveNode
}): {
  target: InsertTarget | null;     // null means "cancel silently"
  indicator: IndicatorSpec | null; // what to paint this frame
  mode: 'live' | 'ghost';          // whether source should live-update canvasX/Y
}
```

**Zone classification inside a tree component target** (existing logic, centralized):

- Sliver = `min(12px, rect.height * 0.25)`.
- Top sliver → `before`. Bottom sliver → `after`.
- Middle → `inside` if the target can host children, else nearest-edge sliver.
- "Can host children" is `!isVoidTag(target.type) && target is not a text-leaf with string children`.

**Guards:**

| Guard | Where |
|-------|-------|
| Self-drop: source === target | Return null |
| Cycle: target is a descendant of source | Return null (belt-and-suspenders; `moveTreeComponent` also rejects) |
| Void tag target as `inside` | Collapse to `before`/`after` |
| Text-leaf with string children as `inside` | Collapse to `before`/`after` (otherwise nesting would destroy the text) |
| Target is app tree root or viewport | Only `inside` (appends to appTree); no `before`/`after` |
| Pointer over `[data-editor-ui]` | Return null |

**Mode decision:**

- `source.kind === 'create'` → always `ghost` (nothing exists yet to live-manipulate).
- `source.kind === 'moveNode'` and source is a tree child → always `ghost` (live-moving would reflow the parent).
- `source.kind === 'moveNode'` and source is a viewport → always `live` (user expects the frame to follow cursor; no reparenting possible).
- `source.kind === 'moveNode'` and source is a floating element → always `live`. The floating element follows cursor in canvas space. If release lands over a drop container, we commit a reparent; if over empty canvas, we commit the new floating position. Per-frame `canvasX/Y` updates during the drag are buffered in the history batch; on reparent, they're superseded by the final `moveTreeComponent({kind: 'parent'})` and the net change is a single "Move component" entry in history.

### 4.5 Visual feedback

**Two overlay components, mounted once at the editor root alongside `HudSurface`:**

- `DropIndicatorLayer` paints the blue bar (for `before`/`after`) or outline (for `inside`) on the current target. Singleton painter, no per-candidate DOM handlers. Replaces today's mix of `#__drop-indicator-bar` + `data-drop-hover` + dashed viewport outline.
- `DragGhostLayer` paints a screen-space ghost of the source while in `ghost` mode. v1 is a simple pill with the source's label + icon. v2 can upgrade to a DOM clone or an off-screen rendered thumbnail.

Both subscribe to the same `DragManager` state via MobX. They only render while a gesture is active.

**Dashed viewport highlight goes away.** The current "drag is entering this viewport" ring is replaced by the drop indicator painting on the appropriate inner target or on the viewport frame itself when the drop resolves to `{ kind: 'appTree' }`.

**Source dimming** (opacity 0.4 + `pointer-events: none`) applies only when `mode === 'ghost'`. For `live` mode, the source stays fully visible and moves under the cursor. For tree-child sources, we dim the DOM instance(s) the user pressed on; for panel-create, there's no source element to dim.

### 4.6 State mutation

**One action per gesture, on pointerup, inside a history batch.**

```
on pointerdown:
  DragManager.begin(source, event)
    historyStore.startBatch(batchNameFor(source))

on pointermove (per frame):
  { target, indicator, mode } = resolveDropTarget(...)
  DragIndicatorLayer.setIndicator(indicator)
  if mode === 'live' and source is floating/viewport:
    source.updateCanvasTransform({ x: newX, y: newY })    // existing action
  DragManager.setPendingTarget(target)

on pointerup:
  target = DragManager.pendingTarget
  if target:
    if source.kind === 'create':
      page.insertRegistryComponent(source.registryId, target)
    else:
      page.moveTreeComponent(source.nodeId, target)
  historyStore.commitBatch()

on Escape OR pointercancel:
  if source was live-mode AND canvasX/Y was touched:
    source.setCanvasPosition(startCanvasX, startCanvasY)  // existing action
  historyStore.cancelBatch()
```

The mutation path is therefore:

| Source kind | Target kind on drop | Action called |
|-------------|--------------------|-----------------|
| create | parent / sibling / appTree / floating | `page.insertRegistryComponent(registryId, target)` |
| moveNode | parent / sibling / appTree / floating | `page.moveTreeComponent(nodeId, target)` |

**Zero new actions** on `PageModel` / `ComponentModel`. The drag rewrite is pure UI/controller layer.

### 4.7 API sketch

Internal module layout under `src/lib/drag/`:

```
src/lib/drag/
  DragManager.ts          // MST volatile store: singleton, pointer pipeline, history batching
  resolveDropTarget.ts    // Pure function. Unit-testable.
  useDragSource.ts        // Hook: attaches onPointerDown to any element.
  DropIndicatorLayer.tsx  // Single overlay painter.
  DragGhostLayer.tsx      // Single ghost painter.
  voidTags.ts             // Moved from ComponentRenderer; shared helper.
  zoneClassify.ts         // Moved from ComponentRenderer; shared helper.
  markers.ts              // Exported constants: DATA_VIEWPORT_ID, DATA_INNER_COMPONENT_ID, etc.
  types.ts                // DragSource, IndicatorSpec, DragMode, DragGesture.
```

**`DragManager` interface:**

```ts
interface DragManager {
  // Read-only views
  readonly isActive: boolean;
  readonly mode: 'live' | 'ghost' | null;
  readonly sourceNodeId?: string;
  readonly pendingTarget: InsertTarget | null;
  readonly indicator: IndicatorSpec | null;
  readonly ghost: { label: string; icon?: string } | null;

  // Lifecycle (called from useDragSource hook)
  begin(source: DragSource, event: React.PointerEvent): void;
  // Internal (driven by document-level handlers during a gesture)
  // _onMove, _onUp, _onCancel, _onKey, etc.
}
```

**`useDragSource` hook:**

```ts
function useDragSource(source: DragSource | null): {
  pointerHandlers: { onPointerDown: (e: React.PointerEvent) => void };
};
```

Returns `{}` (no-op handlers) when source is null, so callers can conditionally enable without branching.

**Invariants encoded into the manager:**

| Invariant | How it's enforced |
|-----------|-------------------|
| Only one gesture active at a time. | `begin()` early-returns if `isActive`. |
| Refuse to drag app tree root or viewport-into-tree. | `begin()` checks `moveTreeComponent`-equivalent guards. |
| Refuse to drag a component currently in `editingComponent`. | `begin()` checks `editorUI.editingComponent?.id`. |
| Pointer capture is always released. | `_onUp` / `_onCancel` / `_onKey(Escape)` always call `releasePointerCapture`. |
| History batch always commits or cancels (never leaks). | `_onUp` → commit, `_onCancel` / Escape → cancel. If an exception throws mid-mutation, a `try/finally` in `_onUp` calls cancel. |
| `canvasX/Y` always restores on Escape (for live mode). | Manager stores `startCanvasPos`; Escape path calls `source.setCanvasPosition(startCanvasPos)` before `cancelBatch`. |
| Keyboard shortcuts suppressed during drag. | `EditorApp`'s keydown listener checks `dragManager.isActive` and early-returns for delete/undo/redo. |
| Drop on UI chrome cancels. | Resolver returns null; `_onUp` with null target = no-op mutation + commitBatch (no patches, so no entry). |

### 4.8 Production-grade checklist (mapping to the handover's non-negotiables)

| Requirement | How the new design delivers it |
|-------------|--------------------------------|
| Correct under zoom/pan. | Pointer coords go into `resolveDropTarget`, which reads `transformState.current` each frame. Zoom-invariant by construction. |
| No DOM race conditions. | `elementFromPoint` is called synchronously inside `pointermove`, not inside a post-commit React effect. The walk-up uses stable `data-inner-component-id`, not per-frame attributes. |
| Atomic undo. | One `startBatch` on pointerdown, one `commitBatch` on pointerup, one history entry per gesture. |
| Escape always cancels cleanly. | Document-level `keydown` with capture, checked for `Escape`. Live-mode sources restore `canvasX/Y` from `startCanvasPos` before cancel. Pointer capture released. |
| No preventDefault wars. | No HTML5 drag means no `preventDefault` on dragstart. `PointerEvent.preventDefault()` on pointerdown is a clean signal to suppress text selection and we own it in one place (inside the manager). |
| Cycle prevention. | Enforced at two layers: `resolveDropTarget` short-circuits to null, `moveTreeComponent` enforces again as last line. |
| Self-drop no-op. | Resolver returns null when target id === source id. Pointerup with null target = no mutation. |
| App tree root / viewports not movable. | `begin()` refuses these source ids. |
| Void tags not nest-targetable. | Centralized `isVoidTag` used in zone classifier; `inside` collapses to `before`/`after`. Plus existing render-time guard in `ComponentRenderer` stays as belt-and-suspenders. |
| Keyboard shortcuts don't fire during drag. | `EditorApp` keydown listener early-returns when `dragManager.isActive`. |

---

## 5. Migration path

### 5.1 Files deleted or gutted

| File | Change |
|------|--------|
| `src/components/Canvas.tsx` | Remove `handleDragOver`, `handleDrop`, the `COMPONENT_DRAG_MIME` / `COMPONENT_MOVE_MIME` imports, and the `onDragOver` / `onDrop` wiring on the ground div. Keep pan/zoom, keep `onClick` deselect, keep the wheel handler. Add `data-ground="true"` to the ground div. |
| `src/components/ResponsivePageRenderer.tsx` | Delete everything: `hasEditorDragMime`, `findDropTargetComponentId`, `applyHoverHighlight`, `clearHoverHighlight`, `HOVER_ATTR`, `HOVER_STYLE`, `hoverComponentIdRef`, `dropTargetViewportId` state. Delete the entire `onDragEnter` / `onDragOver` / `onDragLeave` / `onDrop` block on the viewport frame div. Delete the entire `onMouseDown` drag blob on each GroundWrapper (viewports and floating). Replace both `onMouseDown`s with a single call to the `useDragSource({ kind: 'moveNode', nodeId: element.id })` hook's handler. Delete the `data-floating-root-id` wrapper's drag handlers; keep the attribute itself. |
| `src/components/ComponentRenderer.tsx` | Delete the entire `onMouseDown` drag blob (lines 246 to 362 today), including the nested `computeZone`, `onMove`, `onUp`, `onKey`, `pendingZone`, and the drop-indicator painter. Delete the helpers at top of file: `INDICATOR_ID`, `HOVER_ATTR`, `INDICATOR_COLOR`, `getOrCreateIndicatorBar`, `clearInsideHighlight`, `applyInsideHighlight`, `paintDropIndicator`, `clearDropIndicator`, `findInnerComponentId`, `classifyZone`, `VOID_ELEMENTS`, `isVoidTag`. `VOID_ELEMENTS` and `classifyZone` move to `src/lib/drag/`. The render-time void-tag guard stays (it's a render-layer concern, orthogonal to drag). Attach `useDragSource({ kind: 'moveNode', nodeId })` to the tree child's pointer handler. |
| `src/components/sidebars/left/ComponentsPanel.tsx` | Remove `draggable + onDragStart`. Attach `useDragSource({ kind: 'create', registryId: entry.id })`. Drop the `COMPONENT_DRAG_MIME` import. Keep the re-export for now if anything else still reads it (probably nothing does after this patch; remove if confirmed). |
| `src/components/sidebars/left/LayersPanel.tsx` | Remove `draggable + onDragStart + onDragOver + onDragLeave + onDrop`. Attach `useDragSource({ kind: 'moveNode', nodeId: component.id })` when `isDraggable`. Keep the `dropTargetId` visual (the row's ring highlight when hovered during a drag); wire it instead to `dragManager.pendingTarget` when the target's parent id matches this row. |
| `src/lib/componentRegistry.ts` | Remove `COMPONENT_DRAG_MIME` and `COMPONENT_MOVE_MIME` exports after all call sites are migrated. Registry entries and `getComponentEntry` / `listComponentsByCategory` stay. |
| `src/stores/EditorUIStore.ts` | Remove `dragData`, `isDragging`, `startDrag`, `updateDrag`, `endDrag`, `isDragInProgress`, `currentDragData` (volatile + views). That state now lives on `DragManager`. `isResizing` / `resizeData` / `startResize` / `endResize` stay (orthogonal concern). `HudSurface` currently reads `editorUI.isDragInProgress` to hide overlays during drag: change to read `dragManager.isActive` via a similar observable. |
| `src/components/GroundWrapper.tsx` | No change. The `onDragStart preventDefault` guard was already removed in a prior session. Just confirm no new drag wiring is needed here. |

### 5.2 Files added

| File | Purpose |
|------|---------|
| `src/lib/drag/types.ts` | `DragSource`, `DragMode`, `IndicatorSpec`, `DragGesture`. |
| `src/lib/drag/markers.ts` | Constants for data-attributes. |
| `src/lib/drag/voidTags.ts` | `VOID_ELEMENTS`, `isVoidTag`. |
| `src/lib/drag/zoneClassify.ts` | `classifyZone(rect, clientY, targetCanHostChildren)`. |
| `src/lib/drag/resolveDropTarget.ts` | Pure function. |
| `src/lib/drag/DragManager.ts` | MST volatile store singleton + pointer pipeline + history batching. |
| `src/lib/drag/useDragSource.ts` | Hook. |
| `src/lib/drag/DropIndicatorLayer.tsx` | Overlay component. |
| `src/lib/drag/DragGhostLayer.tsx` | Overlay component. |
| `src/lib/drag/index.ts` | Barrel. |

### 5.3 Files modified (structural, not content-deletion)

| File | Change |
|------|--------|
| `src/components/EditorApp.tsx` | Mount `<DropIndicatorLayer />` and `<DragGhostLayer />` alongside `<HudSurface />`. Add `dragManager.isActive` check in the keydown handler so delete/undo/redo don't fire during a drag. Add `data-editor-ui="true"` attribute on the fixed header / LeftSidebar / RightSidebar / Toolbar wrappers. |
| `src/stores/RootStore.ts` | Instantiate `DragManager` singleton the same way we do `HistoryStore`. Pass the rootStore into `DragManager` so it can read the current page / editorUI / transform. |
| `src/hooks/useStore.ts` (or new hook) | Add `useDragManager()` hook for components that want to observe state. |

### 5.4 Order of operations

**Phase A: scaffolding (small, isolated, zero user-visible change).**

- Land `src/lib/drag/` with all stubs + types + pure `resolveDropTarget` + helpers moved out of `ComponentRenderer`.
- Land `DragManager` as an MST volatile store, wired to RootStore but not attached to any entry point.
- Land `DropIndicatorLayer` + `DragGhostLayer` as hidden overlays.
- Add `data-ground="true"` on Canvas ground, `data-editor-ui="true"` on chrome.
- Ship. App works identically. This PR is ~400 lines net addition, reviewable alone.

**Phase B: cutover (one PR, coherent).**

All in one commit-or-PR, so there's no intermediate state:

1. Replace drag entry point in `ComponentsPanel` (simplest; regular DOM).
2. Replace drag entry point in `LayersPanel`.
3. Replace drag entry point in `ComponentRenderer` (tree children).
4. Replace drag entry points in `ResponsivePageRenderer` (viewports + floating).
5. Delete all HTML5 drag handlers (Canvas, ResponsivePageRenderer, LayersPanel, ComponentsPanel).
6. Delete mouse-based drag blobs (ComponentRenderer, ResponsivePageRenderer).
7. Delete `COMPONENT_DRAG_MIME` / `COMPONENT_MOVE_MIME` exports from `componentRegistry.ts`.
8. Remove `dragData` / `isDragging` / `startDrag` / `updateDrag` / `endDrag` / `currentDragData` / `isDragInProgress` from `EditorUIStore`.
9. Update `HudSurface` to read `dragManager.isActive` instead of `editorUI.isDragInProgress`.
10. Update `EditorApp` keydown to suppress shortcuts during drag.
11. Mount the overlay layers in EditorApp.

Post-Phase-B, the app has exactly one drag system. Reviewable in one pass: the diff is large, but the shape is "delete A+B+C, add D, rewrite caller sites."

**Phase C: polish (follow-up PRs, low-risk).**

- Ghost rendering upgrade: render a small DOM snapshot or thumbnail instead of the label pill.
- Snap animation on drop (optional UX nicety).
- Touch / pen verification on iPad / Wacom (PointerEvent already covers this; just test).
- Remove the legacy `mst-middlewares` dep if nothing else uses it (greedy-wiggling-elephant flagged this).

### 5.5 What's explicitly NOT changing

- `PageModel.moveTreeComponent`, `insertRegistryComponent`, `deleteComponent`, `InsertTarget` shape.
- `ComponentModel` shape, actions, views.
- `HistoryStore` API or internals.
- `TransformContext` (pan/zoom remains ref-based, no React re-renders).
- `HudSurface` selection + resize logic (the resize interaction is orthogonal and already coherent).
- Selection model, text-editing model.
- `GroundWrapper` styling / positioning / transform stack.

### 5.6 Risks and unknowns

| Risk | Mitigation |
|------|------------|
| PointerEvent inside GroundWrapper's `transform + contain + fixed + will-change` stack has an unknown pathology. | Before Phase B, spike a 20-line prototype: attach `onPointerDown` to a div inside a GroundWrapper at various zoom levels; verify `setPointerCapture` works and `pointermove` fires continuously. I'm 95% confident this works fine (PointerEvent does not have the dragstart-gating browser logic that killed HTML5), but it's the one thing I haven't proven empirically. Budget half a day. |
| `elementFromPoint` behind transforms returning the wrong element at extreme zoom. | Today's implementation already handles this. Verify at 10% / 100% / 500% as part of the E2E suite. |
| Ghost rendering performance if we later upgrade to DOM-clone-of-source. | Start with label-pill. Measure before upgrading. |
| Touch / pen interaction is different from mouse (contextmenu, long-press, palm-reject). | Defer to Phase C. PointerEvent is the right primitive; the rules for rejecting stylus palm-touch etc are a separate concern. |
| The large cutover PR is hard to review. | Land Phase A first as no-op scaffold. In Phase B, keep each file's cutover as its own commit in the branch so reviewers can step through. |
| History batch leaks if an exception throws mid-mutation. | `try/finally` in `_onUp`; ensures `commitBatch` or `cancelBatch` always fires. Covered by unit tests for the manager's state machine. |

---

## 6. Testing strategy

The current repo has zero tests. We're not going to ship a drag rewrite behind another "whack-a-mole" test plan. Three layers, smallest-to-largest:

### 6.1 Unit tests (add Vitest)

Add `vitest` + `@testing-library/react` + `jsdom` to devDependencies. Add a `test` script. Target: `resolveDropTarget` as a pure function first, then `DragManager` state transitions.

**`resolveDropTarget` test table** (one `describe` per row in a spec file):

| Input scenario | Expected output |
|----------------|-----------------|
| Pointer over empty canvas, zoom 1.0 | `{ target: { kind: 'floating', x, y }, mode: 'live' or 'ghost' per source type }` |
| Pointer over empty canvas, zoom 0.3, pan (100, 50) | canvas coords correctly inverted |
| Pointer over viewport frame, no inner hit | `{ target: { kind: 'appTree' } }` |
| Pointer over tree component top sliver | `{ target: { kind: 'sibling', position: 'before' } }` |
| Pointer over tree component bottom sliver | `{ target: { kind: 'sibling', position: 'after' } }` |
| Pointer over tree component middle, hasChildren | `{ target: { kind: 'parent', parentId } }` |
| Pointer over void tag (img, br, input) middle | Collapses to `before` or `after` nearest-edge |
| Pointer over text-leaf (`p` with string children) middle | Collapses to `before` or `after` |
| Pointer over source node itself | `null` |
| Pointer over descendant of source | `null` (cycle guard) |
| Pointer over toolbar (`data-editor-ui`) | `null` |
| Pointer over floating root, no nested hit | `{ target: { kind: 'parent', parentId: floatingId } }` |
| Pointer over floating root, nested component hit | `{ target: { kind: 'parent', parentId: innerId } }` |
| Mode for `create` source | `'ghost'` |
| Mode for `moveNode` source = tree child | `'ghost'` |
| Mode for `moveNode` source = floating element | `'live'` |
| Mode for `moveNode` source = viewport | `'live'` |

Mock the DOM via `jsdom` + a small fixture tree we construct per test. No need to mount the whole editor.

**`DragManager` state-machine tests:**

| Transition | Expected |
|------------|----------|
| `begin` then `_onMove` × N then `_onUp` | Action called once with final resolved target; batch committed once. |
| `begin` then `_onUp` without movement | No mutation, batch still commits (no-op entry, drops automatically since no patches). |
| `begin` then `_onKey(Escape)` | No mutation; if live mode touched `canvasX/Y`, restore; `cancelBatch` called. |
| `begin` then `_onCancel` (pointercancel) | Same as Escape. |
| `begin` when already active | No-op (second begin ignored). |
| `begin` on node in `editingComponent` | Refused (returns false). |
| `begin` on app tree root | Refused. |
| `begin` on viewport node with `moveNode` intent → then resolver returns `parent` target | Target discarded; viewports never reparent. (Enforced by resolver, but also via `_onUp` guard.) |

### 6.2 E2E tests (Playwright)

Add Playwright to devDependencies. One spec file: `tests/e2e/drag-drop.spec.ts`. Each of the handover's edge cases becomes one `test()`. All run against `pnpm dev` at `localhost:3000`. Seeded project auto-loads (already wired in `EditorApp`), so the app boots to a known tree.

**Core scenarios (the ones called out in the handover, plus fills):**

1. Drag a Text from ComponentsPanel into the Desktop viewport at a specific container. Assert new node appears in `__rootStore` tree with correct parent.
2. Drag a Text from ComponentsPanel onto empty canvas. Assert new floating node in `canvasNodes` with coords near pointer.
3. Drag a tree child across viewports (Desktop → Tablet → same tree). Assert same MST node id, new parent.
4. Drag a tree child out onto canvas. Assert node becomes floating, `canvasNodeType === 'floating'`, coords correct.
5. **Drag a floating element onto a viewport** (THE bug). Assert node becomes a tree child of the correct parent, `canvasNodeType === 'component'`, no canvas coords.
6. Drag a floating container (with children) over another floating container. Assert whole subtree moved.
7. Drag a floating container with children onto a viewport. Assert subtree preserved.
8. Drag a tree child onto its own parent (reorder). Assert new index; no detach-reattach flicker (verify with a snapshot of `children` ids at each step).
9. Drop on empty viewport (no specific inner). Assert append to appTree root.
10. Start a drag, move over sidebar, release. Assert no mutation; assert history still has N entries (unchanged).
11. Start a drag, zoom ⌘-scroll to 30%, release on different target. Assert correct target resolved.
12. Start any drag, press Escape. Assert original state preserved; history entry count unchanged.
13. Double-click text component to edit, then try to drag it. Assert drag refused.
14. Select a component (resize handles visible), drag it from its body (not a handle). Assert resize handle didn't intercept; assert drag proceeded normally.
15. Undo after each of scenarios 1 to 9: assert one ⌘Z reverts the drag.
16. Undo/redo bounce: ⌘Z then ⌘Shift+Z, verify end state identical.

**Assertion mechanism:** use `window.__rootStore` (already exposed in dev mode via EditorApp). After each action, `page.evaluate(() => window.__rootStore.editorUI.currentPage)` returns the live snapshot; compare to expected.

**Stability tricks:**

- Add `data-testid` on toolbar buttons, layer rows, panel items, viewport frames.
- Use Playwright's `mouse.move` / `mouse.down` / `mouse.up` at absolute coords.
- For pointer-capture scenarios, use `page.dispatchEvent` with the correct pointerType.
- Each test clears the history before running (via `getHistoryStore().clear()`), to normalize the starting state.

### 6.3 Manual regression checklist

One markdown file, `docs/plans/drag-drop-manual-test.md`, checked in alongside this plan. A senior eye (or the user) runs it once before merging the cutover PR. Same 16 scenarios as above, plus a handful of "feel" items that are hard to automate (does the ghost follow cursor smoothly at 60fps? does the drop indicator flicker?).

### 6.4 Chrome devtools MCP for interactive debugging

We have `mcp__chrome-devtools__*` tools available in Claude Code. During implementation, use:

- `take_snapshot` to inspect DOM after a drag.
- `evaluate_script` to read `window.__rootStore` and verify state transitions.
- `performance_start_trace` / `performance_stop_trace` around drags to verify no layout thrash or long tasks.

This is for the developer (me or a future agent), not a replacement for the automated Playwright suite.

### 6.5 Zoom/pan extremes

Covered in both unit (math for `(clientX - panX) / zoom`) and E2E (scenario 11). Pass criteria: all 16 scenarios pass at 25%, 100%, and 250% zoom with canvas panned by ±500px in both axes.

---

## 7. Open questions (to resolve during implementation, not now)

1. **Ghost content fidelity.** Label pill for v1. When we upgrade: DOM-clone, off-screen rendered thumbnail, or per-registry-entry hand-tuned preview? Defer.
2. **Indicator paint at extreme zoom.** Below 30% zoom, the 12px edge sliver cap means most drops become "inside," which may be confusing. Consider scaling the sliver cap with `zoom`, but validate via user testing first.
3. **Multi-select drag.** Completely out of scope. If we add it, the `DragSource` union grows a `moveNodes: string[]` variant; everything downstream compiles.
4. **Marquee selection.** Same event-source question: unified pointer pipeline makes this natural to add later. Not now.
5. **Dragging the selection HUD overlay itself.** HUD is `pointer-events: none` on its background and `pointer-events: auto` only on resize handles. New drag doesn't interact with HUD. Keep HUD as-is.
6. **Cross-tab / cross-window drag (e.g., drag a component out to a second browser window).** Out of scope. Would require HTML5 drag, but we're explicitly rejecting it for v1.
7. **Unifying `data-*` markers.** Currently `data-viewport-id`, `data-floating-root-id`, `data-inner-component-id`. Could be one `data-drop-container-id` + `data-drop-container-kind`. Minor cleanup; not worth rolling into this PR. Flag for later.

---

## 8. Explicit non-goals for this rewrite

To keep scope honest:

- No backend / persistence / CRDT work.
- No layout primitive consolidation (that's in greedy-wiggling-elephant.md).
- No Designer/Developer mode toggle.
- No AI tool-call work.
- No marquee selection, no multi-select drag.
- No touch / pen polish in Phase B (works by default via PointerEvent; stylus palm-reject deferred).
- No animation on drop.
- No changes to `PageModel` / `ComponentModel` actions or shape.
- No changes to `HistoryStore`.
- No changes to the inline-style responsive rendering pipeline.

---

## 9. First deliverable (this doc) → second deliverable

If you approve this plan:

1. I land **Phase A** (scaffolding, no behavior change) as a standalone PR. Small, reviewable in one pass.
2. I land **Phase B** (cutover) as a follow-up PR with file-per-commit granularity inside the branch. Large diff, but each commit is self-contained ("remove HTML5 handlers from Canvas," "replace mouse drag in ComponentRenderer with useDragSource," etc.).
3. Unit + E2E tests added as part of Phase B, as a hard prerequisite for merge.
4. Phase C is polish, merged separately, no rush.

If you disagree on any of the numbered decisions in the TL;DR table, say which one and why. The easiest to revisit is #4 (DOM vs canvas-space hit test); the hardest to revisit without a bigger rewrite is #3 (dropping HTML5 entirely). Everything else is local to the design.
