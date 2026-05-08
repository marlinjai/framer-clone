---
type: plan
status: draft
title: Event Layer & Activity Feed
summary: Add a semantic event layer between MST actions and patches, so the project gains an activity feed and audit trail without disturbing the existing patch-based undo/redo.
tags: [mst, history, events, activity-feed, audit, persistence]
date: 2026-05-02
---

# Event Layer & Activity Feed

## Goal

Add a **semantic event layer** alongside the existing MST patch capture, so the project can grow an activity feed and audit trail without touching the working undo/redo system. Designed to **survive a future Yjs / CRDT migration** (Phase 4 collab), because events are domain facts and outlast whatever state container we pick.

For the conceptual background, see the Obsidian note: *Activity Feeds and Audit Trails for MST Visual Builders* (in `ChatGPT Research/Software Engineering/Visual Editor/`).

## Current state

The history pipeline is already in good shape. Today we have:

- **Semantic MST actions:** `moveTreeComponent`, `insertRegistryComponent`, `updateResponsiveStyle`, `deleteComponent`, etc.
- **`HistoryStore`** with `createActionTrackingMiddleware2` + `recordPatches`.
- **`HistoryEntry`** shape: `{ id, actionName, timestamp, patches, inversePatches }` (max 500 entries, in-memory only).
- **Gesture batching:** `startBatch(name)` / `commitBatch()` / `cancelBatch()` collapses 60fps drag patches into one entry.
- **Scope discipline:** `EditorUIStore` and `TransformContext` deliberately outside history middleware.
- **Undo/redo:** `applyPatch(target, inversePatches.reverse())`.

What's **not** there:

- No event objects. Only patches and an `actionName` string.
- No `actorId`, no `requestId`, no `source`.
- No persistence. Volatile, 500-entry cap.
- No activity feed. No audit trail. No mention of either in any plan.

## Proposal

Add a **second middleware** (or a parallel concern in the existing one) that emits structured events on action finish, in lockstep with patch capture. Events are routed to an `EventLog` store and (later) flushed to a backend.

```
MST action runs
  ├─ existing: recordPatches → HistoryEntry → undo/redo
  └─ new:     buildEvent     → EventLog     → activity feed + audit trail
```

The two paths share the same trigger (action finish) and the same batching boundary (gesture commit), so they stay in lockstep without coupling.

## Event schema

```ts
type DomainEvent = {
  id: string                       // uuid
  type: string                     // "component.moved", "project.renamed"
  actorId: string                  // session-scoped until auth lands
  entityType: "project" | "page" | "component" | "breakpoint"
  entityId: string
  before: Record<string, unknown>  // relevant fields, not full snapshot
  after: Record<string, unknown>
  timestamp: string                // ISO8601
  requestId: string                // groups events from one user action
  source: "ui" | "api" | "agent" | "system"
  metadata?: Record<string, unknown>
}
```

Event types follow the convention `<entity>.<verb>` in past tense:

```
project.created
project.renamed
project.deleted
page.added
page.removed
component.inserted
component.moved
component.deleted
component.style_updated
breakpoint.activated
```

These map 1:1 with current MST actions, with the addition of any system-triggered actions (AI page generation, imports).

## Middleware design

```ts
const eventEmittingMiddleware = createActionTrackingMiddleware2({
  filter: (call) => isDomainAction(call.name),
  onStart: (call) => ({
    requestId: call.context?.requestId ?? newRequestId(),
    actorId: getActorContext().id,
    before: captureBefore(call),
  }),
  onFinish: (call, error, ctx) => {
    if (error) return
    const event = buildEvent(call, ctx)
    rootStore.eventLog.append(event)
  },
})
```

Runs alongside the existing history middleware. Order matters: history captures patches first (so it has the inverse), then events are emitted from the post-action snapshot.

For gesture-batched actions (drag, resize), the middleware skips per-frame events and emits **one** event on `commitBatch()`, aligned with the single `HistoryEntry`.

## EventLog store

Sibling to `ProjectStore`, **not** inside it:

```ts
const EventLog = types
  .model({
    events: types.array(DomainEventModel),
    pendingFlush: types.array(types.string), // event ids
  })
  .actions(self => ({
    append(event) { ... },
    markFlushed(ids) { ... },
  }))
  .views(self => ({
    forEntity(entityId) { ... },
    forActor(actorId) { ... },
    recent(limit = 50) { ... },
  }))
```

Why sibling and not nested in `ProjectStore`:

- Events shouldn't bloat project snapshots used for export/save.
- Events have a different lifecycle (append-only, eventually flushed to backend).
- Keeps the project tree's snapshot stable for AI tool-call use cases (the AI page generation plan relies on clean snapshots).

A derived view inside `ProjectStore` can expose `recentActivity` for the activity feed UI without coupling.

## Persistence boundary

**Defer the actual backend.** This plan is in-memory + ready-to-flush. The flush hook is the same one the drag plan named: "one persistence write per batch commit".

When persistence lands:

1. `flushPendingEvents()` posts the `pendingFlush` queue to the backend.
2. Backend appends to an `events` table (Postgres, append-only, indexed on `entityId` and `actorId`).
3. On success, `markFlushed(ids)` clears the queue.
4. On failure, retry with backoff. Events are idempotent by `id`.

For offline support, the queue persists to IndexedDB. Events remain orderable by `timestamp` + `id` even across reconnects.

## Activity feed UI

Out of scope for this plan, but designed to plug in trivially:

- Read `rootStore.eventLog.recent(50)` (or `forEntity(currentProject.id)`).
- Render via `observer` so emissions repaint the feed automatically.
- Format with a small `eventToString(event)` mapper for human-readable strings.

## Relationship to Phase 4 collab

The drag plan (2026-04-19) is explicit: real-time collab is Phase 4, options are MST + Yjs bridge or Yjs-native rewrite. Either way, the event layer survives:

- **MST + Yjs bridge:** Events still emit from MST actions. Yjs syncs the underlying state.
- **Yjs rewrite:** Events emit from whatever command layer wraps Yjs. Same event schema.

This is the wedge: **events are domain facts, patches are state mechanics**. Patches don't migrate. Events do. Adding events now buys forward compatibility.

## Out of scope

- Backend storage choice (Postgres vs dedicated event store).
- Activity feed UI implementation.
- Audit trail UI / permissioning / compliance features.
- Real-time multi-user coordination.
- CRDT integration.
- Auth (we use a session-scoped `actorId` until real auth lands).

## Open questions

1. **Actor identity before auth.** Session-scoped uuid stored in localStorage, or block all events until a project login lands? Bias: session uuid, rewrite once auth ships.
2. **Schema strictness.** Strict typed unions per event type, or generic payload bag? Bias: strict per-type, with a generic `metadata` escape hatch.
3. **Capturing `before`.** For some actions (move, style update) `before` is straightforward. For destructive actions (delete) we need to snapshot before mutation. Hook into `onStart` of the middleware, not `onFinish`.
4. **System-triggered events.** AI page generation produces many actions in one logical operation. One event per action, or one rollup event with a child list? Bias: one rollup event with `metadata.children`.
5. **Where the event log persists in dev.** IndexedDB from day one, or memory-only until backend lands? Bias: memory-only initially (matches current HistoryStore), add IndexedDB when first user-visible feed ships.

## Sequencing

A reasonable order if/when this gets picked up:

1. Add `DomainEventModel` and `EventLog` store. No middleware yet. Manual emit from a single action to validate shape.
2. Add the event-emitting middleware. Cover all current domain actions.
3. Wire `requestId` and `actorId` (session uuid for now).
4. Hook into gesture batching: one event per `commitBatch()`.
5. Add a minimal activity feed UI panel (debug-only) reading from `eventLog.recent(50)`.
6. Defer: persistence, backend, real activity feed UX.

Steps 1 to 4 are the meaningful foundation. Steps 5 and 6 are downstream once the layer exists.
