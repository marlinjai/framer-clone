---
name: multiplayer-drag-and-delete-conflicts
track: multiplayer
wave: 3
priority: P1
status: draft
depends_on: [multiplayer-yjs-mst-binding-full, multiplayer-presence-awareness]
estimated_value: 7
estimated_cost: 5
owner: unassigned
---

# Drag-while-remote-reparent + delete-while-editing recovery

## Goal

Handle the two well-defined custom-logic conflicts called out in the research plan section 3 that Yjs does NOT resolve for free:

1. User A is mid-drag of node X, user B reparents node X via the layers panel. Yjs serializes the operations; one wins, the other is a no-op. User A's drag ghost has to snap back / recover gracefully so they don't end up dropping into a stale source array.
2. User A is editing the props of node X (selected, sidebar open). User B deletes node X. User A's local prop write goes to a tombstoned `Y.Map`. UI must show a toast ("Component was deleted by Marlin") and clear selection so the user isn't editing nothing.

These are the only two custom-logic gaps in the conflict-resolution table. Everything else in the table is native Yjs LWW semantics. This spec lands both fixes together because they share a detection pattern (observe the parent chain of an in-flight local operation).

## Scope

**In:**
- Drag-conflict detection in `src/lib/drag/DragManager.ts`:
  - When a drag begins, the dragged node's source `children: Y.Array<string>` is recorded along with the index.
  - During the drag, observe the source array. If the dragged node's ID disappears from the source array via a remote-origin update, treat the drag as cancelled:
    - Cancel the local batch (`historyStore.cancelBatch()`).
    - Snap the ghost back to its original position with a 200ms tween.
    - Show a brief toast: "<Peer name> moved this component."
- Selection-target deletion detection in `src/stores/EditorUIStore.ts` (or a new `selectionWatcher.ts`):
  - When a component is selected, observe its presence in `doc.getMap('nodes')`.
  - If a remote-origin update removes the node from `nodes`, clear `selectedComponentId`, close the right sidebar's properties panel, and show a toast: "<Peer name> deleted '<displayName>'."
- Generic "ConflictToast" component for these messages, reusing the existing toast system if present (or adding a tiny one if not).
- Peer-name resolution: pull from `PresenceStore.remotePeers` based on the origin's clientId. Fallback to "Someone" if the peer has already disconnected.
- Vitest coverage for both detection paths (using in-memory Y.Doc + simulated remote updates).

**Out (explicitly deferred):**
- Drag ghost broadcasting (showing user A's drag in progress to user B). Phase 2.
- Conflict resolution for "two users edit the same `Y.Text` simultaneously": v1 stays whole-string LWW (research plan caveat).
- "Restore deleted component" affordance via Y.UndoManager. The deleted component is recoverable by user B (the deleter) via their undo stack; user A doesn't get a restore button. Phase 2 if requested.
- Conflict UI for "two users dropped the same component on the same parent at the same index": Yjs handles natively (interleaving), no custom logic needed.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/drag/DragManager.ts` | edit | Add Y.Array observer on source `children`; cancel-on-remote-removal. |
| `src/stores/EditorUIStore.ts` | edit | Add Y.Map observer on selection target; clear-on-remote-deletion. |
| `src/lib/multiplayer/selectionWatcher.ts` | new | Encapsulates the deletion-watch logic (pulled out so EditorUIStore stays clean). |
| `src/components/multiplayer/ConflictToast.tsx` | new | Toast UI for these messages. |
| `src/lib/drag/DragManager.test.ts` | edit | Add tests for remote-reparent cancellation. |
| `src/lib/multiplayer/selectionWatcher.test.ts` | new | Tests for delete-while-selected. |

## API surface

```ts
// selectionWatcher.ts
export function watchSelectionForRemoteDeletion(args: {
  doc: Y.Doc;
  uiStore: EditorUIStoreInstance;
  presenceStore: PresenceStoreInstance;
  onConflict: (msg: string) => void;
}): () => void; // disposer

// DragManager additions (internal):
private watchDragSourceForRemoteReparent(): void;
private cancelDragAsRemoteConflict(peerName: string): void;
```

## Data shapes

No new persistent shapes. Both detection paths read from `multiplayer-yjs-doc-shape`'s existing `nodes` map and child arrays.

## Test plan

- [ ] Unit (DragManager): start a drag on node X, simulate a remote update that removes X from its source children array. Drag is cancelled, ghost snaps back, `cancelBatch` is called, toast invoked once.
- [ ] Unit (DragManager): drag completes normally without remote interference. No conflict toast.
- [ ] Unit (selectionWatcher): select node X, simulate remote deletion of X. Selection is cleared, toast invoked once with the correct peer name.
- [ ] Unit (selectionWatcher): select node X, locally delete X. Selection cleared but NO conflict toast (it was your own delete, origin matches localOrigin).
- [ ] Unit: peer-name fallback. If the originating peer is already disconnected from `PresenceStore`, toast says "Someone" instead of throwing.
- [ ] Manual two-tab: drag a component in tab A, simultaneously reparent it via layers panel in tab B. Tab A's drag should cancel cleanly, ghost snap back, toast appears.
- [ ] Manual two-tab: select a component in tab A (sidebar open), delete it in tab B. Tab A's sidebar closes, toast appears.

## Definition of done

- [ ] Both detection paths land and typecheck.
- [ ] Vitest unit coverage passes.
- [ ] Two-tab manual smoke verified by Marlin (both scenarios).
- [ ] No regression in existing drag-drop behavior in single-player mode.
- [ ] Toast UI visually consistent with any existing toast / notification surface in the editor.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- Toast duration: 3s default? **Default: 4s** for conflict toasts (longer than info toasts because the user needs to mentally re-orient).
- Should the cancelled drag's ghost tween or jump? **Default: tween 200ms,** consistent with the follow-peer tween in presence spec.
- If the user is mid-drag AND the destination parent is deleted by another user (not just the source), what happens? Native Yjs: the insert into a tombstoned parent silently drops. We probably want to detect this too. **Default: extend the watcher to also observe the prospective destination parent.** Add to scope or split into a follow-up? Marlin to decide.
- Edge case: remote user moves the dragged node to a different parent (not deletes). Yjs serializes both reparents. Whichever lands second wins. Is this a "conflict to surface" or "silent reconciliation"? **Default: silent (the user's drop simply lands at the latest parent state).** Confirm.

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (section 3 conflict table, caveats section)
- Memory: `feedback_no_chrome_devtools_for_dragdrop.md` (drag verification = manual)
- Code touchpoints: `src/lib/drag/DragManager.ts`, `src/stores/EditorUIStore.ts`, `src/components/sidebars/right/`
