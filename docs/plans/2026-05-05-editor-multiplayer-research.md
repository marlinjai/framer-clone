---
title: Editor Multiplayer Research for Framer-Clone
type: plan
status: draft
date: 2026-05-05
tags: [research, multiplayer, crdt, yjs, liveblocks, framer-clone, phase-1]
projects: [framer-clone, auth-brain]
summary: Research session evaluating Yjs vs Automerge vs Liveblocks vs Hocuspocus for real-time multi-user editing in framer-clone. Recommendation: self-hosted Hocuspocus + Yjs with MST as a derived projection (Yjs canonical, MST view), websocket auth via auth-brain SDK, Postgres persistence, defer for 2 to 3 months until auth-brain v1 ships.
---

# Editor Multiplayer Research for Framer-Clone

> Strategic research doc. Not a build plan. Captures whether and how framer-clone should add Figma-style multi-user editor collaboration. Conclusion at the bottom.

## Why this is on the table

Three forces:

1. **Phase 1 parity.** Marlin's strategic thesis (`memory/project_strategic_thesis_bubble_killer.md`) positions framer-clone as a Framer-quality builder. Framer has live multi-user editing. Figma has it. Webflow has it for its Editor. Notion has it. Bubble has a limited form. A visual builder pitched at teams that does not have multiplayer is dead in any 2026 sales conversation that involves more than one buyer.
2. **Auth-brain is finally arriving.** The v1 spec at `projects/lumitra-infra/auth-brain/docs/superpowers/specs/2026-05-06-auth-brain-design.md` gives us cookie-based SSO across `*.lumitra.co`, dedicated workspace memberships, and a permission SDK. Without that, multiplayer has no identity layer to authenticate websockets against. With it, we have the seam.
3. **Architecture is favorable.** The canvas tree (`src/models/ComponentModel.ts:77-110`) is already a normalized, framework-neutral data model: nodes with `type`, `props`, `children`, `parentId`, breakpoint resolution. This is the shape CRDTs are good at. The harder question is how MST and a CRDT coexist, not whether the data is suitable.

The cost of adding multiplayer 2026-late vs 2027-mid is roughly the same in code, but the cost in customer perception is large. A team that sees framer-clone as single-player won't come back for a "we added multiplayer" announcement.

## Current architecture relevant to multiplayer

Useful before evaluating libraries:

- **Canvas tree** is a recursive MST model (`src/models/ComponentModel.ts`). Mutations go through actions: `addChild`, `removeChild`, `updateResponsiveStyle`, `setTextContent`, `setCanvasPosition`, etc. Every mutation produces JSON patches via the action middleware.
- **History** is an MST middleware (`src/stores/HistoryStore.ts`) that records `recordPatches()` output per action, with gesture batching for drag/resize (`startBatch` / `commitBatch`). Crucially, history is scoped to `projectStore` via `setTargetStore` (line 89), and undo replays inverse patches (line 165-175). This is a single-user history model.
- **Drag manager** (`src/lib/drag/DragManager.ts`, 462 lines) is volatile, lives outside `projectStore`, and only commits its mutations through `historyStore.startBatch` / `commitBatch` (`src/stores/RootStore.ts:43-47`). This separation is already correct for multiplayer: live drag state should not be CRDT-synced (too noisy), only the final commit should be.
- **Editor renderer** wraps `mobx-react-lite`'s `observer` HOC. Re-renders on MST mutations. Whatever multiplayer shape we pick has to keep this property: a remote write must surface as a normal MobX reaction, not a forced React tree rebuild.
- **EditorUI store** holds ephemeral selection / tool state. It is correctly outside `projectStore` and outside history scope. This is also the right place to put **presence** (other users' cursors, selection rectangles) because they don't belong in the persisted document.

Key takeaway: the existing split (persisted MST vs volatile UI vs volatile drag) maps cleanly onto multiplayer's split (CRDT-synced document vs awareness/presence vs local-only state). We do not have to refactor that boundary; we have to plug a CRDT into the MST half.

## Research question 1: CRDT library choice

### 1a. Yjs

Mature open-source CRDT library, MIT-licensed, ~17k GitHub stars, the de-facto JS CRDT for the last 5 years. Ships `Y.Map`, `Y.Array`, `Y.Text`, `Y.XmlElement`, `Y.UndoManager`, `awareness` protocol. Used by Notion, Evernote, JetBrains, Tldraw, Affine, BlockNote, Tiptap. The data structures match what framer-clone needs:

- Node tree: `Y.Map` per node, with `props` as nested `Y.Map`, `children` as `Y.Array<Y.Map>`.
- Inline text editing: `Y.Text` for the `children` string of text nodes. Last-writer-wins on the whole prop is also fine for v1, since two people typing the same word at the same time is rare in a builder UI (they're usually on different elements).
- Awareness: separate from the doc, used for presence (cursor, current selection, viewport).

Cons: no managed sync server. You self-host (typically Hocuspocus). Memory grows with edit history unless you snapshot/compact (the Linux-kernel Yjs doc is 13.8 GB in memory). For framer-clone documents (a page is maybe 50 to 200 nodes; a project is maybe 10 pages), this is well below any concerning threshold. We are not building Google Docs.

### 1b. Automerge

Alternative CRDT. Apache-2.0. Different conflict semantics (Automerge uses an "actor ID per change" model with richer history queries). Mature in Rust (`automerge-rs`), with JS bindings. Smaller ecosystem than Yjs. Does NOT have the integration density Yjs has: no equivalent to Tiptap, no equivalent to BlockNote, no Liveblocks integration. Awareness/presence not built-in (you build it on top).

Verdict: technically excellent, but the network effect is on Yjs. Picking Automerge in 2026 means writing more glue code for the same outcome. Skip.

### 1c. Liveblocks

Commercial managed service. Not a CRDT itself: Liveblocks' "Storage" is a proprietary tree-CRDT-like sync engine, OR you can use their Yjs-hosted product (which IS Yjs, just hosted on their infra with a Liveblocks `LiveblocksProvider` instead of a `WebsocketProvider`). Both options are paid.

Pricing (verified at https://liveblocks.io/pricing on 2026-05-05):

| Tier | Base | Overage |
|------|------|---------|
| Free | $0/mo | 500 monthly active rooms cap |
| Pro | $30/mo + usage | $0.03/room over 500, $10/seat/mo over 3 |
| Team | $600/mo + usage | $0.03/room, $10/seat/mo |
| Enterprise | Custom | SAML, multi-region, advanced perms |

Session minutes are billed at $0.002 each (two users in a room for 5 minutes = 10 session minutes = $0.02).

Cost estimate for 10000 MAU at framer-clone scale (rough math):
- Assume each MAU is in a room avg 30 minutes per day, 20 days per month. That's 600 minutes per user per month, 6 million session minutes total.
- At $0.002/session-minute, that's ~$12000/month JUST in session minutes.
- Plus the rooms overage: assume 1000 customers x 5 active projects = 5000 rooms over the 500 included. $0.03 x 4500 = $135/mo. Negligible vs session-minute spend.
- Realistic estimate: **$10000 to $15000/month at 10000 MAU** with collaborative usage patterns.
- More likely real-world (lower co-presence, fewer connected minutes): $3000 to $6000/mo.

That is a real line item for a small team and it grows linearly. Liveblocks is genuinely good infrastructure, the React/TS DX is the best in market, the DevTools extension is a real productivity gain, and the engineering effort to onboard is one or two days. But the unit economics scale against us as the customer base grows. We can move to Liveblocks later if self-hosting bites operationally; we cannot easily move OFF Liveblocks once we're locked into their proprietary primitives.

Critically: if we use Liveblocks-Yjs (rather than Liveblocks-Storage), we keep portability. The Yjs document is the same; only the provider changes. That means "start on Liveblocks, move to Hocuspocus if costs explode" is actually viable. This is a real escape hatch.

### 1d. Hocuspocus

Self-hostable Yjs sync server from the Tiptap team. MIT, latest is v4.0 (April 2026), 93 releases, 2.2k stars, sponsored by Tiptap, Cargo, Ahrefs. Production-ready. Architecture:

- **Core server**: Node.js websocket server, plug-and-play with `WebsocketProvider` from `y-websocket`.
- **`@hocuspocus/extension-database`**: persistence to any DB (Postgres, SQLite, anything via a `fetch`/`store` callback pair).
- **`@hocuspocus/extension-redis`**: pub/sub across multiple Hocuspocus instances. Doesn't persist; it's only for horizontal scaling. Combine with the database extension.
- **`@hocuspocus/extension-webhook`**: emit events to external services (audit log, search index, AI pipeline).
- **Hooks**: `onAuthenticate`, `onConnect`, `onChange`, `onLoadDocument`, `onStoreDocument`, `beforeHandleMessage`, `onDisconnect`, etc. The `onAuthenticate` hook is the seam for auth-brain (see RQ4).

Operational shape: one Coolify-deployed Node.js service on Hetzner, Postgres for persistence (we already run multiple Postgres instances in this stack), Redis if/when we need to scale to >1 instance. The first instance handles a lot of rooms because Yjs sync is cheap on the server side: the server is mostly relaying compact binary updates and writing snapshots periodically.

### 1e. Decision matrix

| Library | License | Cost @ 10k MAU | Self-host effort | TS/React DX | MST compat | Persistence | Presence | Verdict |
|---------|---------|----------------|------------------|-------------|------------|-------------|----------|---------|
| Yjs raw + custom WS | MIT | ~$50/mo (Hetzner) | High (3 weeks) | Good (manual) | Manual | Manual | Manual | Don't, just use Hocuspocus |
| Yjs + Hocuspocus | MIT | ~$50 to $100/mo (1 to 2 Hetzner nodes + Postgres) | Medium (1 week) | Good (mature) | Via projection layer | `@hocuspocus/extension-database` | Yjs `awareness` | **Recommended** |
| Yjs + Liveblocks-Yjs | Mixed | ~$3k to $15k/mo | Zero | Best in class | Same as Yjs | Managed | Built-in | Reasonable v1 if effort budget is the binding constraint |
| Liveblocks Storage (proprietary) | Commercial | Same as above | Zero | Best in class | Custom binding work | Managed | Built-in | Avoid: vendor lock-in on a non-portable data model |
| Automerge | MIT | ~$50/mo | Medium | Good | Manual, no precedent | Manual | Manual (build it) | Skip: smaller ecosystem |

**Choice: Yjs + Hocuspocus self-hosted.** Liveblocks-Yjs is the fallback if Hocuspocus ops bite us in the first 6 months. Liveblocks Storage is rejected because it locks the data model.

## Research question 2: MST integration with CRDT

This is the load-bearing architectural decision. There are three real shapes.

### 2a. Shape A: Replace MST entirely with Yjs

Tear out MST. Yjs is the canonical store. React reads via `useY` hooks (from `react-yjs` or hand-rolled). Mutations are Yjs operations directly.

Pros: clean. One source of truth. No sync layer. No drift between MST and Yjs.

Cons: massive rewrite. The MST tree has a well-tested history middleware, parent-relation tracking, computed views (`getResolvedProps`), action discipline, and middleware integrations (HistoryStore via `addMiddleware`). All of that has to be re-implemented over Yjs. Plus, every observer-wrapped component has to be re-wired (Yjs has its own `observe()` API that does NOT plug into MobX reactions; it would need a manual MobX wrapper). Estimated effort: 4 to 6 weeks. Risk: rewriting working code, regression surface huge.

Verdict: too expensive for the value. Reject.

### 2b. Shape B: Dual source of truth

Keep MST for local mutations. After every MST action, mirror the patch into Yjs. Listen to Yjs updates and apply them to MST. Both stores try to stay in sync.

Pros: "incremental".

Cons: this is the worst option. Two sources of truth means two reconciliation paths, two undo histories that disagree, three classes of bugs that are hard to reproduce, and an observable race condition every time a remote update lands during a local action. Anyone who has built this shape (Marlin himself in `data-table` early days, multiple production teams cited in the Yjs forum) ends up moving to Shape A or Shape C within 6 months.

Verdict: reject. Recognized anti-pattern.

### 2c. Shape C: Yjs canonical, MST as derived projection

Yjs is the truth. MST is rebuilt from Yjs on every Yjs update via a binding layer. Local mutations go: user action → write to Yjs → Yjs observer reaction → diff into MST → MobX reactions fire → React re-renders.

This is what `mobx-bonsai-yjs` does (separate package, two-way binding via `bindYjsToNode`), and what `syncedstore` does at a higher level (it's a wrapper that gives you a MobX-compatible facade on top of Yjs). For framer-clone the `syncedstore` shape is closer to what we want, because it's already designed for "build your own model layer over Yjs with MobX-style reactivity".

But our specific requirement is harder: we have an existing MST tree with computed views, action discipline, parent tracking, and history middleware. We can't just throw `syncedstore` at it.

The realistic path:

1. **Define a Yjs schema** that mirrors `ComponentModel`'s persisted fields. `Y.Map` per node, keyed by component ID. `Y.Array<string>` for children (ID references), not nested `Y.Map`s, to avoid pathological flatten/unflatten cost.
2. **Build a `YjsMstBinding` class.** On Yjs `observeDeep`, it walks the diff and applies MST patches via `applyPatch` (`mobx-state-tree` already exposes this). On MST patch emission (the same recordPatches infrastructure HistoryStore uses), it translates patches into Yjs operations inside a `Y.Doc.transact()` call.
3. **Make MST actions write to Yjs first, then let the Yjs observer apply back.** This is the trick. Instead of "MST action mutates MST and Yjs in parallel", we do "MST action mutates Yjs, Yjs observer mutates MST". The MST tree is purely a downstream projection. The action surface stays the same to consumers (`tree.addChild(child)` still works), but internally it routes through Yjs.
4. **Keep `EditorUIStore` and the drag manager outside the binding.** They are local-only.

Pros: editor code (renderers, observer-wrapped components, MobX selectors) does NOT change. The Yjs layer is invisible to the React tree.

Cons: the binding layer is real engineering. Estimated 1.5 to 2 weeks for a working v1 covering the current MST schema. Plus another 1 to 2 weeks of stabilization (edge cases, transaction batching, conflict semantics). Edge cases: floating elements with `canvasX`/`canvasY` (number-typed, last-writer-wins), per-breakpoint responsive maps (nested object replacement, not array operations), `setTextContent` (we want fine-grained `Y.Text` not whole-string LWW eventually, but v1 can be LWW).

**Verdict: Shape C. This is the only sane path.** It's how Affine, BlockNote, and Tldraw all bind their internal models to Yjs. None of them use raw Yjs throughout their codebase; they all have a typed model layer that the renderer reads from, with Yjs as the sync engine underneath.

### 2d. What about syncedstore?

`syncedstore` (https://syncedstore.org) is exactly the shape we want: it gives you a typed, MobX-aware reactive store backed by Yjs. The catch: it's structurally a peer of MST, not a layer on top of MST. Using `syncedstore` would mean migrating off MST. That's basically Shape A by another name, and we've already rejected Shape A.

But: `syncedstore` is a useful reference implementation for the binding layer we'd build in Shape C. Its source code shows how to structure the Y.Map -> reactive object translation. Worth reading before writing the binding.

### 2e. What about mobx-bonsai-yjs?

`mobx-bonsai` is a competitor to MST (lighter, no `types.model` overhead) with first-class Yjs binding via `bindYjsToNode`. If we were starting from scratch, this would be a strong contender. But we're not: we have an existing MST tree with shipped features, custom history, and a working observer-wrapped renderer. Migrating from MST to mobx-bonsai is a sideways move with no clear win.

Worth knowing exists. Not the path here.

## Research question 3: Conflict resolution semantics

Concrete operations and what Yjs gives us natively, versus what we have to add.

| Operation | Yjs handling | Custom logic? |
|-----------|--------------|---------------|
| Two users edit the same prop on the same component | `Y.Map.set` is last-writer-wins per key (logical timestamp). Both writes propagate, the later one wins. | None. LWW is the right semantic. |
| Two users edit different props on the same component | Both writes succeed. Map merge. | None. |
| Two users drag the same component to different parents | `Y.Array.delete(oldIdx) + Y.Array.insert(newParent, idx, ref)` from each user. Yjs serializes; one reparent wins, the other is a no-op (the source parent's array no longer contains the moved ID). The losing user's drag is silently rejected. UI must reconcile by snapping the ghost back. | **Yes.** Drag manager has to listen for "the component I'm dragging just left my source array via a remote update" and cancel/rewind the local drag. Detection is feasible (Yjs `observe` on the source parent's children array). Worth ~2 days of polish. |
| One user deletes a component while another is editing its props | Remote `Y.Map` no longer in tree, local prop write goes to a tombstoned map (Yjs supports this gracefully, but the prop is dropped on the next snapshot). | **Yes**, but small. Local user sees their write disappear; toast: "Component was deleted by Marlin". Detection: prop write target's parent chain no longer reaches root. |
| Two users add children to the same parent at the same index | `Y.Array.insert(idx, [refA])` + `Y.Array.insert(idx, [refB])` resolve via Yjs's interleaving algorithm. Both inserts land, ordered by client ID. | None. Yjs gets this for free. The result is "both children present, deterministic order", which is what users expect. |
| Two users undo their own last action | Per-user `Y.UndoManager` with `trackedOrigins: [myClientId]`. Each user's undo only reverses their own changes. | **Yes.** Cannot reuse the existing `HistoryStore` middleware as-is. Undo has to be Yjs-native. The MST `HistoryStore` becomes a per-user view on top of `Y.UndoManager`, which captures the same data (a stack of inverse operations) but scoped per origin. |
| User A drags during user B's typing | Yjs serializes both. Drag commits via `Y.Array` ops, type via `Y.Map.set` on `props.children`. They don't conflict. | None. |
| Floating element X/Y both edited by two users simultaneously | Both `canvasX` writes hit `Y.Map`. Last writer wins. The "loser" sees their drag snap to the winner's position. | Acceptable. Native Yjs LWW is fine. |
| Inline text editing at the character level | `Y.Text` would give Google-Docs-style char-level merge. Today `setTextContent` does whole-string replacement. | **Optional improvement, not v1.** v1 keeps `props.children` as a string under LWW. v2 migrates text-bearing components to `Y.Text`. |

The summary: Yjs gives us 80% of the semantics for free. The 20% we own is (a) drag-cancellation when a remote user reparents the dragged node mid-drag, (b) toast/recovery when the locally-edited node is deleted remotely, and (c) per-user undo wiring. None of those are research blockers; they are well-trodden patterns.

## Research question 4: Websocket auth via auth-brain

### 4a. The flow

```
Browser editor
  -> opens WS connection to wss://collab.lumitra.co/ws?project=<projectId>
  -> sends cookies (lumitra_session is on .lumitra.co, included automatically since collab.lumitra.co is in scope)

Hocuspocus server (Node.js, Coolify on Hetzner)
  -> onAuthenticate hook fires with the connection params + headers
  -> reads `lumitra_session` cookie from headers
  -> calls auth-brain-sdk.verifySession(cookie)  // see auth-brain spec section 3.4
  -> verifySession returns { user, workspaces[], active_workspace }
  -> server calls auth-brain-sdk.can(user, "project.edit", { type: "project", id: projectId, workspaceId })
  -> if allowed: connection joins the room (room name = projectId), user object stored on the connection context
  -> if denied: connection rejected with code 4401 (custom unauthorized close code)
```

Reference: `auth-brain-design.md` section 1.6 (apps NEVER query memberships directly, always go through the SDK), section 3.4 (session verification: cookie -> verify endpoint -> user + memberships), section 3.5 (permission check via OpenFGA).

### 4b. Where this lives

A new package in the framer-clone monorepo (or the lumitra-infra monorepo): `framer-clone-collab-server`. Single Node.js entry, imports `@hocuspocus/server`, `@hocuspocus/extension-database`, `@marlinjai/auth-brain-sdk`. The `onAuthenticate` hook is ~30 lines:

```ts
// Pseudocode, NOT for implementation. Sketch only.
import { Server } from '@hocuspocus/server';
import { Database } from '@hocuspocus/extension-database';
import { authBrain } from '@marlinjai/auth-brain-sdk';

const server = Server.configure({
  extensions: [
    new Database({ /* fetch + store hooks against Postgres */ }),
  ],
  async onAuthenticate({ documentName, requestHeaders, token }) {
    const cookie = requestHeaders.cookie ?? token;
    const session = await authBrain.verifySession(cookie);
    if (!session) throw new Error('Unauthorized');

    const projectId = parseProjectId(documentName);
    const workspaceId = await lookupWorkspaceForProject(projectId);
    const allowed = await authBrain.can(
      session.user,
      'project.edit',
      { type: 'project', id: projectId, workspaceId },
    );
    if (!allowed) throw new Error('Forbidden');

    return { user: session.user, workspaceId };
  },
});
```

The `permissions.ts` file in framer-clone (per auth-brain spec section 1.6, item 3: each app declares actions in a permission registry) gets a `project.edit` action requiring `workspace.member`.

### 4c. Cookie scope considerations

The auth-brain cookie is `Domain=.lumitra.co`. It's automatically sent on a websocket connection to `collab.lumitra.co`. No CORS issues because websockets don't enforce CORS the same way (they use `Origin` header validation, which we set on the server). One caveat: in dev, cookies on `localhost` are not on `.lumitra.co`, so the local dev server has to support a fallback "session token in connection params" path for unit tests.

### 4d. Caching

`verifySession` results can be cached for 30s in the Hocuspocus process per auth-brain spec section 3.4. Since a single editor session establishes one websocket and stays connected for the duration, this is mostly relevant for the initial auth check, not for repeated verification. We don't need a session cache in v1.

### 4e. Disconnect on permission revocation

If a user is removed from the workspace, their next page load doesn't get them back in. But existing websocket connections stay alive until the session expires or the connection drops. For v1, this is acceptable: the cookie revocation flow (auth-brain section 3.6) won't propagate to live websockets. v2 should add a CDC-driven disconnect (auth-brain emits a CDC event on membership change; the collab server listens and force-closes affected connections).

## Research question 5: Persistence and history

### 5a. Persistence

Yjs documents need to be stored so reconnecting users get the latest state. Three options, ranked:

**Option 1: Hocuspocus + `@hocuspocus/extension-database` against Postgres.** A single `documents` table with `(id text primary key, data bytea, updated_at timestamptz)`. Hocuspocus calls `fetch` on first connection, calls `store` on every change (debounced, configurable interval, default ~2s). For 1000 customers x 10 projects each = 10k documents at maybe 100KB each compressed, this is 1GB total. Trivial Postgres. We already run Postgres in the suite (auth-brain, Storage Brain, etc.). One more DB instance or one more schema.

**Option 2: S3/Hetzner storage with periodic snapshots.** Snapshot the Yjs doc to object storage every N minutes. Cheap at scale but adds latency on cold-start (download from S3). Reasonable for archival, bad for hot reconnects.

**Option 3: Liveblocks managed.** Don't operate any of this. They store it. Fine if we go Liveblocks; not on the table for self-hosted.

**Choice: Option 1.** Postgres + Hocuspocus database extension. Add an offline snapshot job to Hetzner storage as a backup (weekly, gzipped, retention 90 days). Total ops burden: a Postgres instance and a backup script. Zero novel infrastructure.

### 5b. History interaction with HistoryStore

The existing `HistoryStore` (`src/stores/HistoryStore.ts`) is fundamentally a **per-document, single-user** undo stack. With multiplayer, this breaks: undoing a mutation that was made in concert with someone else's mutation can de-sync the document.

Yjs has `Y.UndoManager` which is built for this. It tracks per-origin operations, and `undo()` only reverses operations from origins listed in `trackedOrigins`. Per-user undo (Figma, Framer, Notion all do this) is one line: `new Y.UndoManager(yDoc.share, { trackedOrigins: new Set([myClientId]) })`.

Migration shape:

1. Keep `HistoryStore` working in single-user mode (when no Yjs binding is active). For local-only documents, the existing path is unchanged.
2. When the Yjs binding is active, `HistoryStore` becomes a thin facade over `Y.UndoManager`. Same public API (`undo`, `redo`, `canUndo`, `canRedo`, `startBatch`, `commitBatch`), different implementation underneath.
3. The action labels (`recordEntry(call.name, ...)`) we currently capture become Yjs UndoManager `metadata` values. `Y.UndoManager` supports stack-item metadata for exactly this use case.
4. Gesture batching maps to `Y.UndoManager.captureTimeout` (Yjs natively coalesces edits within a time window). This replaces the `startBatch` / `commitBatch` complexity for mouse-drag operations. We may keep the explicit batch API for ESC-to-cancel semantics.

Effort: 3 to 5 days to adapt `HistoryStore`. The interface stays. Toolbar undo/redo buttons don't change.

### 5c. Snapshots and version history

For "document timeline" (Figma's version history, Notion's page history), Yjs `Y.snapshot` and `Y.encodeStateVector` give us deterministic snapshots. Hocuspocus can be configured to write a snapshot every N minutes or per N changes. Storing 30 days of snapshots per project at 100KB each = 3MB per project. Negligible.

Not v1. Listed for completeness.

## Research question 6: Cost and operational realism

### 6a. Self-hosted Hocuspocus operational shape

- **Infrastructure**: 1 Hetzner Cloud VM (CX21, 4GB, ~5 EUR/mo), Coolify-managed. Postgres on existing instance or new ~5 EUR/mo VPS. Total: ~10 EUR/mo for the v1 single-instance shape.
- **Scaling**: Until ~500 concurrent connections per node, single instance is fine. Past that, add `@hocuspocus/extension-redis` and a second node behind a sticky load balancer. Each node still talks to the same Postgres. Yjs sync messages are small (binary updates, typically <1KB), so even a tiny VM handles a lot of rooms. Tiptap deploys this in production at much higher scale; the limiting factor is not Hocuspocus, it's Postgres write throughput on the snapshot interval.
- **What breaks first**: Postgres if we set the snapshot interval too aggressive. Default 2s debounce is fine; if we drop to 100ms we'd hammer the DB. Mitigation: don't.
- **Ops burden**: one more service in Coolify, one more Postgres schema, one alert if WS connection count exceeds a threshold. Maybe 4 hours per quarter of ongoing maintenance. Compatible with a 1-developer team.

### 6b. Liveblocks operational shape

- **Infrastructure**: zero. They run it.
- **Cost**: $30/mo to start, scaling toward $3k to $15k/mo at 10k MAU as estimated above. Very real money for a bootstrapped consultancy.
- **Lock-in**: low if we use Liveblocks-Yjs (the doc is portable). High if we use Liveblocks Storage (proprietary).
- **Verdict**: Liveblocks-Yjs is a reasonable v1 if we want to ship faster and de-risk ops. The migration path to self-hosted is "swap `LiveblocksProvider` for `HocuspocusProvider`, point at our own server, copy docs across in a one-shot migration script". Maybe a week of work when the time comes.

### 6c. Effort estimate for retrofit

| Phase | Work | Effort |
|-------|------|--------|
| 0 | Spike: build a tiny Yjs-backed prototype with two browsers editing one node. Validate Yjs<->MST binding shape on a stripped-down model. | 3 days |
| 1 | YjsMstBinding v1 covering current `ComponentModel` schema. Two-way sync, `Y.Doc.transact` boundaries, observer wiring. | 8 to 10 days |
| 2 | Hocuspocus server scaffold, auth-brain integration via `onAuthenticate`, Postgres persistence extension, deploy to Hetzner Coolify. | 5 days |
| 3 | Awareness/presence: cursor position, current selection, current viewport. New ephemeral store (`PresenceStore` outside MST), wired to `awareness.setLocalStateField`. UI: cursor avatars on canvas, sidebar avatar list, selection rectangle outlines in other users' colors. | 5 to 7 days |
| 4 | Per-user undo via `Y.UndoManager`, refactor `HistoryStore` as facade. Drag-conflict detection. Delete-while-editing recovery toast. | 5 days |
| 5 | Hardening: reconnection logic, offline edits queue, cold-start performance, Postgres snapshot tuning, load test with 50 concurrent users in one room. | 5 days |
| 6 | Multi-instance deploy with Redis extension when needed (not v1). | Deferred |

**Total realistic v1: 6 to 7 weeks of focused work.** Plus 2 weeks of buffer for the inevitable surprises in the binding layer. Call it 8 to 9 weeks elapsed at 50% allocation.

If we go Liveblocks-Yjs instead of self-hosting: cut Phase 2 entirely (2 to 3 days for the SDK swap), keep everything else. Saves ~5 days, costs $3k to $15k/mo at scale.

### 6d. De-risking spike

Before committing 8 weeks, do a 3-day spike:

1. Day 1: stand up a Hocuspocus server locally with `node` + `@hocuspocus/server`. Connect two browser tabs with `WebsocketProvider` and `Y.Doc`. Mutate a `Y.Map` in tab A, observe it appearing in tab B.
2. Day 2: replace one slice of `ComponentModel` (just the `props` map of a single node) with a Yjs-backed projection. Verify MobX reactivity still triggers React re-renders. This is the load-bearing experiment. If MobX can't observe Yjs reactively without forced patches, the architecture changes.
3. Day 3: write 10 lines of `onAuthenticate` against a stub auth-brain SDK. Verify the websocket connection auth handshake. Verify a second user with no permission gets rejected.

If those three days work, the rest is engineering. If they don't, we have early signal.

## Recommendation

**I recommend self-hosted Yjs + Hocuspocus, with MST as a derived projection from a Yjs-canonical document, websocket auth via auth-brain SDK, and Postgres persistence via `@hocuspocus/extension-database`. Defer the full retrofit until auth-brain v1 ships (estimated 4 to 6 weeks out per the auth-brain spec sequencing).** Specifically:

1. **CRDT library: Yjs.** Mature, MIT, the densest ecosystem in 2026. Automerge is technically excellent but has a smaller ecosystem; Liveblocks Storage locks the data model.
2. **Sync server: Hocuspocus self-hosted on Coolify/Hetzner.** Postgres for persistence via the database extension. ~10 EUR/mo at start, single instance handles hundreds of concurrent rooms. Liveblocks-Yjs is the fallback if ops bite us, and the swap is 2 to 3 days because the document is portable.
3. **MST integration: Shape C, Yjs-canonical with MST as projection.** Build a `YjsMstBinding` class that mirrors Yjs deep observations into MST patches. MST actions internally write to Yjs first, the Yjs observer applies back to MST. The renderer doesn't change. Reference implementations: BlockNote, Affine, Tldraw. None use raw Yjs in the UI layer.
4. **Conflict semantics: take Yjs's defaults for everything except (a) drag-while-remote-reparent (custom drag-cancel logic, ~2 days) and (b) deleted-while-editing (toast + recovery, ~1 day).** Per-user undo via `Y.UndoManager` with `trackedOrigins: [myClientId]`. Refactor `HistoryStore` into a facade over `Y.UndoManager` when the Yjs binding is active.
5. **Auth: `onAuthenticate` hook in the Hocuspocus server calls `auth-brain-sdk.verifySession(cookie)` then `auth-brain-sdk.can(user, 'project.edit', resource)`.** Cookie is on `.lumitra.co` so it flows to `collab.lumitra.co` automatically. Add `project.edit` action to framer-clone's `permissions.ts`. v2: CDC-driven disconnect on membership revocation.
6. **Persistence: Postgres via `@hocuspocus/extension-database`.** One table, `documents(id, data, updated_at)`. Snapshot on store-debounce (default 2s). Weekly gzipped backup to Hetzner storage. Y.snapshot-based version history is v2.
7. **Effort: 6 to 7 weeks focused, ~8 to 9 weeks elapsed at 50% allocation.** De-risk with a 3-day spike before committing.

The reasoning, condensed: Yjs is the only CRDT with the ecosystem density and React DX maturity that makes this tractable for a 1-developer team in 2026. Self-hosting via Hocuspocus is operationally cheap (one Coolify service, one Postgres schema) and avoids a $3k to $15k/mo Liveblocks line item that grows linearly with users. Shape C (Yjs canonical, MST projection) is the only MST integration shape that production teams actually ship, and it preserves the existing observer-based renderer. Auth-brain's `verifySession` + `can` already give us exactly the seam we need; the Hocuspocus `onAuthenticate` hook is its natural counterpart. The 8-week effort is real but de-riskable with a focused 3-day spike, and the reward is permanent Phase 1 parity with Framer/Figma on collaboration.

## Caveats

- **Auth-brain v1 must land first.** Without `verifySession` and `can`, the websocket has no identity layer to authenticate against. Per the auth-brain spec, that's ~4 to 6 weeks out. Multiplayer work should start spike-shaped now and full-shaped after auth-brain ships.
- **The drag manager has a real conflict-cancellation requirement that does not exist today.** ~2 days of polish, but it's a real edge case to test (e.g., user A is mid-drag, user B reparents the dragged node; user A's ghost has to snap back, source/destination indicators have to reconcile). Worth allocating Vitest coverage for.
- **`HistoryStore`'s gesture batching API is opinionated.** Yjs's `Y.UndoManager.captureTimeout` does similar work in a different shape. The migration is mostly "delete `startBatch` complexity, add `captureTimeout`", but the ESC-to-cancel-batch flow needs an explicit `Y.UndoManager.stopCapturing()` call which works differently. Allocate review time.
- **Inline text editing stays whole-string LWW in v1.** Two users typing in the same text element at the same time will see one of them lose characters. This is the expected v1 trade-off (Figma had the same shape early on). v2 migrates text-bearing components to `Y.Text` for character-level merging. Don't ship v2 inside v1's effort budget.
- **Liveblocks remains a viable Plan B.** If Hocuspocus operations turn out to be more burdensome than expected (say after 3 months of running in production), swap to Liveblocks-Yjs in a week. The architecture is portable because the document format is portable. Don't lock in to Liveblocks Storage (proprietary), only Liveblocks-Yjs (their hosted Yjs offering).
- **Document size for framer-clone projects is small.** A page is ~50 to 200 nodes, a project is ~10 pages, total is well under the 1MB-document threshold where Yjs starts thinking about memory. We are NOT operating at Linux-kernel-doc scale. Don't preoptimize.
- **Multi-instance scaling is a v1.5 concern, not v1.** First instance handles hundreds of concurrent rooms. Add Redis extension when monitoring shows actual saturation.
- **The 3-day spike's load-bearing question is "does MobX reactivity flow through a Yjs-backed projection cleanly".** If the answer is "yes with a thin wrapper", we're good. If the answer is "only with manual `runInAction` wrapping at every observer", the binding is uglier but still survivable. If the answer is "no, MobX can't observe Yjs reactively at all", the architecture has to change (probably toward `mobx-bonsai-yjs` or `syncedstore`). Plan accordingly.

## References

- Yjs docs: https://docs.yjs.dev/
- Yjs GitHub (MIT, ~17k stars): https://github.com/yjs/yjs
- Yjs UndoManager: https://docs.yjs.dev/api/undo-manager
- Yjs Awareness: https://docs.yjs.dev/getting-started/adding-awareness
- Hocuspocus GitHub (MIT, v4.0 April 2026): https://github.com/ueberdosis/hocuspocus
- Hocuspocus docs: https://tiptap.dev/docs/hocuspocus/getting-started/overview
- Hocuspocus Redis extension (horizontal scaling): https://tiptap.dev/docs/hocuspocus/server/extensions/redis
- Hocuspocus Database extension: https://www.npmjs.com/package/@hocuspocus/extension-database
- Liveblocks pricing (verified 2026-05-05): https://liveblocks.io/pricing
- Liveblocks Yjs (managed Yjs hosting): https://liveblocks.io/docs/ready-made-features/multiplayer/sync-engine/liveblocks-yjs
- mobx-bonsai-yjs binding: https://mobx-bonsai.js.org/integrations/yjs-binding/
- syncedstore (Yjs + MobX-style store): https://syncedstore.org/docs/advanced/mobx/
- y-presence (React presence hooks): https://github.com/nimeshnayaju/y-presence
- tldraw multiplayer architecture: https://tldraw.dev/features/composable-primitives/multiplayer-collaboration
- How Figma's multiplayer works (CRDT-inspired LWW): https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- Auth-brain v1 spec: `projects/lumitra-infra/auth-brain/docs/superpowers/specs/2026-05-06-auth-brain-design.md` (sections 1.6, 3.4, 3.5)
- Strategic thesis (Phase 1 parity): `~/.claude/projects/-Users-marlinjai-software-dev-ERP-suite-projects-framer-clone/memory/project_strategic_thesis_bubble_killer.md`
- Stylistic precedent: `projects/framer-clone/docs/plans/2026-05-01-framework-agnostic-renderer-research.md`
- Framer-clone source touched during research: `src/models/ComponentModel.ts`, `src/stores/HistoryStore.ts`, `src/stores/RootStore.ts`, `src/lib/drag/DragManager.ts`
