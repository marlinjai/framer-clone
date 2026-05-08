---
name: multiplayer-presence-awareness
track: multiplayer
wave: 2
priority: P1
status: draft
depends_on: [multiplayer-yjs-mst-binding-full]
estimated_value: 7
estimated_cost: 5
owner: unassigned
---

# Presence and awareness (cursors, selections, viewport)

## Goal

Add Figma-style live presence: other users' cursors on the canvas, their current selection rectangles, their viewport (where they're looking), and an avatar list in the top bar. Built on Yjs `awareness` protocol, NOT on the persistent Y.Doc, because presence is ephemeral and shouldn't pollute history or persistence. Lives in a new `PresenceStore` outside MST and outside the Y.Doc.

## Scope

**In:**
- New `PresenceStore` in `src/stores/PresenceStore.ts`. MobX store (or MST volatile model). Holds:
  - `localState: { cursor: {x,y} | null, selectionId: string | null, viewport: {x,y,zoom}, color: string, name: string, avatarUrl?: string }`.
  - `remotePeers: Map<clientId, { ...sameShape, lastSeenAt: number }>`.
- Wire to `awareness` from `HocuspocusProvider`:
  - On local cursor move (canvas pointer events), throttle to 30Hz, call `awareness.setLocalStateField('cursor', { x, y })`.
  - On selection change (`EditorUIStore.setSelectedComponentId`), update `awareness.setLocalStateField('selectionId', id)`.
  - On canvas viewport pan/zoom, throttle to 10Hz, update `awareness.setLocalStateField('viewport', ...)`.
  - On `awareness.on('change')`, update `remotePeers` map.
- Color assignment: deterministic hash of `userId` to a curated palette (8 distinct colors), so the same user gets the same color across sessions.
- Canvas overlay layer at `src/components/multiplayer/PresenceLayer.tsx`:
  - Renders one `<RemoteCursor>` per peer at their `cursor` position.
  - Renders a colored selection rectangle around the component the peer has selected.
  - Renders a faint colored rectangle showing the peer's viewport bounds (Figma calls this the "follow" hint).
- Top bar avatars at `src/components/multiplayer/PresenceAvatars.tsx`. Click an avatar to "follow" that peer (smoothly pan canvas to match their viewport).
- Avatar identity comes from the auth-brain session (`user.name`, `user.email`, optional `user.avatarUrl`). When auth is stubbed (wave 1), use a fallback "Guest <clientId-shortened>".
- A `useFollowPeer(peerId)` hook that, while active, syncs the local viewport to the peer's viewport (read-only; the local user can break out by panning manually).
- Remove peers from `remotePeers` after 30s of inactivity (the websocket disconnect handler also clears them, this is a fallback).

**Out (explicitly deferred):**
- Voice / video chat (Phase 2).
- Comment threads (Phase 2 CMS-adjacent feature).
- "Follow me" mode where the broadcaster forces all viewers to track them (Phase 2).
- Drag ghost broadcasting (other users see your drag in progress before you commit). Researchable for Phase 2; v1 ships static cursors only because broadcasting volatile drag state needs a separate channel design.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/stores/PresenceStore.ts` | new | MobX store. |
| `src/stores/RootStore.ts` | edit | Wire `PresenceStore` alongside `EditorUIStore`. Reset on project switch. |
| `src/components/multiplayer/PresenceLayer.tsx` | new | Canvas overlay. |
| `src/components/multiplayer/RemoteCursor.tsx` | new | Single cursor render. |
| `src/components/multiplayer/PresenceAvatars.tsx` | new | Top bar avatars + follow click. |
| `src/components/multiplayer/useFollowPeer.ts` | new | Hook to sync local viewport to peer viewport. |
| `src/components/Canvas.tsx` | edit | Mount `PresenceLayer` above the canvas, below HUD. |
| `src/components/TopBar.tsx` | edit | Mount `PresenceAvatars` next to history dropdown. |
| `src/lib/multiplayer/awareness.ts` | new | Throttling + serialization helpers for awareness fields. |
| `src/lib/multiplayer/peerColors.ts` | new | Deterministic color hash. |

## API surface

```ts
export interface PeerState {
  clientId: number;
  userId: string;
  name: string;
  avatarUrl?: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selectionId: string | null;
  viewport: { x: number; y: number; zoom: number };
  lastSeenAt: number;
}

export interface PresenceStoreInstance {
  localState: PeerState;
  remotePeers: Map<number, PeerState>;
  setCursor(x: number | null, y?: number): void;
  setSelection(id: string | null): void;
  setViewport(v: { x: number; y: number; zoom: number }): void;
  followPeer(clientId: number | null): void;
  followingClientId: number | null;
}
```

## Data shapes

```ts
// awareness.getLocalState() shape:
{
  user: { id, name, avatarUrl?, color },
  cursor: { x, y } | null,
  selectionId: string | null,
  viewport: { x, y, zoom },
}
```

Awareness updates are NOT persisted. They flow over the same WebSocket connection but are not part of the Y.Doc, so they don't trigger `onStoreDocument`.

## Test plan

- [ ] Unit: `peerColors.ts` returns deterministic, distinct colors for the same `userId`.
- [ ] Unit: throttle helpers correctly cap update rate (use `vi.useFakeTimers`).
- [ ] Unit: `PresenceStore` adds, updates, removes peers in response to simulated awareness events.
- [ ] Unit: a peer that hasn't been seen in 30s is GC'd from `remotePeers`.
- [ ] Integration: two-tab manual smoke. Tab A's cursor visible in tab B with correct color. Selecting a component in tab A shows a colored selection outline in tab B.
- [ ] Manual: click another user's avatar in the top bar, viewport pans to match theirs. Pan manually, follow disengages.
- [ ] Manual: kill tab A, peer removed from tab B's avatar list within ~5s (websocket disconnect signal).

## Definition of done

- [ ] PresenceStore lands and typechecks.
- [ ] All overlays render correctly in two-tab smoke.
- [ ] No regressions in canvas pan/zoom.
- [ ] Performance budget: with 5 active peers, no measurable frame drop on the canvas during continuous mouse movement.
- [ ] Status field moved to `done` in STATUS.md.

## Open questions

- Should presence work without auth-brain (i.e. when running in stub mode)? **Default: yes,** stub mode synthesizes guest names. Important for local dev usability.
- Cursor render: rAF or React state? React state at 30Hz throttle is probably fine; rAF reduces React reconciler pressure but adds complexity. **Default: React state + throttle.** Revisit if jank shows.
- "Follow" UX detail: when followed peer's viewport changes, do we tween or jump? **Default: tween over 200ms with `linear` easing.** Marlin's call.
- Should remote drag ghosts be in scope or explicitly deferred? Research plan section 3 lists "drag-while-remote-reparent" as custom logic but doesn't mandate live drag ghost broadcasting. **Defer to Phase 2.** Confirmed.

## References

- Plan: `docs/plans/2026-05-05-editor-multiplayer-research.md` (section 6c phase 3)
- External: https://docs.yjs.dev/getting-started/adding-awareness
- External: https://github.com/nimeshnayaju/y-presence (React presence patterns)
- Code touchpoints: `src/stores/EditorUIStore.ts` (sibling store), `src/components/Canvas.tsx`
