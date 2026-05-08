---
name: multiplayer-yjs-mst-binding-slice
track: multiplayer
wave: 1
priority: P0
status: draft
depends_on: [multiplayer-yjs-doc-shape, multiplayer-hocuspocus-server-scaffold]
estimated_value: 10
estimated_cost: 7
owner: unassigned
---

# YjsMstBinding vertical slice (one node type, props only)

## Goal

Prove Shape C end-to-end on a narrow vertical slice: one node (a single floating-element text node), one prop family (`canvasX` / `canvasY` / `props.children` text), bidirectional sync. This is the de-risking spike from research plan section 6d, formalized as a shippable spec. The output answers the load-bearing question called out in the plan caveats: "does MobX reactivity flow through a Yjs-backed projection cleanly?" before we commit 6 to 7 weeks of full binding work in wave 2.

> **MST-WRITE (sync layer):** This spec introduces the first MST mutation path that is NOT user-driven: the Yjs observer applies remote updates to MST via `applyPatch`. From this spec forward, any code that writes to MST directly (outside the binding) is a bug once full multiplayer ships. AI mutations, drag commits, and editor user actions must route through Yjs as the canonical store. Until full binding lands (`multiplayer-yjs-mst-binding-full`), the slice path is gated behind a feature flag (`VITE_MULTIPLAYER_SLICE`) so the rest of the editor keeps working in single-player mode.

## Scope

**In:**
- A `YjsMstBinding` class in `src/lib/multiplayer/YjsMstBinding.ts` with a v0 surface scoped to one node type (`CanvasNodeType.FLOATING_ELEMENT`) and three fields: `canvasX`, `canvasY`, `props.children` (plain string LWW).
- MST-to-Yjs direction: subscribe to MST patches on the bound floating-element node via `recordPatches` (same primitive `HistoryStore` uses). When a patch lands and origin is local, translate to a `Y.Map.set` inside `Y.Doc.transact(() => ..., { origin: 'local' })`.
- Yjs-to-MST direction: `Y.Map.observe` on the node's `Y.Map`. When an update lands and origin is NOT local (i.e. came from another client via the websocket provider), `applyPatch` to MST inside a `withoutRecording` window (no history entry, no echo loop).
- Echo prevention: tag every `Y.Doc.transact` call with an origin. Local origin = our client ID. Remote origin = anything else. Skip remote->MST when the origin is local. Skip MST->Yjs when we're inside an `applyPatch` from a remote update (`isApplyingRemote` flag).
- A test page at `src/app/multiplayer-slice/page.tsx` (Next.js) that:
  - Creates one floating text element, binds it via `YjsMstBinding`.
  - Connects via `HocuspocusProvider` to `ws://localhost:1234`.
  - Lets you drag the element (updates `canvasX`/`canvasY`) and edit the text.
  - Renders a sibling element showing the current `canvasX/Y/text` values from MST so we can visually confirm reactivity flows through.
- Vitest coverage of the binding's translation logic against an in-memory `Y.Doc` (no websocket).
- Feature flag wiring: `VITE_MULTIPLAYER_SLICE`. When unset, the editor behaves as it does today.

**Out (explicitly deferred):**
- Full schema coverage (all node types, nested children arrays, responsive style maps): `multiplayer-yjs-mst-binding-full` in wave 2.
- `Y.UndoManager` integration: `multiplayer-per-user-undo`.
- Drag-conflict cancellation: `multiplayer-drag-and-delete-conflicts` in wave 3.
- Awareness/presence: `multiplayer-presence-awareness`.
- Replacing the production editor's mutation path (still routes through MST actions in single-player mode for this spec).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/multiplayer/YjsMstBinding.ts` | new | Binding class, v0 scope. |
| `src/lib/multiplayer/YjsMstBinding.test.ts` | new | Vitest unit suite using in-memory Y.Doc + MST instance. |
| `src/lib/multiplayer/origins.ts` | new | Origin constants and helpers for `Y.Doc.transact`. |
| `src/app/multiplayer-slice/page.tsx` | new | Two-tab smoke page. |
| `src/app/multiplayer-slice/SliceEditor.tsx` | new | Component that wires the binding + provider. |
| `package.json` | edit | Add `@hocuspocus/provider`, `y-protocols`. |

## API surface

```ts
import * as Y from 'yjs';
import { ComponentInstance } from '@/models/ComponentModel';

export type BindingOrigin = 'local' | 'remote' | 'undo';

export interface YjsMstBindingOptions {
  doc: Y.Doc;
  node: ComponentInstance;        // the MST node to bind
  clientId: string;               // used for origin tagging + per-user undo (later)
}

export class YjsMstBinding {
  constructor(opts: YjsMstBindingOptions);
  /** Initial sync: copy MST state into Yjs (only if Y.Map is empty). */
  hydrateFromMst(): void;
  /** Initial sync: copy Yjs state into MST (only on cold start). */
  hydrateFromYjs(): void;
  /** Wire bidirectional listeners. Idempotent. */
  start(): () => void;            // returns disposer
  /** True while we're applying a remote update; MST->Yjs writer skips. */
  isApplyingRemote: boolean;
}
```

Note: this v0 binds a single node. The wave 2 full binding takes a `Y.Map` of all nodes and walks the tree. The v0 surface is intentionally narrow to keep the spike honest.

## Data shapes

For this slice, the bound node's `Y.Map` only mirrors:

```ts
// Y.Map at doc.getMap('nodes').get(nodeId)
{
  id: string,
  type: string,
  componentType: string,
  canvasNodeType: 'floating',
  canvasX: number,
  canvasY: number,
  props: Y.Map { children: string }
}
```

Other fields from the full schema (defined in `multiplayer-yjs-doc-shape`) are written but not observed in this slice. The full binding (wave 2) extends to all fields.

## Test plan

- [ ] Unit: hydrating an empty Y.Map from an MST node produces a Y.Map with the expected scalar keys.
- [ ] Unit: setting `canvasX` on MST emits exactly one Yjs operation, with `origin === 'local'`.
- [ ] Unit: setting `canvasX` on the Y.Map (simulated remote, origin = 'remote') updates the MST node within one microtask, no history entry recorded, `isApplyingRemote` toggles correctly.
- [ ] Unit: an MST update inside `isApplyingRemote === true` is NOT mirrored back to Yjs (echo prevention).
- [ ] Unit: round-trip of `props.children = 'hello'` (text content) through both directions.
- [ ] Integration / manual: open two tabs of `/multiplayer-slice`, drag the element in tab A, see it move in tab B within 200ms. Type in the text field in tab B, see it update in tab A.
- [ ] Manual: kill the Hocuspocus server, mutate in tab A, restart server, observe the queued update flushes (this is the offline-edits behavior given to us by `HocuspocusProvider` for free; we just verify it).

## Definition of done

- [ ] Binding class lands and typechecks.
- [ ] Vitest unit suite passes.
- [ ] Two-tab manual smoke confirmed by Marlin (the research plan explicitly notes drag/drop verification cannot use Chrome DevTools synthetic events, so this is human-verified per memory `feedback_no_chrome_devtools_for_dragdrop.md`).
- [ ] Decision documented: did MobX observers fire correctly on remote updates without manual `runInAction` wrapping? If yes, full binding (wave 2) proceeds as planned. If "only with manual runInAction", flag the cost in `multiplayer-yjs-mst-binding-full`. If "MobX cannot observe Yjs reactively at all", escalate to Marlin (architecture changes).
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- Origin tagging: use a string constant (`'local-<clientId>'`) or the `clientId` numeric directly? Y.UndoManager's `trackedOrigins` accepts any value. **Default: string,** more readable in dev tools.
- When the MST node is created (no existing Y.Map yet) vs joins an existing doc: which side hydrates? **Default: if `nodes.has(nodeId)` is false, MST hydrates Yjs. Otherwise Yjs hydrates MST.** First-writer-wins on cold start.
- The v0 slice writes to MST first then mirrors to Yjs. The plan's recommended end-state is Yjs first then MST observer applies back. Should the slice already adopt Yjs-first writes, or stay MST-first for the prototype? **Recommendation: slice stays MST-first to minimize change, full binding (wave 2) flips to Yjs-first.** Marlin to confirm.
- Single test-bed page or wired into the real editor behind a flag? **Default: separate page.** Avoids contaminating the production editor with prototype code.

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (sections 2c, 6c phase 0+1, 6d)
- Memory: `feedback_no_chrome_devtools_for_dragdrop.md` (drag verification = manual)
- Code touchpoints: `src/models/ComponentModel.ts`, `src/stores/HistoryStore.ts` (recordPatches pattern)
- External: https://docs.yjs.dev/api/y.doc#transactions (origin tagging)
- External: https://github.com/yjs/y-protocols
