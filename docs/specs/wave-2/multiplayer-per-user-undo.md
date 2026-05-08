---
name: multiplayer-per-user-undo
track: multiplayer
wave: 2
priority: P0
status: draft
depends_on: [multiplayer-yjs-mst-binding-full]
estimated_value: 9
estimated_cost: 6
owner: unassigned
---

# Per-user undo via Y.UndoManager (replaces HistoryStore patches)

## Goal

Replace the patch-based `HistoryStore` undo path with a `Y.UndoManager` per local client, scoped to local origin only, so each user undoes only their own actions. This is mandatory once multiplayer ships: undoing remote users' actions corrupts the shared document. The existing `HistoryStore` public API (`undo`, `redo`, `canUndo`, `canRedo`, `startBatch`, `commitBatch`, `cancelBatch`, `labelFor`, `jumpTo`) stays so the toolbar and history panel don't change. The implementation underneath becomes a thin facade over `Y.UndoManager`.

> **MST-WRITE (sync layer):** Undo/redo writes to the Y.Doc with origin = `'undo'`. The Yjs observer in the binding (per `multiplayer-yjs-mst-binding-full`) projects the change into MST. The `HistoryStore` does NOT call `applyPatch` against MST anymore.

## Scope

**In:**
- `Y.UndoManager` instantiated per session, bound to `doc.getMap('nodes')`, `doc.getMap('pages_by_id')`, `doc.getMap('project')`. `trackedOrigins: new Set([localOrigin])` so only local-user changes are undoable.
- `HistoryStore` refactored:
  - When a Y.Doc is bound (always, after wave 2), all methods proxy to `Y.UndoManager`.
  - `recordEntry` is no longer a public path; `Y.UndoManager` records automatically when local-origin transactions happen.
  - `undo()` -> `undoManager.undo()`. `redo()` -> `undoManager.redo()`.
  - `canUndo` / `canRedo` -> `undoManager.undoStack.length > 0` / `undoManager.redoStack.length > 0`.
  - `clear()` -> `undoManager.clear()`.
  - `jumpTo(idx)` -> walk `undo()` / `redo()` until at target index.
- Action-name + path metadata captured via `Y.UndoManager` `stack-item-added` event. Stored on `stackItem.meta` keyed by entry ID. The history panel (`labelFor`) reads from this map.
- Gesture batching:
  - `Y.UndoManager.captureTimeout` set to a sensible default (200ms) for general edits.
  - For explicit drag/resize gestures, call `undoManager.stopCapturing()` at gesture start (so the gesture doesn't merge with the previous edit), let `captureTimeout` coalesce all the per-frame ops, call `undoManager.stopCapturing()` again at gesture end (so the next edit doesn't merge with the gesture).
  - `cancelBatch()` for ESC-to-cancel: pop the in-progress stack item via `undoManager.popStackItem()` and discard.
  - `startBatch(name)` becomes `beginGesture(name)` internally: stops capturing, records the name as pending metadata.
- The `HistoryStore` MST model itself stays, but `history` array becomes a derived view computed from `undoManager.undoStack` (read-only). No more `addMiddleware` on the project store: the binding's Yjs observer now drives all mutations.
- Migration of the toolbar undo/redo buttons: no UI change needed. `useStore().historyStore.undo()` still works.

**Out (explicitly deferred):**
- Visual diff in the history panel (showing what changed). Phase 2.
- Multi-user history audit log ("see who changed what"). Phase 2.
- Cross-user undo / "undo their last change" feature. Phase 2.
- Undo of AI-agent changes: the AI gets origin `'ai-<runId>'`, NOT in default `trackedOrigins`. Per `multiplayer-yjs-mst-binding-full` open question, this is the right default but Marlin to confirm.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/stores/HistoryStore.ts` | edit | Replace middleware-based recording with `Y.UndoManager` facade. Keep public API stable. |
| `src/stores/HistoryStore.test.ts` | new (likely) or edit | Test suite for the new behavior. |
| `src/lib/multiplayer/undoManager.ts` | new | Factory + metadata-capture wiring. |
| `src/stores/RootStore.ts` | edit | Wire `Y.UndoManager` alongside the binding setup. |
| `src/lib/drag/DragManager.ts` | edit | Update gesture batching calls (`startBatch` -> still works via facade, but verify the `stopCapturing` semantics behave identically). |

## API surface

```ts
// HistoryStore public API (unchanged signatures):
interface HistoryStoreInstance {
  canUndo: boolean;
  canRedo: boolean;
  history: ReadonlyArray<{ id: string; actionName: string; timestamp: number }>;
  undoIdx: number;
  undo(): void;
  redo(): void;
  jumpTo(idx: number): void;
  clear(): void;
  startBatch(name: string): void;
  commitBatch(): void;
  cancelBatch(): void;
  labelFor(entry): string;
}

// New internal:
export function createUndoManagerFor(
  doc: Y.Doc,
  localOrigin: BindingOrigin,
): {
  undoManager: Y.UndoManager;
  metaByStackItem: Map<Y.AbstractType<any>, { actionName: string; timestamp: number }>;
};
```

## Data shapes

`Y.UndoManager` operates on a list of "scopes" (`Y.AbstractType<any>` instances). Configure:

```ts
const undoManager = new Y.UndoManager(
  [
    doc.getMap('nodes'),
    doc.getMap('pages_by_id'),
    doc.getMap('project'),
  ],
  {
    trackedOrigins: new Set([localOrigin]),
    captureTimeout: 200,
  },
);
```

Stack items carry `meta: Map<string, any>` for free-form metadata. We attach action name + timestamp.

## Test plan

- [ ] Unit: local action -> `undoStack.length === 1`. Undo -> MST state matches pre-action state, `redoStack.length === 1`.
- [ ] Unit: remote-origin update does NOT appear in either stack (`trackedOrigins` filter works).
- [ ] Unit: per-user isolation. Simulate two clients in one process via two Y.Docs synced manually. Client A undoes: only A's last change reverses. B's changes are untouched.
- [ ] Unit: gesture batching. 30 cursor-move ops within 200ms collapse into one stack item.
- [ ] Unit: `cancelBatch()` after `startBatch()` produces no stack item. State is restored by `popStackItem` semantics.
- [ ] Unit: action name metadata round-trips: pushed during `stack-item-added`, read by `labelFor`.
- [ ] Integration: two-tab manual. User A makes 3 changes, user B makes 1 change interleaved. Each user's undo stack has only their own changes.
- [ ] Manual: ESC during drag still cancels and rewinds correctly.

## Definition of done

- [ ] Y.UndoManager facade lands and typechecks.
- [ ] Existing `HistoryStore` consumers (toolbar, history panel, drag manager) work without modification beyond verified `startBatch`/`commitBatch` semantics.
- [ ] Vitest suite covers per-user isolation and gesture batching.
- [ ] Two-tab manual smoke confirms each user undoes only their own actions.
- [ ] Single-player mode (no peers connected) behaves identically to today: undo/redo, gesture batching, ESC-cancel.
- [ ] Remove the old `HistoryStore` middleware code path. Per `feedback_pre_mvp_no_backcompat.md`: no users yet, no need to keep the legacy patch system around.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- AI agent changes: include in trackedOrigins by default, or excluded? **Default: excluded.** Users undo their own work; AI changes have their own undo path (a "revert AI run" affordance, not the standard cmd+Z stack). Confirm with `ai-pattern-a` track owner.
- `Y.UndoManager.captureTimeout` value: 200ms (Yjs default is 500ms). Faster captureTimeout = more granular undo, slower = better gesture coalescence. **Default: 200ms,** match the existing `HistoryStore` heuristic feel.
- History panel UI: today shows `history` array with all entries. With Y.UndoManager, the redo stack is separate from the undo stack. Does the panel need to render both? **Default: undo stack only,** Marlin can decide if redo visualization is needed.
- Memory bound: today MAX_HISTORY = 500. `Y.UndoManager` doesn't have a built-in cap. Add manual trimming via `stack-item-added` listener. **Default: trim undoStack to 500 items.** Confirm.

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (sections 3, 5b, 6c phase 4)
- Memory: `feedback_pre_mvp_no_backcompat.md` (delete the old patch system rather than keeping it dual-mode)
- External: https://docs.yjs.dev/api/undo-manager
- Code touchpoints: `src/stores/HistoryStore.ts`, `src/lib/drag/DragManager.ts`, `src/components/Toolbar.tsx`
