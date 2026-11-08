---
title: Live agent canvas
description: Plan for watching an agent build a site live in the open editor, the way Paper does with its Model Context Protocol (MCP) server, with skeletons of planned sections, a blue frame and label where the agent works, and content that appears element by element. The same feel for the in-editor Generate feature.
summary: A per-site server-sent events stream tells the open editor about every write; the editor fetches the stored copy and adopts it as one undo step labelled by the agent. A new announce_sections tool lets an agent draw skeletons before it writes, presence events drive a blue frame and an activity feed, and new nodes reveal with a short client-side stagger. Generate gets an outline first so it can draw skeletons too.
type: plan
status: in-progress
date: 2026-11-08
tags: [framer-clone, mcp, editor, live-sync, ai, plan]
projects: [framer-clone]
---

# Live agent canvas

**Status:** decided, approved by Marlin 2026-11-08; in progress since 2026-11-08.

## Progress

- **Slice 1, live sync core:** shipped in #336 (the open editor follows the site live) and proven on app.lumitra.co with a real agent write adopted in an open editor. As planned, with these details settled while building (decided, say so if you disagree):
  - The live routes take the save route's guard chain in `src/server/sites/liveGuard.ts` and answer 404 for a project of another workspace, like the save and rename routes, rather than reusing the domain routes' guard (which answers 403).
  - The repository reports whether a write actually wrote (`WorkingCopyWrite.wrote`), so the repeat of a save whose answer was lost, which writes nothing, announces nothing.
  - The `state` event carries the version now; its plans, agents and feed lists stay empty until slices 2 and 4 fill them.
  - `auth:expired` (or a 401 while polling) shows autosave's existing signed-out state; the next time the tab is shown, one fetch decides whether the stream starts again.
  - The MCP key's label is the generic "Agent" for now: the key's auth-brain name is read in slice 2 together with presence.
- **Slice 2, presence and activity feed:** shipped in #337 (agents show where they work in the open editor). `src/server/mcp/presence.ts` wraps every tool call (both the JSON and the streamed confirmation path) and reports `agent:activity` start and end through `src/server/sites/livePresence.ts`, which also keeps what the `state` event needs; the editor's `LivePresenceStore` (`src/lib/live/presenceStore.ts`) drives `AgentPresenceLayer` (frame, label pill, camera follow), the Pages panel dot, `AgentActivityPanel` and the top bar's `AgentEditingNote`. Details settled while building (decided, say so if you disagree):
  - **Tenant isolation:** nothing is reported before the named site is confirmed in the key's own scope (the repository's scoped version read, remembered for 5 minutes per workspace and site, a miss for 30 s, 5,000 pairs at most). A key naming another company's site id paints nothing there, not even an end. A database that cannot answer means no report, never a failed call.
  - **Bounded reporting:** one key reports at most 120 calls a minute and causes at most 20 lookups that find no site; calls beyond run unreported and look nothing up, so a runaway agent cannot flood its own company's editors or the database. While a key is over its budget its writes show in the feed only after a reload (from their audit rows). A rate-limited call shows as refused ("nothing written"), not as a failure.
  - **No summary line on `agent:activity`**, a change from the interface in section 2: the summary lines name page titles, which are content. The editor composes its words from ids and counts. (Slice 1's `site:version` keeps its summary lines for the agent-labelled undo entries, as decided there.)
  - **The label:** the key's name as auth-brain's verify answer holds it (`VerifiedKey.keyName`), else the `clientInfo.name` the MCP client declared at initialize, carried in the signed session id (capped at 40 characters to keep the id small), else "Agent". Both have control, zero-width and bidirectional override characters removed and are capped at 80 characters; the editor renders them as plain text.
  - **The label and the call's live id are stored in the audit row** (`actor_detail.label` and `actor_detail.callId`, a name and a random id, never a secret), so a backfilled feed line names the agent after a reload and keeps the id it had live: one write is one line, also when its end arrives just after a reconnect's `state`. Rows written before this slice say "Agent" (or "Someone" for a person). The feed's `agentId` is the same hash of the actor id live and from the audit table; the actor id never leaves the server.
  - **Feed words are composed in the editor** from the tool, outcome, page id and operation count, because a page title is content.
  - **Deleted nodes:** the store keeps a call's node ids as they came; the layer, the page dot and the feed resolve them against the open copy each time they draw, so a frame on nodes the person deleted or undid disappears (and comes back on redo). Nothing is pruned against the tab's own copy, which can be older than the activity (a held version, a reload during a write).
  - **Live feed lines kept by the server:** reads and refused or failed calls only (a committed write has its audit row). The `state` event merges the last 30 audit rows, read with the site id AND the caller's workspace and tenant group, with those lines; a failed audit read costs the backfill, never the stream. On every `state` (a reconnect sends it again) the editor replaces its feed rather than merging, so a live line and its audit row never both show.
  - **Timing:** the frame lingers 4 s after the agent's last call (`AGENT_FRAME_LINGER_MS`), then fades over 200 ms; it leaves at once after a refused or failed call. The top bar's "Claude is editing this site" stays 60 s after the last call (`AGENT_ACTIVE_MS`), since an agent thinks between calls; the same window decides which agents the `state` event carries. A call still running after 15 minutes counts as ended.
  - **Placement:** the panel sits at the foot of the left sidebar under the Pages and Layers panes, closed until an agent was active in the session or the site has feed lines, and opens by itself the first time an agent becomes active. The frame is drawn in every breakpoint frame the section shows in, with the label pill on the first. Its blue is a new `--agent-presence` token (`oklch(0.6 0.2 250)`, brighter in dark mode), apart from the iris selection colour.
  - **Camera follow** starts over with each run (an agent becoming active while none was), so a person who moved the camera between two runs still gets the next one followed; within a run, the person's first move turns it off until the Follow toggle.
- **Slice 3, per-component reveal:** shipped in #338. `src/lib/live/reveal.ts` plans which new nodes fade in and when (document order, depth first; `gap = min(45, 420 / (n - 1))`; 180 ms each), `LiveRevealStore` (`src/lib/live/revealStore.ts`, volatile on the editor UI store as `liveReveal`) holds node id to delay, `ComponentRenderer` draws an entry as `data-live-reveal` plus `--live-reveal-delay`, and the `fc-live-reveal` keyframes and the reduced-motion rule live in `src/app/globals.css`. Details settled while building (decided, say so if you disagree):
  - **The cause is passed through, never guessed from timing.** `LiveSync.adopt` takes a `reveal` flag, true only for a `site:version` the stream announced with origin `mcp` or `generate` (`revealsOnAdoption`). A catch-up after a reconnect, a version found by the reconnect's `state` or by polling (the writer is unknown), another tab's or person's save, a publish, an erasure and "Load the newer version" appear at once. A held agent write that is adopted automatically once this tab's own write settled keeps its event, so it still reveals. And only a copy that is exactly the announced write reveals (the event's version is the copy's, its `versionBefore` the version this tab has): a fetch that also brought other writers' versions (a burst coalesced into one fetch, a poll after a failed fetch, a held copy replaced by a newer one) appears at once rather than revealing their nodes as the agent's.
  - **No flash:** the reveal is set in the same MobX action as the adoption, so a new node is never drawn once without its delay.
  - **Each batch leaves on its own timer** (its last delay plus 180 ms plus a 400 ms margin, since an element's animation starts at its first style pass, which a large page can delay; should the timer still win, the node only snaps to visible), so a second agent batch inside the first's 600 ms never cuts the first short, and a node redrawn later (a redo, a page switch) appears at once. A node still revealing keeps its timing when a newer batch names it again. Undoing an agent's write leaves its entries inert until they expire.
  - **Only element nodes take a place in the timing** (a text node shows with its parent), and **each page is timed on its own**, so nodes created on another page never delay or compress the page on screen.
  - **The selection overlay and the presence frame measure again when a reveal ends** (`animationend` of `fc-live-reveal`), since they measured the node at its start position, 4 px low.
  - **Above 60 created nodes** the top-level groups (roots of the created subtrees) reveal, each carrying its subtree; when they form a single group, that group and its direct created children reveal, so one big section still unfolds.
  - **Only the page's own nodes reveal:** a placement reveals as one unit, never the nodes of its definition; nothing reveals in Interact, nor the copy whose text is being typed.
  - **`translate`, not `transform`, for the 4 px rise**, so a node's own transform is never overridden while it reveals; the animation runs `backwards`, so the node's own opacity wins once it has played.
  - **Reduced motion is the stylesheet's call** (`@media (prefers-reduced-motion: reduce)` turns the animation off), so a change of the setting mid-session is followed too; the store does not check it.
  - **In-editor Generate:** each draft section reveals node by node as it arrives (replacing the per-section 200 ms fade), with a per-section stylesheet written beside the canvas frames by `DraftStyles`, never inside the page tree. The apply keeps the sections the draft drew still and reveals only the result's sections the draft never drew (no stream, one the editor refused, or the run ended before it was sent). A preview section and its result get different ids (validation mints fresh ones), so the index in page order is what matches them. A draft section drawn anew (the person comes back to the run's page, which the draft is drawn on only while it is on screen) plays its reveal again, on purpose: those nodes were not on screen before.
  - **The presence label pill stays in the visible canvas:** `visibleCanvasRect` takes the window less the top bar (`data-editor-topbar`), the docked sidebars and the bottom toolbar (new `data-editor-chrome="left|right|bottom"` on their wrappers in `EditorApp`), and `pillPlacement` moves the pill past them (inside the frame's top edge when there is no room above it, never further right than the frame's right edge allows), and hides it when no part of the frame is visible. The chrome is watched for size changes, so a sidebar collapse or resize moves the pill.
- **Slice 4, MCP skeletons:** built on branch `feat/live-skeletons`. `src/server/mcp/livePlans.ts` keeps the plans in process memory (per site, with the scope they were announced under, the announcing key's hash, the MCP session and the times); `announce_sections` and `clear_sections` in `src/server/mcp/tools.ts`; the editor's `LivePlansStore` (`src/lib/live/plansStore.ts`, volatile on the editor UI store as `livePlans`) drives `SkeletonLayer.tsx` (skeletons among the page root's children, ghost frames for a new page) and the presence frame on the skeleton being filled. Details settled while building (decided, say so if you disagree):
  - **`after` must be a top-level section of the page** (a child of its root), stricter than "a node id on that page": a skeleton is a section-sized block, and among a section's inner nodes it would break that section's layout. An `after` moved under another section, or deleted, ends the plan (`anchor_removed`); moved among its siblings, the skeletons follow it. The server checks this on every committed write of the working copy while the site holds a plan (the repository hands the written pages to `checkPlanAnchors`, so an ordinary save pays nothing), and the editor resolves the anchor against its own copy on every draw, so a person's delete takes the skeletons away at once and an undo brings them back.
  - **Fulfilment only from the announcing key's own batches.** A ref another key's batch creates fulfils nothing, and only that key may clear or replace the plan. A key is one company's, so this is also the tenant boundary: a plan is announced only after the site was loaded through the key's own scope (`checkPlanAnchor` in `src/server/siteOps`, which also needs `editSite`), and the stream reads plans with the scope its own guard verified.
  - **Fulfilment runs inside the write, before it is announced** (the repository's `beforeAnnounce` step of `saveProject`), so `plan:update` always reaches an editor before the `site:version` that makes it fetch, whatever the audit row or the network does afterwards. A section counts as written only when its ref was created on the plan's own page as a section (a root node inserted into the page root; a ref of the same name on another page, or inside an existing section, fulfils nothing), and a new page only by a `createPage` ref.
  - **A skeleton goes by version, never by when an event arrives.** `plan:update` with a section's `fulfilledAt` (the version of its batch) arrives before the editor has fetched that version; the store draws a section while the tab's version is below `fulfilledAt` and moves its version inside the adoption's MobX action (and on the tab's own save), so the skeleton gives way to the real section in the frame its reveal starts. A fulfilled plan waits at most 15 s for the tab to catch up (a copy held for the person), then goes.
  - **The MCP session's end is Streamable HTTP's DELETE with the session id.** The endpoint keeps no session, so `initialize` puts a random nonce into the signed session id and a plan remembers it; a DELETE with that id (and the same key) ends the plans of that session on every site, a forged or foreign id ends nothing, and every DELETE answers 204. A client that never sends DELETE is covered by the 3 minute expiry.
  - **What refreshes a plan:** any call of the same key naming that site, and any call naming no site (a stock photo search between two batches is part of the same work). A call naming another site does not.
  - **An announcement checked against an older read is refused.** The anchor is checked on a read, and a write may land between that read and the plan existing; the repository remembers each site's newest written version (5,000 sites at most), and an announcement whose read is older answers `site_changed`.
  - **A replace keeps the replaced plan's start** (so replacing never outlasts the 20 minute cap) **and a new page already created** (so its skeletons never go back into a ghost frame). A clear followed by a new announcement starts afresh, on purpose: that agent is plainly still working, and the idle expiry ends a plan whose agent is gone.
  - **Limits:** 20 announcements and clears a minute per key (`PLAN_RATE`), 3 live plans per site and 2 per key on one site (more are refused with `too_many_plans`, never evicting another agent's, so one agent never takes every slot), 20 sections per plan, titles of at most 60 characters with control and bidirectional characters removed, rendered as text only; plans of at most 200 sites per company and 2,000 per process (a company over its share loses its own least recently touched site's plans first, so it never pushes out another company's). A refused announcement shows as refused in the feed, never as a failure.
  - **A replace** carries a ref already created over as fulfilled, so a re-announced section never stands over the real one, and the editor keys skeletons by agent and ref, never by plan, so sections that keep their ref keep their element.
  - **The feed says "Planned sections removed: the agent stopped"** when a plan expires or its session ends, with the same line id (`plan-stopped:<planId>`) on the server (for a reload) and in the editor.
  - **The first-write freeze:** measured on app.lumitra.co on a heavily loaded machine, every adopted agent write held the page for seconds, not only the first, so no first-write-only cause could be named. What was found and fixed: the reveal's timer ran from the adoption, so a render that blocked longer than the reveal took it away before it played; it now runs from the first paint. The remaining profile of the cold first adoption is a dated line on the roadmap.

## Goal

When an agent builds a site through the Lumitra Sites MCP (Model Context Protocol) endpoint, Marlin wants to watch the site assemble in the open editor, the way Paper (paper.design) does with its MCP:

1. **Skeletons first.** Placeholders of what is about to be made appear on the canvas before the real content.
2. **Where the agent is.** A blue frame with a label shows which section or page the agent is working on right now.
3. **Element by element.** Content appears component by component, not as a whole section popping in.

The in-editor Generate feature should feel the same.

## What exists today (verified on main at 17604ab, 2026-11-08)

- **The editor does not follow server-side changes.** The editor page (`src/app/projects/[projectId]/page.tsx`) loads the project once through `loadProjectSnapshot`. There is no route that returns a project snapshot to the client after that, and no stream. An outside write is noticed only when this tab's next save comes back 409 `site_changed`, and `SiteChangedDialog` (`src/components/SiteChangedDialog.tsx`) then offers "Load the newer version" (a full page reload), "Keep mine", "Save mine as a new project" or "Keep editing". Autosave arrived with #328 (the editor autosave pull request: the working copy saves about 1.5 s after the last change, with the version lock): `src/lib/projects/autosave.ts`.
- **`src/stores/openProject.ts` already knows how to adopt a newer server copy** on a load: it compares the baseline (what the tab last loaded or saved), the server copy and the working copy, takes the server copy when the working copy is unchanged, and reports a conflict when both changed. It tracks the version this tab knows (`markServerVersion`, `knownServerVersion`), and tells autosave that a change is a load, never an edit (`isApplyingServerCopy`). It also refuses a lower version than the one it knows.
- **An MCP `apply_batch` is atomic, one version per batch.** `applyBatch` in `src/server/siteOps/index.ts` loads the project, applies every operation with `applyOperations` (`src/lib/siteOps/applyOps.ts`, all or nothing, client-safe), and saves once through `saveProject` in `src/server/sites/repository.ts` with `expectedVersion`. The repository repeats the version comparison inside its `UPDATE`, so there is no read-then-write window. Node ids are assigned during apply; a node an operation creates can carry a `ref`, and the answer maps each `ref` to its new id (`created`).
- **Every site-operations write leaves an audit row** (`src/server/siteOps/audit.ts`, table `site_operation_audits`): actor kind and id, non-secret actor detail, operation, the operations of a batch by name and id (never content), version before and after. Reads leave no row.
- **In-editor Generate streams section by section since #329** (the streaming sections pull request of plan `docs/plans/2026-11-04-page-generator-ideas-and-streaming.md`). `src/lib/ai/pageGen/sectionStream.ts` finds each complete element of the tool input's `nodes` array while the model writes; `/api/ai/generate-page` sends it as `gen:section`; `src/lib/ai/pageGen/draft.ts` holds the sections as detached trees and `src/components/ai/PageGenDraftLayer.tsx` draws them where the result will land, with a "Writing section N..." band, a 200 ms fade and rise per section, and a camera that follows unless the person moved it. The result still lands as one undo step. There are no skeletons (the scanner yields only when an element closes, and the tool input has no outline) and no per-component reveal.
- **The MCP `generate_page` passes no section callback.** `generatePage` in `src/server/siteOps/index.ts` calls `runPageGeneration` without `onSection`, and the `PageGenerationContext` comment says so. An agent's generation runs for a minute or more with nothing to watch.
- **Why the draft is detached matters here.** `draft.ts` explains it: the undo history (`src/stores/HistoryStore.ts`) records MobX-State-Tree (MST, the in-memory tree behind the editor) patches with array indices. Nodes inserted from outside the history shift those indices, and later undos misapply. This constrains how agent writes may enter the store.
- **Production runs one container**, and the MCP approvals are kept in process memory (`src/server/mcp/approvals.ts`; `deploy/README.md`, "the app must run as a single container"). An in-process event bus is acceptable now; section 7 says what changes with more than one.
- There is an SSE (server-sent events, a one-way stream of named events over a long HyperText Transfer Protocol (HTTP) response) helper, `src/lib/ai/sse.ts`, with a 10 s heartbeat, already used in production by `/api/ai/generate-page`, so the proxy path through Coolify and Cloudflare is proven.

The repo has no root `CLAUDE.md`; the conventions read for this plan are the ERP suite's `.claude/rules/suite-context.md`, the repo's `ROADMAP.md`, `knowledge-base/standards/document-lifecycle.md` and `knowledge-base/standards/stateful-flow-testing.md`.

## 1. Live sync

### Decision: one SSE stream per open site, not polling the version

Polling the version every two seconds would cover "the editor follows writes" alone. It cannot cover the rest: presence and skeleton announcements never touch the database, so they need a push channel anyway, and a poll fast enough to show a frame on the section the agent is writing right now costs a request per editor every second or two. One SSE stream carries all three. Polling stays only as the fallback when the stream is down (below).

### The route

`GET /api/projects/<projectId>/events`, Node runtime, `dynamic = 'force-dynamic'`, built on `src/lib/ai/sse.ts`.

- **Auth: the editor's session cookie, the same guard chain as the save route.** Editor host only (else 404), a verified auth-brain session (else 401, 503 when auth-brain does not answer), the request's active company with the `sites` grant (else 403), `editSite` on its workspace (else 401 or 403), the project in that workspace (else the same 404 as a missing project, so existence never leaks). `EventSource` cannot set headers, so the cookie is the only credential; it is same-origin, so it is sent.
- **Re-check while open.** The route re-verifies the session and `editSite` every five minutes; on failure it sends `auth:expired` and closes. The client does not reconnect after `auth:expired` and shows the editor's existing signed-out state.
- **Bounds.** At most 4 streams per session and 50 per site, 1,000 per process; over the limit the route answers 429 and the client falls back to polling. The stream ends when the request's `signal` aborts, which unsubscribes from the bus.
- **Headers.** `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`, as the generate route sends.

### Events

| Event | When | Payload (all ids, never content) |
|---|---|---|
| `state` | Once on connect | Current `version`, the live skeleton plans of the site (section 3), the active agents and their last focus (section 2), the last 30 feed lines. |
| `site:version` | After every committed write of the working copy, from any writer | `version`, `versionBefore`, `origin` (`editor`, `mcp`, `generate`, `publish`, `erasure`), `originTab` (the random tab id the editor sent with its save, else absent), `actor` (`{ kind: 'user' or 'key', label }`), and for site-operation writes `ops` (as `auditedOps` already summarises them: op name, node id, page id), `created` (`ref` to id) and `summary` (one line per operation). |
| `agent:activity` | When an MCP tool call starts and when it ends | Section 2. |
| `plan:update` | When a skeleton plan is announced, replaced, fulfilled in part, cleared or expires | Section 3. |
| `gen:outline`, `gen:section`, `gen:done` | While an MCP `generate_page` runs | The same payloads as the editor's generate stream, plus the run's target (section 3). |
| `auth:expired` | Session or permission lost | Nothing. |

The SSE event id of `site:version` is the version. `EventSource` reconnects by itself and sends `Last-Event-ID`; the route compares it with the current version and, when the site moved on, sends a `site:version` for the current one, so catch-up is the same code path as a live write.

Writes are emitted **after the transaction commits, from the repository** (`src/server/sites/repository.ts`): from `saveProject` and `publishProject`, which both write the working copy through the private `writeWorkingCopy` and bump the version, and from `erasePersonalData`, which bumps it too. Every writer passes there: the editor's own save, an MCP batch, `generate_page`, a publish, a second tab, another person. `rollbackToRevision` changes only what is live and leaves the working copy and its version alone, so it emits a feed line (section 2) and no `site:version`. `saveProject` gets an optional `event` option (`origin`, `originTab`, `actor`), and `src/server/siteOps/index.ts` adds `ops`, `created` and `summary` next to its `audit()` call. A failure to emit is logged and never undoes a write.

### The snapshot route

`GET /api/projects/<projectId>/document`, same guard chain, answers `{ version, snapshot }` through `loadProjectSnapshot`, with `ETag` set to the version and 304 on `If-None-Match`. It is the only way content reaches the editor after the first load.

### Decision: the editor fetches the stored copy, it never replays operations

`applyOperations` is client-safe, so replaying the batch in the browser looks tempting. It would not reproduce the server's node ids (assigned during apply), so every later highlight, `ref` mapping and selection would point at nothing, and `generate_page`, a publish and another person's save have no operations to replay at all. One rule for every writer: the event says that a version exists and what it touched, the content comes from the snapshot route.

### Adopting a version into the store

A new module `src/lib/projects/liveSync.ts` owns the stream on the client:

1. On `site:version` with `version` greater than `knownServerVersion` and `originTab` not this tab: fetch the snapshot (`If-None-Match` the known version). Several events in a row coalesce into one fetch of the newest.
2. **Working copy saved** (`isSaved` true, no save in flight): adopt. Adoption is a new action, `HistoryStore.applyRemote` around the reconcile, and **not** the load path of `openProject.ts`: a real load clears the undo history and is never an undo step, which stays true for real loads, while an adoption keeps the history and adds one entry (below). What adoption borrows from `openProject.ts` is the bookkeeping: it runs under `isApplyingServerCopy`, so autosave sees no edit to save, and it moves the saved baseline and the tab's known version to the new copy at the same moment (`markServerVersion`). That last point is load-bearing: if the known version stayed behind, the person's next autosave would 409 after every agent write.
3. The adoption reconciles the changed parts with MST `applySnapshot` on the project's pages, components, theme and head, so unchanged nodes keep their identity: the selection, the scroll position, the camera and an open properties panel all survive, because node ids are stable.
4. The set of created node ids (in the new copy, not in the old) and changed node ids is handed to presence (section 2) and to the reveal (section 4).

When the stream is down (network loss, 429, a proxy that buffers), `liveSync` polls the snapshot route with `If-None-Match` every 5 s while the tab is visible and every 60 s while hidden, and goes back to the stream as soon as it reconnects.

### Decision: agent changes are undoable, one undo step per adopted version

This follows from how the history works, not from taste. Entries are MST patches with array indices; a version adopted outside the history shifts indices under the person's earlier entries, and their undos would misapply (exactly why `draft.ts` keeps Generate's preview detached). The two consistent options are "clear the history on every adoption" or "record the adoption as an entry". Clearing would wipe the person's own undo stack every few seconds while an agent works. Recording keeps the stack strictly last in, first out, so every inverse applies to exactly the state it was recorded on.

So each adoption is one `HistoryStore` entry, recorded with `recordPatches` around the reconcile, labelled by the actor: "Claude: insert 3 nodes in Pricing" from `actor.label` and the first `summary` line. `HistoryStore` gets an `applyRemote(label, fn)` action for this; the history panel shows the agent's entries with the agent's name.

The consequence, stated plainly: when the person undoes past an agent's write, the tab becomes dirty, autosave writes the undone state on the version the tab knows, and the agent's next write gets `site_changed`, re-reads and continues on the person's state. The person always has the last word. The plugin instructions already tell an agent to re-read on `site_changed`; section 3's slice adds one line saying the person may have undone its work on purpose.

### Decision: unsaved local edits wait for the person, nothing is merged automatically

Autosave saves 1.5 s after the last change, so a working copy is dirty only briefly. When a `site:version` arrives while the working copy is dirty or a save is in flight:

- The fetched version is held, not adopted. A `site:version` from another tab or writer means the site moved past the version this tab knows, so this tab's pending or in-flight save will be refused (the repository compares the version inside its `UPDATE`). The conflict is certain, so the editor does not wait: on whichever comes first, the event or the 409, it pauses autosave and opens `SiteChangedDialog`, with the existing four options. (The tab's own save echoing back is not a conflict: it carries this tab's `originTab` and is ignored.) "Load the newer version" no longer reloads the page: it adopts the held version (the person's unsaved edits are dropped, as the dialog already says) as one history entry, so even that step can be undone and saved over. "Keep mine" saves over it, as today.
- While an agent is active on the site, the top bar says so ("Claude is editing this site"), so a person who starts editing knows a conflict may follow.

An automatic three-way merge per node (take the agent's changes, keep the person's unsaved changes where they touch other nodes) was considered and left out: it is a sizeable piece of its own (structural changes to the same parent, theme edits on both sides), the dialog loses no work, and the case is the person editing in the same seconds the agent writes. If it turns out to happen often in practice, it gets its own plan.

### The four stateful-flow paths (`stateful-flow-testing.md`)

Every derived piece of client state is keyed to what it came from: an adopted version to its version number, a presence frame to its call id and node ids, a skeleton to its plan id and `ref`, a reveal to the version that created the nodes.

1. **Forward.** Editor open, the agent writes three batches. Three `site:version` events, three adoptions, three history entries, the known version equals the last one, the next person edit autosaves without a 409.
2. **Backtrack and revise.** The person undoes the agent's last batch: the tab is dirty, autosave writes it, the agent's next `apply_batch` gets `site_changed`. Presence frames and pending reveals keyed to nodes that no longer exist are dropped. The counter-case: undo then redo leaves the working copy equal to the saved copy (`isSaved` true), so nothing is written and the agent is not disturbed. For skeletons: an agent that re-announces a plan with different sections replaces every skeleton of the old plan; re-announcing the same sections keeps them without a flicker.
3. **Resume.** The person reloads the editor in the middle of an agent's run: the page loads the current copy, the stream's `state` event brings the live plans, active agents and the feed, so the canvas shows the same skeletons and frame again. A plan whose time to live (TTL) ran out while the tab was gone is not in `state` and is never reattached. A network drop reconnects with `Last-Event-ID` and catches up to the current version in one fetch. A stored known version lower than the server's (Back after Preview, the router cache) is ignored, as `openProject.ts` already does.
4. **Re-entry after completion or failure.** The agent finishes (every skeleton fulfilled or `clear_sections` called) or dies (TTL): skeletons and frame are gone, the feed keeps its lines. A new agent run later starts with no skeleton, frame or reveal left over from the old one. A failed batch (`rejected`, `site_changed`) writes nothing, emits `agent:activity` with the failure and no `site:version`, and leaves the canvas as it was.

## 2. Agent presence

### What the server emits

`src/server/mcp/handler.ts` wraps every tool call and emits `agent:activity` twice on the site's bus, at start and at end. Calls without a site (`list_sites`, `find_images`) are not emitted.

```ts
interface AgentActivity {
  callId: string;          // random per call
  agentId: string;         // a hash of the key id, stable per key, never the key id itself
  label: string;           // the key's name as auth-brain holds it, else the MCP client name, else "Agent"
  tool: string;            // 'get_page', 'apply_batch', 'generate_page', ...
  phase: 'start' | 'end';
  outcome?: 'ok' | 'rejected' | 'site_changed' | 'failed';   // on end
  pageId?: string;         // the page the call reads or writes
  nodeIds?: string[];      // start: the node ids its operations name; end: plus the created ids (max 200)
  sectionRef?: string;     // the skeleton ref the call fulfils, when it names one (section 3)
  summary?: string;        // on end of a write: the first summary line
  at: string;              // ISO 8601 time
}
```

No content ever goes over the stream: the label and the summary lines are the only text, both written by the server (the summary from operation names and ids, the label from auth-brain or the client's declared name), capped at 80 characters and rendered as plain text. The skeleton titles of section 3 are the one place an agent writes text the editor shows; they get the same cap and plain-text rendering.

### The blue frame and label

A new canvas layer, `src/components/live/AgentPresenceLayer.tsx`, draws for each active agent:

- **A 2 px blue frame** (a new `--agent-presence` token, the blue Marlin asked for, offset 2 px outside the element so it never hides the person's own selection outline) around the **section** the agent works on: the top-level child of the page root that contains the call's nodes. One frame per agent, not one per node; a call that touches several sections frames the first in document order. Section-level, because a frame jumping between dozens of leaf nodes per second reads as noise.
- **A label pill** at the frame's top left: the agent's label and what it does ("Claude · Writing Pricing", the skeleton title when the call fulfils one, else "Editing", "Reading" for reads).
- **The page** gets the same frame on its page frame when a call names a page but no nodes (`createPage`, `get_page`), and the Pages panel marks that page with a small blue dot.
- The frame moves to the new section with a 200 ms ease-out transform; it fades out 4 s after the agent's last `end`, or at once on a failed call's end. Under reduced motion it jumps and disappears without fading.
- **Camera follow**: as in `PageGenDraftLayer`, the camera follows the frame only while the person has not moved the camera since the agent's activity started, and the feed has a "Follow" toggle to turn it back on.

### The activity feed

A collapsible panel in the editor's left sidebar, "Agent activity", newest first:

- One line per call: time, label, tool in plain words ("Read the Home page", "Wrote 4 changes in Pricing", "Generation refused: site changed, re-reading"), with a status mark. Clicking a write line selects its created or changed nodes and moves the camera there.
- Writes come back after a reload from `site_operation_audits` (the durable record that already exists; the `state` event reads its last 30 rows for the site). Reads exist only live (last 30 kept in memory per site), since reads leave no audit row and do not need one.
- The panel appears on its own the first time an agent becomes active in a session and stays out of the way otherwise.

## 3. Skeletons

### Decision: a new tool, `announce_sections`, not a field on `apply_batch`

`apply_batch` is atomic and lands when the content is ready, which is exactly too late for a placeholder. A separate tool that writes nothing to the document can be called first, needs no `expectedVersion`, bumps no version, and is limited separately (20 calls a minute per key).

```ts
announce_sections({
  siteId: string,
  pageId?: string,                 // an existing page; or
  newPage?: { ref: string, title: string },   // a page the agent is about to create
  after?: string,                  // a node id on that page; default: the end of the page root
  replaces?: string,               // a plan id this one replaces
  sections: Array<{                // 1 to 20
    ref: string,                   // the ref the agent will put on the section's root node in apply_batch
    title: string,                 // shown on the skeleton, max 60 characters
    kind?: 'hero' | 'features' | 'gallery' | 'pricing' | 'testimonials' | 'faq' | 'cta' | 'form' | 'footer' | 'generic',
  }>,
}) => { planId: string, expiresAt: string }
```

The tie between a skeleton and the real content already exists: `apply_batch` nodes carry `ref`, and the answer maps each `ref` to its created id. A plan names the same refs, so when a batch commits and its `created` map contains a plan's ref, the server marks that section fulfilled and the editor replaces that skeleton with the real node in the same frame the node's reveal starts. Nothing is guessed from position or titles. A `newPage.ref` is fulfilled by the batch whose `createPage` carries that ref; until then the skeletons are drawn in a ghost page frame beside the current one, as `PageGenDraftLayer` already does for a new page.

### How skeletons end

- **Fulfilled**: every section's ref appeared in a committed batch's `created`. The plan ends.
- **Cleared**: `clear_sections({ siteId, planId })`, for an agent that changes course. Re-announcing with `replaces` replaces the old plan's skeletons in one step (no gap, no flicker for sections that keep their ref).
- **Expired**: the plan's TTL is 3 minutes after the agent's last call on that site (any call by the same key refreshes it, since a long `generate_page` or a stock photo search between batches is normal), with a hard cap of 20 minutes per plan. On expiry the skeletons fade out over 200 ms and the feed says "Planned sections removed: the agent stopped". The MCP session's end (the client disconnecting) expires the key's plans on that site at once.
- **Invalidated**: a person who deletes or moves the node named in `after`, or deletes the page, ends the plans anchored there (the plan is derived state of that anchor). The agent learns of it on its next write from the normal `site_changed` and re-read.

Bounds: 3 live plans per site, 20 sections per plan, held in process memory beside the approvals (`src/server/mcp/livePlans.ts`).

### What a skeleton looks like

`src/components/live/SkeletonLayer.tsx` draws each unfulfilled section at its place in the page as a detached block (never in the project, never saved, never in the history, absent from the Layers panel), like the Generate draft. A small set of static shapes per `kind` (hero: a heading bar, two text lines, a button pill and an image block; features: three cards; and so on, `generic` as two bars and a block), sized to the breakpoint's width, in a neutral tint with the section title. Static on purpose: no shimmer and no pulse (the motion rules forbid perpetual animation). The skeleton the agent is filling right now carries the blue presence frame, which is the motion cue.

### Agents must learn to use it

The same slice updates `src/server/mcp/instructions.ts`, the tool description, and the lumitra-sites plugin's skill (`plugin/lumitra-sites/`): announce the sections of a page before writing, write one section per `apply_batch` with its ref on the section's root node, and clear a plan when changing course. Without this, agents never call it and no skeleton ever appears.

### In-editor Generate: an outline first

The scanner yields an element only when it closes, so Generate has nothing to draw skeletons from until the first section is complete. The fix is a short outline the model writes before the nodes:

- `emitPageTool()` (`src/lib/ai/pageGen/prompt.ts`) gets `outline: [{ title, kind }]` as its **first** property, and the prompt asks for it first. It is a preview hint only: dropped before validation, never saved.
- `sectionStream.ts` yields the outline the moment its array closes (the scanner already tracks the root object's keys), `/api/ai/generate-page` sends it as `gen:outline`, and `draft.ts` draws a skeleton per outline entry; `gen:section` number i replaces skeleton i.
- The uncertainty, named: key order in the model's tool input follows the schema and the instruction in practice but is not guaranteed. Fallback when `nodes` starts before an outline: a skeleton per element the moment the element **opens** and its `label` or `type` has been read, so the slot appears as soon as the model starts writing it. Outline entries beyond the real sections are removed when the result lands; sections beyond the outline appear as before.
- The cost is a few dozen output tokens per run.

### The MCP `generate_page` streams its draft to open editors

`generatePage` in `src/server/siteOps/index.ts` passes `onSection` (and the new outline callback) to `runPageGeneration`, and forwards both to the site's bus as `gen:outline`, `gen:section` and `gen:done`, with the run's target. An open editor draws the existing draft layer for it, skeletons and all, so an agent's minute-long generation builds itself on the canvas exactly as the person's own Generate does. On `gen:done` the draft is dropped in the same frame the `site:version` of the save is adopted; on failure or abort it is dropped and the feed says why.

## 4. Per-component reveal

### Decision: client side only, the server emits no per-node events

The batch is atomic and that stays: per-node server events would describe intermediate states that never existed in the database, multiply the stream's traffic, and the server does not know the canvas's render order anyway. The client already has what it needs: the created node ids of each adopted version, in document order.

- After an adoption, the created nodes enter a transient `revealing` map on the editor's user interface (UI) store (node id to delay), never in the project tree, never saved, never in the history. `ComponentRenderer` gives those nodes a Cascading Style Sheets (CSS) animation with an `animation-delay`, so no JavaScript runs per frame.
- **Order**: document order, depth first, so a section's frame comes before its heading, the heading before the text, the text before the buttons.
- **Timing (Emil Kowalski's rules)**: each node fades in with a 4 px rise over 180 ms, `ease-out`; 45 ms between nodes, compressed so a whole batch finishes within 600 ms (`gap = min(45, 420 / (n - 1))`). A batch of more than 60 created nodes reveals by its top-level groups instead of by leaves, so a large `generate_page` result does not crawl.
- **Reduced motion**: no animation, nodes appear at once.
- **When it runs**: only on adopted agent writes, a `generate_page` result and the in-editor Generate apply (where it replaces the current per-section fade with the same per-node stagger inside each section). Never on the first load, a reload, "Load the newer version" or the person's own edits: their own change must feel instant.
- The agent's pacing does the rest: one section per batch (section 3's instructions) means the canvas fills section by section, each section element by element.

## 5. Slices

Each slice is its own pull request with its tests, landed by land-pr. Sizes are in agent days.

| # | Slice | Size | Tests |
|---|---|---|---|
| 1 | **Live sync core**: the in-process site bus, emits from the repository after commit (with `origin`, `originTab`, `actor`, and `ops`, `created`, `summary` from site operations), the events route with its guard chain, bounds and re-check, the snapshot route, `liveSync.ts` with adoption under `openProject.ts`'s bookkeeping (never its load path), one history entry per adoption (`HistoryStore.applyRemote`), own-write suppression, coalescing, polling fallback, the early `SiteChangedDialog` and "Load the newer version" without a reload. No visuals beyond the agent-labelled history entries. | 4 to 5 | Route tests for every guard and bound; the bus emits only after commit and never for a refused write; `liveSync` unit tests for the four paths of section 1 (including undo then redo writing nothing, a stale lower version ignored, `Last-Event-ID` catch-up); an integration test where an MCP `apply_batch` reaches a subscribed stream and the adopted store equals the stored copy; undo across an adopted version restores the exact earlier state. |
| 2 | **Presence and feed**: `agent:activity` from the MCP handler, the presence layer (frame, label, page dot, camera follow), the activity feed with audit-row backfill in `state`, the "Claude is editing" top bar note. | 2 to 3 | Handler emits start and end with the right ids and outcomes, never content or the key id; frame placement at the containing section; fade timing and the reduced-motion path; feed backfill after a reload; frames keyed to deleted nodes are dropped. |
| 3 | **Per-component reveal** for adopted versions and the Generate apply. | 1 to 1.5 | Delay computation (order, compression, the 60-node grouping), reduced motion, no reveal on first load, reload, own edits or "Load the newer version". |
| 4 | **MCP skeletons**: `announce_sections` and `clear_sections`, fulfilment from `created`, TTL and session-end expiry, anchor invalidation, `plan:update` and `state`, the skeleton layer and ghost page frame, instructions, tool descriptions and the plugin skill. | 3 to 4 | Tool argument and bound tests; fulfilment by ref (partial, complete, a ref never fulfilled); replace with the same and with different sections (no flicker versus full replacement); TTL refresh and expiry; resume after reload shows live plans and never expired ones; re-entry starts clean; plugin skill tests updated. |
| 5 | **Generate outline skeletons**: `outline` in the emit tool and the prompt, the scanner's outline yield and open-element fallback, `gen:outline`, skeletons in `draft.ts` and the draft layer. | 2 | Scanner tests over fragments split everywhere (outline first, outline missing, outline longer and shorter than the sections); the outline never reaches validation or the saved result; draft layer replaces skeleton i with section i. |
| 6 | **MCP `generate_page` draft streaming**: `onSection` and the outline callback in `siteOps.generatePage`, forwarded to the bus, drawn by the draft layer in open editors, dropped on `gen:done` together with the adoption. | 1.5 | The callbacks are passed and forwarded; an aborted or failed run drops the draft and writes nothing; the draft and the adopted result never show at the same time. |

Order: 1 first (everything else rides on the stream). Then 2 and 3, which make an agent visible with the agent's existing behaviour and no plugin change. Then 4, then 5 and 6, which share the outline. About 14 to 17 agent days in all. Each slice is verified in the browser on app.lumitra.co with a real agent session through the plugin before it counts as done.

## 6. Decided, say so if you disagree

1. **SSE per site, polling only as fallback**, because presence and skeletons need a push channel that a version poll cannot provide.
2. **The editor fetches the stored copy; it never replays operations**, because server-assigned ids would not match and most writers have no operations to replay.
3. **The tab's known version advances at adoption**, so the person's autosave never 409s against an agent's write it has already adopted.
4. **Agent writes are undoable, one undo step per adopted version, labelled by the agent**, because the patch-based history is only consistent if adoptions are on the stack; the person's undo wins and the agent re-reads.
5. **No automatic merge of unsaved local edits**: the incoming version waits, the conflict dialog opens at once, and "Load the newer version" adopts without a reload.
6. **Presence frames the section, not each node**, in a dedicated blue, with server-written labels only.
7. **Skeletons come from a new `announce_sections` tool tied to `ref`**, fulfilled by `apply_batch`'s `created`, expiring 3 minutes after the agent's last call (20 minutes at most) or when its session ends.
8. **Generate gets an outline as the first tool-input property**, with an open-element fallback when the model writes nodes first.
9. **The reveal is client-side only**: 180 ms per node, 45 ms apart, a batch done within 600 ms, nothing under reduced motion; no per-node server events.
10. **The MCP `generate_page` streams its draft to open editors**, reusing the existing draft layer.

Nothing here needs Marlin's input to start; the colour of the agent frame and the feed's place in the sidebar are visual calls he can change on the first browser check.

## 7. With more than one container

The bus is a process-local `EventEmitter`, the plans and the read-only feed lines live in process memory, like the MCP approvals. With a second replica, a write on replica A would never reach an editor streaming from replica B. The change, when it comes (together with the approvals, which need the same move):

- **Events** go through Postgres `LISTEN`/`NOTIFY` on one channel per site (or one channel with the site id in the payload). Every replica listens and fans out to its own streams. Payloads stay small (ids and summaries, well under Postgres's 8,000-byte limit), which they already are by design. No new infrastructure: the app already talks to Postgres through Prisma.
- **Plans and feed state** move to a small `site_live_plans` table with `expires_at`, read by `state` and swept by a periodic job; reads in the feed stay best-effort per replica, writes come from the audit table anyway.
- **Streams need no sticky sessions**: any replica can serve any editor, since every replica receives every event.
- Nothing in the client changes.
