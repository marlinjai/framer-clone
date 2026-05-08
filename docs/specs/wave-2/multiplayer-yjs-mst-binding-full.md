---
name: multiplayer-yjs-mst-binding-full
track: multiplayer
wave: 2
priority: P0
status: draft
depends_on: [multiplayer-yjs-mst-binding-slice]
estimated_value: 10
estimated_cost: 9
owner: unassigned
---

# YjsMstBinding full coverage and Yjs-canonical write routing

## Goal

Extend the wave-1 vertical slice into a full bidirectional binding covering every persisted field of `ComponentModel`, `PageModel`, `ProjectModel`, and flip the editor's mutation path so Yjs is canonical: every user action writes to Yjs first, the Yjs observer applies into MST, MobX reactions fire, React re-renders. After this spec lands, MST is a derived projection and direct MST mutations from the UI layer are deprecated. AI mutations and editor user actions both route through Yjs.

> **MST-WRITE (sync layer):** All MST writes during normal editor operation come from this binding's Yjs observer. The only exceptions are: (1) initial hydration on cold start, (2) `EditorUIStore` and other ephemeral local stores (selection, drag ghost, viewport pan/zoom: never bound), (3) tests that directly construct MST nodes for fixtures. Every other "mutate MST directly" path is a regression once this lands.

## Scope

**In:**
- Extend `YjsMstBinding` to cover the full schema from `multiplayer-yjs-doc-shape`:
  - All scalar fields on `ComponentModel` (canvas position, viewport props, label, parentId, etc.).
  - `props` map including arbitrary scalar props.
  - `props.style` map including responsive maps (`{ base, mobile, desktop }`) where each breakpoint key gets its own LWW slot.
  - `children: Y.Array<string>` on every node, with insert/delete/move operations.
  - `nodes: Y.Map<Y.Map>` registry: when a new node ID appears in `nodes`, the binding creates the corresponding MST node. When a node ID disappears, MST node is removed.
  - Page-level: `pages_by_id`, `pages` order array.
  - Project-level: `project` map (name, primaryBreakpointId, schemaVersion).
- Flip MST action surface to Yjs-first writes:
  - Wrap each existing MST action (`addChild`, `removeChild`, `setCanvasPosition`, `updateResponsiveStyle`, `setTextContent`, etc.) so it writes to the Yjs doc inside `Y.Doc.transact(fn, { origin: localOrigin })` instead of mutating MST directly.
  - The Yjs observer then applies the change back to MST as a "remote" application from MST's perspective (no history, no echo).
  - Action signatures stay identical to consumers: `tree.addChild(child)` still works.
- Patch translator: convert MST JSON patches (the format `recordPatches` emits) to Yjs operations. Used during the slice's MST-first mode for backwards compatibility, then removed once Yjs-first lands. (Actually: keep it for the AI agent layer, which generates JSON patches. AI patches go through `applyPatchAsYjs` instead of MST `applyPatch`.)
- New `applyPatchAsYjs(doc, patches, origin)` helper that AI tools and external agents call to mutate the canonical store.
- Echo-prevention guarantees the slice spec's invariants but at scale across all observers.
- Provider lifecycle: `bindEditorToYDoc(rootStore, yDoc)` and `unbindEditor()` for sign-out / project switch.
- Remove the `VITE_MULTIPLAYER_SLICE` flag. Multiplayer is on by default in dev. Production gating decided at deploy time via `MULTIPLAYER_AUTH_REQUIRED`.
- Vitest coverage: every action in `ComponentModel` mutates Yjs correctly and a remote update produces the equivalent MST state.

**Out (explicitly deferred):**
- `Y.Text` for inline text (still LWW on whole-string `props.children`). Wave 3 if Marlin decides it's needed for v1.
- Per-user undo / `Y.UndoManager`: `multiplayer-per-user-undo`.
- Drag-conflict cancellation: `multiplayer-drag-and-delete-conflicts`.
- Awareness/presence: `multiplayer-presence-awareness`.
- Snapshot / version history.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/multiplayer/YjsMstBinding.ts` | edit | Extend to full schema. Refactor into composable per-field translators. |
| `src/lib/multiplayer/translators/` | new dir | Per-field translators (`scalars.ts`, `propsMap.ts`, `styleMap.ts`, `responsiveMap.ts`, `childrenArray.ts`). |
| `src/lib/multiplayer/applyPatchAsYjs.ts` | new | Patch-to-Yjs translator for AI agent + external mutations. |
| `src/lib/multiplayer/bindEditor.ts` | new | Top-level wiring: `bindEditorToYDoc(rootStore, yDoc)` + dispose. |
| `src/models/ComponentModel.ts` | edit | Each action now writes to Yjs first via the binding (when bound). Falls back to direct MST writes when no binding (single-player legacy path stays for tests / offline mode). |
| `src/models/PageModel.ts` | edit | Same. |
| `src/models/ProjectModel.ts` | edit | Same. |
| `src/stores/RootStore.ts` | edit | Wire `bindEditorToYDoc` on project load, `unbindEditor` on project unload. |
| `src/lib/multiplayer/YjsMstBinding.test.ts` | edit | Expand to cover all schema fields + Yjs-first action paths. |
| `src/lib/multiplayer/applyPatchAsYjs.test.ts` | new | AI patch path coverage. |

## API surface

```ts
export function bindEditorToYDoc(
  rootStore: RootStoreInstance,
  doc: Y.Doc,
  opts: { clientId: string; localOrigin: BindingOrigin },
): () => void; // returns dispose

export function applyPatchAsYjs(
  doc: Y.Doc,
  patches: ReadonlyArray<IJsonPatch>,
  origin: BindingOrigin,
): void;

// MST actions remain unchanged in signature. Internally:
//
// addChild(child) {
//   if (this.boundDoc) {
//     // route through Yjs
//     Y.transact(this.boundDoc, () => {
//       const childMap = createNodeYMap(child);
//       this.boundDoc.getMap('nodes').set(child.id, childMap);
//       getChildrenArray(this.boundDoc, this.id).push([child.id]);
//     }, this.localOrigin);
//     // observer applies back to MST
//   } else {
//     // legacy direct MST mutation path (tests, offline single-player)
//     this.children.push(child);
//   }
// }
```

## Data shapes

No new shapes beyond `multiplayer-yjs-doc-shape`. This spec is the implementation that fully populates and observes that shape.

Translation table (MST action -> Yjs operation):

| MST action | Yjs operation | Notes |
|------------|---------------|-------|
| `setCanvasPosition(x, y)` | `nodeMap.set('canvasX', x); nodeMap.set('canvasY', y)` inside one transact | LWW per key |
| `setLabel(label)` | `nodeMap.set('label', label)` | LWW |
| `addChild(child, idx)` | `nodes.set(child.id, newMap); childrenArray.insert(idx, [child.id])` | Two ops in one transact |
| `removeChild(childId)` | `childrenArray.delete(idx, 1); nodes.delete(childId)` | Tombstone semantics from Yjs |
| `clearChildren()` | `childrenArray.delete(0, len); nodes.delete(...all child ids)` | One transact |
| `updateResponsiveStyle(prop, val, bp)` | walk to `props.style.<prop>` Y.Map, set `<bp>` key | If responsive map doesn't exist, create with `base` and `<bp>` |
| `setTextContent(value)` | `nodeMap.get('props').set('children', value)` | Whole-string LWW for v1 |
| `toggleCanvasVisibility()` | `nodeMap.set('canvasVisible', !current)` | LWW |

## Test plan

- [ ] Unit: every MST action in `ComponentModel`, `PageModel`, `ProjectModel` translates to the expected Yjs operations (table-driven test).
- [ ] Unit: applying a remote Yjs update produces the same MST state that the equivalent local action would.
- [ ] Unit: `applyPatchAsYjs` translates 10+ representative MST patches into correct Yjs operations.
- [ ] Unit: echo-prevention. After a local action: exactly one MST mutation (the action). After a remote update: exactly one MST mutation (the projected apply), no echo back to Yjs.
- [ ] Integration: load a real fixture project, mutate it, encode the doc, decode in a fresh tab, observe the same MST state.
- [ ] Integration: two-tab manual smoke test with full editor (not the slice page). Drag, resize, type, add component, delete, change responsive style. All sync within ~200ms p95.
- [ ] Performance: 50-node project, 30 mutations per second sustained, no UI jank. Measure render frame budget with React Profiler.
- [ ] Manual: per memory `feedback_no_chrome_devtools_for_dragdrop.md`, drag/drop verification done by Marlin manually.

## Definition of done

- [ ] All translators land and typecheck.
- [ ] Vitest suite passes (binding + translator + patch-as-yjs).
- [ ] Two-tab manual smoke confirmed by Marlin on the real editor.
- [ ] No regressions in existing `pnpm test`.
- [ ] AI agent layer (when it lands per `ai-pattern-a` track) can use `applyPatchAsYjs` instead of touching MST.
- [ ] `MULTIPLAYER.md` doc landed at `docs/MULTIPLAYER.md` covering: where canonical state lives (Yjs), how to mutate it (actions or `applyPatchAsYjs`), what NOT to do (direct MST writes outside the binding), echo-prevention, origin tagging.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- Should we keep the legacy "no-binding" code path on every action for offline single-player? Or remove it and require a Y.Doc always (in-memory if not connected)? **Default: always-on Y.Doc** even offline (the doc lives in memory and can be encoded for local persistence). Simpler invariant, less code. Marlin to confirm.
- AI patch path: does the AI agent get its own origin tag (`ai-<runId>`) so per-user undo can ignore AI changes by default? **Default: yes,** AI gets its own origin. Per-user `Y.UndoManager` (next spec) excludes AI origin from `trackedOrigins` unless user explicitly "owned" the AI run.
- `props.style` responsive maps: when a property has BOTH a `base` value and a breakpoint value, deleting the breakpoint key in Yjs should leave `base` intact. Verify this works with our Y.Map model.
- React reactivity: if MobX observers don't fire cleanly on Yjs->MST applies (the load-bearing question from the slice spec), where do we add manual `runInAction` wrapping? **Default: inside the binding's apply step** (one place to wrap).

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (sections 2c, 6c phase 1)
- Memory: `feedback_pre_mvp_no_backcompat.md` (no-backcompat: we can flip the action surface without preserving the old path), `feedback_no_chrome_devtools_for_dragdrop.md`
- Code touchpoints: `src/models/ComponentModel.ts`, `src/models/PageModel.ts`, `src/models/ProjectModel.ts`, `src/stores/RootStore.ts`
- Reference implementations: BlockNote (https://github.com/TypeCellOS/BlockNote), Affine, Tldraw multiplayer architecture
