---
type: plan
status: in-progress
date: 2026-11-04
title: "Editor autosave: the working copy saves by itself"
summary: "The editor saves the project about 1.5 s after the last change (at most 10 s after the first), right away after a generated page, through the same request and version lock Save used. There is no Save button: a status in the top bar says Saved, Unsaved changes, Saving..., Not saved (with Retry) or Changed elsewhere, and Cmd/Ctrl+S saves at once. A refusal by the version lock pauses autosave and asks; passing failures retry with backoff for 10 minutes; one beforeunload warning covers unsaved or in-flight work of every project of the tab. The demo editor at / offers Keep as project and never autosaves."
tags: [framer-clone, editor, save, autosave, version-lock]
projects: [framer-clone]
---

# Editor autosave: the working copy saves by itself

## Context

Verified on app.lumitra.co on 2026-11-04: the editor had no autosave (the header of
`src/components/SaveButton.tsx` said "There is no autosave: every write is a click"). Work
survived leaving to the projects overview and coming back in the same tab, because the
in-browser store keeps the working copy (`src/stores/openProject.ts`), but a reload, a closed tab
or a new tab silently lost everything unsaved, including a page generated with AI (the generator
dialog only said "Save the project to keep it"). There was no `beforeunload` warning either. The
owner saw generated pages vanish.

What already existed and is kept:

- **Save** (MT-10, the per-project editor route, plan `2026-06-26-multi-tenancy-phase2-plan.md`):
  POST `/api/projects/save` writes the working copy and never changes the site's status, so saving
  never publishes.
- **The version lock** (plan `2026-11-02-lumitra-sites-agent-plugin.md`, step 1): every write of a
  site carries `expectedVersion`; a stale one is refused with HTTP (Hypertext Transfer Protocol)
  409 `site_changed` and `currentVersion`, and nothing is written. The editor shows
  `SiteChangedDialog` (load the newer version, save mine over it, keep both as a new project,
  keep editing). This is what keeps the editor and an outside agent (the Model Context Protocol
  (MCP) endpoint) from overwriting each other.
- **Publish** writes the same snapshot through `/api/projects/publish` with the same lock, then
  publishes. It is separate from saving; a published site's visitors read the revision the last
  publish froze, never the saved working copy.
- **Limits of the save route**: no rate limit (none in the middleware or the route), only a body
  cap of 10 MB (`PROJECT_BODY_MAX_BYTES`, answered 413 `body_too_large`). So the client is the only
  guard against flooding it.

## Decided

**No Save button (Marlin, 2026-11-04, after the first version of this plan):** "Everything
should autosave all the time. There shouldn't even be the need for a save button. Framer also
doesn't have it." This replaces decision 7 below and the parts of the built decisions that
assumed a button. What follows from it:

- The top bar (wide and compact, nothing in the More menu) shows a save status instead of
  Save: Saved; Unsaved changes while the debounce runs; Saving... only when a save takes
  longer than 300 ms (a quicker one goes straight to Saved, so typing never flashes);
  Publishing... while Publish writes the same copy; Not saved with the reason and Retry;
  Changed elsewhere (409 `site_changed`), a button that reopens `SiteChangedDialog`. One
  polite live region (`role="status"`), always present; only an action is keyboard reachable;
  a word changes with a fade under 300 ms, ease-out, none with reduced motion.
- Cmd/Ctrl+S always keeps the browser's "save page" dialog away (also in a field, mid-drag,
  in the preview) and saves at once; after a failure it tries again; while the version lock's
  refusal stands it reopens the dialog without a request; during Publish it adds nothing.
  No other UI.
- Refusals the person must act on carry what to do: 401 "You are signed out" with "Sign in
  again", which opens `/projects` in a new tab (the overview bounces a signed-out visit to the
  sign-in; navigating this tab would lose the very work at stake), then Retry; 403 names the
  missing permission; 413 names the 10 MB limit and suggests removing large embedded content.
- The demo editor at `/` says "Demo, not saved" and offers "Keep as project"
  (`SaveAsNewProjectDialog` under that title). Never autosaved; Cmd+S there only swallows the
  key.
- Publish keeps its coordination (waits for a save in flight, holds autosave, counts as a
  save). The generator's line uses the same words as the top bar (one shared label hook).

Folded in from the review of 978fd768 (decided while building, say so if you disagree):

- **Unsaved work of a project the person left is never lost silently.** One `beforeunload`
  registration (`UnsavedWorkGuard`, in the `/projects` and `/preview` layouts and the demo
  page) asks every controller of the tab (`anyUnsavedWork`). A project left behind with a
  failed or paused save keeps its controller (a network failure keeps retrying in the
  background) and a notice names it with "Go back to it".
- **Every reload on purpose discards without the warning** (`reloadDiscarding`): the version
  lock dialogs of the status and of Publish, the "changed elsewhere" notice, and "Reload the
  editor" after erasing personal data.
- **A load during this tab's own write is not "saved somewhere else."** Autosave and Publish
  report a write in flight to `openProject`, which then keeps the working copy and the
  version as they are; the write's answer sets the new version, or is the 409 if someone else
  wrote.
- **No automatic save without a server version** in this tab (a demo just kept as a project,
  before its page loads).
- **Passing failures retry for 10 minutes**, then stop and wait for Retry (the reason says so).
- **Controllers leave the registry** once their project is left with everything saved, and
  none is created during a render. The project tree is watched by patch; the snapshot is taken
  and compared only when the debounce fires (at most one per 1.5 s of pauses), on leaving, on
  unload and after Publish, never per change.

Folded in from the re-review of 86b2d472 (decided while building, say so if you disagree):

- **A lower server version is a stale read**, never news: versions only go up
  (`writeWorkingCopy`), so an older payload (the client router cache replaying the editor's
  page on Back after Preview) adopts neither content nor number. Without this, "Save mine over
  it" after the following 409 could have overwritten newer saves.
- **A load counts every saved part as this tab's work** (legal details, sharing texts, the
  language, the analytics binding, the description), not only the compared ones.
- **Cmd/Ctrl+S listens in the capture phase.** The inline canvas editor, the panel text field
  and the component dialogs stop every keydown, so a bubbling listener let the browser dialog
  through. Text being typed there registers as an open draft (`src/lib/projects/openDrafts.ts`):
  it counts for the unload warning, and Cmd+S and leaving the page commit it first. In the
  canvas Cmd+S ends the inline edit, as Enter does (one undo step); hiding the tab or leaving
  writes the text and keeps the edit open (fourth review); the panel field keeps focus.
- **A reload on purpose that the person cancels** (Stay, when the browser asks about another
  project's unsaved work) leaves autosave and the warning working again, re-armed by a real sign
  the page stayed (the person pressing a key or the pointer on it, or the page shown again from
  the back-forward cache), never by time alone and never after `pagehide` (third review).
- **Coming back to a paused project** whose copy meanwhile equals the server's clears the pause.
- **Leaving or hiding the page** commits open drafts and sends what is unsaved at once, as a
  `keepalive` request when the body fits the browser's 64 KB limit (otherwise a normal request
  and the warning). Never over a refusal waiting for a choice. Back online, a waiting retry goes
  at once.
- **A save attempt is idempotent.** The client names each attempt (`requestKey`, new for new
  content or a new version, reused on retry); the site row keeps the key of its last write
  (`sites.last_write_key`) together with the version that write produced
  (`sites.last_write_version`, fifth review), two additive nullable columns in migration
  `20261104000000_site_last_write_key`. A repeat of that write, while its key is still bound to
  the current version, gets the stored version back and writes nothing, instead of a false 409
  after a lost answer. It lives until the next write of the site; publish and erase clear it. A 2xx
  without a version is a 502 server error (retried with the same key), never a refusal.
- **Calmer status:** only failures, the conflict and the first "Saved" after one are announced
  to screen readers (a separate polite region); only a problem fades in; the retry countdown
  ticks once a second (also in the left-behind notice); the ellipsis character throughout.
- **One serialisation per save cycle:** the comparison key is computed when the debounce fires
  and passed on to `isSaved` and `markServerVersion`.
- **The attempt key is bound to content and version.** An edit during the backoff after a lost
  answer is a new attempt with a new key, and it names every lost attempt on the same base
  (`previousRequestKeys`, at most 8; fifth review, it was one key): when the latest stored write
  is one of them, its key still bound to the current version, the server writes the new content
  on top of it instead of a false 409. Someone else's write stays a 409, and so does a stale key
  after a writer that does not know it (an older container during a rolling deploy moves the
  version and leaves the key, which unbinds it). Reusing the key for new content would
  mark it saved while the server holds the old content.
- **Hiding the tab while editing text on the canvas** commits the text and keeps the inline
  edit open, with the focus where it was (changed in the fourth review; only Cmd+S ends it).
- **No router refresh on a stale read:** nothing is adopted, so there is nothing to refresh.

Folded in from the third review of 8bcce7b1 (decided while building, say so if you disagree):

- **Typing survives the editor closing without a blur** (browser Back, Cmd+[, a mouse back
  button). React unmounts the canvas before the top bar and the top bar before the right panel,
  so no single order works: `useAutosave` commits open drafts before it detaches, `detach` saves
  whatever the server does not hold (also with no timer pending), the inline canvas editor
  writes its text on unmount while its edit is still open, and every panel field commits its
  own draft on unmount.
- **Every blur-committing panel field is an open draft** (`src/hooks/useOpenDraft.ts`): the
  component input fields, custom properties and attributes, form options, colour, dimension and
  slider value inputs, besides the text field. A field counts only once the person typed in it,
  never for a value merely shown in another format.
- **The left-behind notice is not a live region**; its own polite region announces an item when
  it first appears or changes kind, so the ticking countdown is never read out.
- **"Save mine as a new project" gives up the original's working copy** (from the status and
  from Publish): its pause, warning and notice end, and coming back to the original opens the
  server copy (`discardWorkingCopy`).
- **Recovery:** back online, or when the tab is visible again, a failure whose automatic retries
  stopped and a sign-out (401) are tried once more; still refused, they stay failed.
- **Publish's body is strict** and refuses the save's attempt keys; the save has its own schema.
- ~~The migration gives up after 5 s waiting for its lock.~~ Taken out again in the fourth
  review: adding a nullable column without a default is metadata only, and a migration that
  fails on a timeout is marked failed by Prisma (P3009), blocking every later deploy. The
  rollback (drop the column, `prisma migrate resolve --rolled-back`) is in `deploy/README.md`,
  "Migration rollbacks".
- **Cmd/Ctrl+S on the standalone preview** only keeps the browser dialog away (nothing to save
  there).

Folded in from the fifth review of 812634de (approved; these close it, decided while building,
say so if you disagree):

- **Two lost answers in a row no longer end in a false 409.** The client keeps every lost
  attempt on the base version since the last confirmed write (at most 8) and names them all;
  the server accepts when the latest write is one of them. The guard is the key's binding to
  the version it wrote (`last_write_version`), not `expectedVersion + 1`: during a rolling
  deploy an older container moves the version without clearing the key, and the binding stops
  that stale key from matching. The list is capped: nine or more lost answers in a row on one
  version can end in a false "changed elsewhere", never in an overwrite, and "Save mine over it"
  resolves it.
- **A lost "Save mine over it" retries over the version the conflict reported**, by timer, by
  Retry and when Publish settles it first (delta review), never on the old known version; if that
  settling save fails again, Publish sends the same base with the lost keys, and a successful
  Publish clears both.
- **A successful Publish settles a lost save on the same base**: no false leave warning after it.
- **Publish names the lost save keys too** when its settling retry failed again: the publish
  route accepts `previousRequestKeys` (never a key of its own, publishing has no replay), and
  the same binding guard applies, so a landed lost save is built on instead of being a conflict.
- **Cmd+S on the overview never opens a conflict's dialog** (there is no status on screen for
  it); the notice says "Changed elsewhere: go back to it to choose what to keep".
- **After each 400** the next change gets one debounced attempt; refused again, it stays failed
  until the next change. Other refusals (401, 403, 404, 413) still wait for Retry.
- **The Details panel closes on Escape**, and the focus goes back to Details.

Folded in from the fourth review of d38f636e (each reviewer probe ported as a failing test
first, then fixed; decided while building, say so if you disagree):

- **Only an ok or a conflict settles a lost attempt.** A refusal of a later attempt (401, 403,
  413, 400) says nothing about the lost one, so the next save still names it; before, a refusal
  in between led to a false 409 against this tab's own write.
- **While an attempt's answer is lost, nothing counts as saved:** an undo back to the loaded copy
  is still sent (naming the lost attempt), and the unload warning stays on until the server
  answers.
- **Publish settles a lost or waiting save first** (that save goes past Publish's hold, with its
  own key, so the server replays it), then publishes on the version it produced. If that save
  fails again, Publish goes on and its own version lock decides.
- **Leaving while a request is out** sends what changed during it at once after the answer, as a
  keepalive request, not after a debounce.
- **A recovery is one attempt** (back online, the tab visible again): still failing, also with a
  5xx, it stays failed without a new 10 minutes of retries.
- **The unsaved check is cached per change** (a counter moved by every patch of the project,
  also while it is not on screen, and by every state), so the notice's one-second countdown
  never serialises a project again.
- **The keepalive budget is shared:** the browser caps all keepalive bodies of a page at 64 KB
  together, so the project on screen goes first and the others take what is left; a body that
  does not fit goes as a normal request.
- **Mobile Safari has no unload warning.** Measured on 2026-11-05
  (`src/lib/projects/__tests__/saveBodySize.test.ts`): a project with a generated six-section page
  plus three more pages sends a save body of 33,578 bytes (about 34 KB), inside the 60 KB
  keepalive budget. A project about twice that size or larger cannot be finished by the browser
  after the page is gone, and the unload warning, its fallback, does not exist on mobile
  Safari: there, leaving with a save not yet answered can lose the last seconds of work.
- **The full failure reason is reachable by keyboard** on the wide bar (a Details disclosure);
  the compact bar shows it whole in its notice.
- **Cmd/Ctrl+S on the projects overview** keeps the browser dialog away and saves projects left
  behind at once.
- **The autosave lifetime lives in the editor shell** (`EditorAutosave`, first in EditorApp),
  not in the status display.

Decided by Marlin on 2026-11-04 (the brief of the first version):

1. The editor saves by itself: debounced, about 1.5 s after the last change, through the same
   path as Save (`postProjectWrite` with `knownServerVersion` and `markServerVersion`), and right
   away after a generated page or section lands. Never two requests in flight; changes during a
   request make one trailing save.
2. Saving never publishes.
3. On 409 `site_changed`, autosave stops for that project and the existing `SiteChangedDialog`
   asks, with the same choices as Save. It never loops on a refusal.
4. Errors (network, server errors, sign-in) are shown in the top bar and retried with backoff;
   never silent.
5. The demo editor at `/` (`isUnsavedDemo`) does not autosave and keeps its Save-as flow.
6. A `beforeunload` warning while there are unsaved or in-flight changes.
7. ~~Save stays as "save now" and shows the state.~~ Superseded the same day: no Save button
   (see above).
8. The generator's "Save the project to keep it" line goes away (it says Saved instead).

Decided while building (say so if you disagree):

- **A maximum wait of 10 s.** A pure trailing debounce never fires during a long drag or a long
  typing burst, which is exactly when work piles up; the first unsaved change is saved at most
  10 s later.
- **Resuming after a 409 needs a successful write of this tab**: "Save mine over it" or a
  Publish that succeeds; or a reload ("Load the newer version"). "Keep editing" closes the
  dialog and leaves autosave paused (the status says "Changed elsewhere", which asks again). Resuming on "Keep editing" would bring the dialog back 1.5 s later, the loop
  decision 3 forbids.
- **A load that kept this tab's work over a newer server copy starts paused.** `openProject`
  already reports this (`changedElsewhere`, with the editor's notice); autosave starts in the
  paused state with the server's version, so "Save mine over it" works at once, instead of
  sending a write 1.5 s later only to be refused.
- **Which failures retry by themselves**: a network failure, 408, 429 and every 5xx (including
  503 `auth_unavailable` and `authz_unavailable`), with waits of 2 s, 5 s, 15 s, 30 s, then every
  60 s, for at most 10 minutes. Every other failure is a refusal that cannot pass by itself (401
  signed out, 403 no permission, 400 malformed or `version_required`, 404, 413 too large, another
  409 such as `erased_since_load`): shown, and tried again only on Retry (or Cmd+S); after a 400
  the next change after each 400 gets one debounced attempt as well (fifth review: the change may
  fix it). For 401 this
  differs slightly from decision 4 ("auth retried"): repeating a request every minute while
  signed out achieves nothing until the person signs in, and the message stays visible until
  then.
- **No notice per autosave.** A save changes only the status word; there is no popup.
- **Publish holds autosave.** Publish waits for a save in flight, no save starts while it runs,
  and its success counts as saved. Without this the two requests of one tab would race on the
  version lock and one would be refused by the other. Cmd+S while Publish runs sends nothing of
  its own (the status says Publishing...); anything still unsaved afterwards is saved by
  autosave, and a retry that came due meanwhile is armed again.
- **"Load the newer version" switches autosave off for the rest of that page**, because the page
  reloads (no other `beforeunload` handler in the editor can cancel it).
- **Leaving the editor in the same tab saves a pending change at once** (the controller lives on
  per project, so coming back finds the same state). On `pagehide` or a hidden tab the unsaved
  copy is sent at once (re-review): as a `keepalive` request when the body fits the browser's
  64 KB limit, otherwise as a normal request that may not outlive the page, which the unload
  warning covers.
- **The name is not part of what autosave compares.** The rename route
  (`PATCH /api/projects/<id>`) owns it and the editor mirrors it outside undo history, so a
  rename never triggers a save.

## Design

- `src/lib/projects/autosave.ts`: `AutosaveController`, one per project id in a module registry
  (`autosaveFor`, `existingAutosave`, `allAutosaves`, `subscribeAutosaveRegistry`,
  `anyUnsavedWork`, `reloadDiscarding`). It watches the live `ProjectModel` with an MST (MobX
  State Tree) `onPatch` (volatile state such as `refusedComponents` makes no patch). States:
  `saved`, `unsaved`, `saving`, `publishing`, `retrying`, `failed`, `conflict`. Entry points:
  `saveNow` (a generated page), `flush` (Cmd+S), `retry` (Retry), `saveOver(version)` ("Save
  mine over it"), `exclusive(write)` and `noteConflict` (Publish), `hasUnsavedWork`. A detached
  controller whose project is saved leaves the registry.
- `src/stores/openProject.ts` gains what the controller asks: `isSaved(projectId, snapshot)`
  compares every saved part (pages and components as a load compares them, the whole site
  settings, the analytics binding and the description; not the name) with what the server last
  held for this tab; `isApplyingServerCopy()` is true while a load puts the server copy into the
  store, so that is never a change; `changedElsewhereVersion(projectId)` reports a load that kept
  unsaved work over a newer copy; `noteWriteInFlight` tells a load that a version move may be
  this tab's own write. `markServerVersion` records the saved content too; the load records it
  from the copy as the store holds it, with the model's defaults and repairs, so opening never
  reads as a change.
- `src/lib/projects/projectWrite.ts`: an error carries the HTTP `status` (absent for a network
  failure), which is how a passing failure is told from a refusal.
- `src/lib/projects/saveShortcut.ts` and the `save` binding in `src/lib/keyBindings.ts`:
  Cmd/Ctrl+S, a capture-phase window listener (`installSaveShortcut`, mounted by EditorApp).
- `src/lib/projects/openDrafts.ts`: text typed but not committed yet (inline editor, panel
  field), for the warning, Cmd+S and the leave save.
- `src/app/api/projects/save/route.ts` and `SiteRepository.saveProject`: the attempt key.
- `src/hooks/useAutosave.ts`: `useAutosave` attaches the current project (never the demo) in an
  effect; `useAutosaveState` is the read-only view; `useSaveStatusLabel` is the one wording
  with the 300 ms threshold; `saveFailureReason` says what to do.
- `src/components/EditorAutosave.tsx`: the autosave lifetime, first in the editor shell
  (EditorApp), so its cleanup runs while every open draft is still registered.
- `src/components/SaveStatus.tsx` (replaces `SaveButton.tsx`): shows the state only; Retry,
  Details, "Sign in again", "Changed elsewhere", the version lock dialog, and in the demo "Keep
  as project".
- `src/components/UnsavedWorkGuard.tsx`: the one `beforeunload` and the left-behind notice.
- `src/components/PublishButton.tsx`: the write runs inside `exclusive`; a refusal pauses
  autosave quietly (Publish shows its own dialog).
- `src/components/ai/GeneratePageDialog.tsx`: after a result is applied, `saveNow()`; the line
  under the result is `GeneratedSaveNote`, in the top bar's words.

Persisted parts, checked against the save route (`writeWorkingCopy` in
`src/server/sites/repository.ts`, `projectToPersisted` in `src/server/sites/snapshot.ts`): pages,
component definitions, the whole site settings (with theme and head), the description, the
analytics binding (`lumitra`) and the last-edited time; the server derives redirects. Every one
of them is a field of the `ProjectModel` tree, so every editor change to them (page settings,
home page, site settings dialog, theme and head, definitions, repeat, a generated page or
section) makes a patch and is autosaved (the agent's site operations run on the server and
reach this tab as a newer version, which the version lock handles); `isSaved` compares all of them
except the last-edited time. Not part of the save, and saved by their own routes at once: the
name (rename, `PATCH /api/projects/<id>`), domains, forms, images, published versions
(rollback does not touch the working copy or its version) and the CMS collections.

Usage and cost: at most one save request per 1.5 s of editing pauses and at least one per 10 s
during continuous editing, never more than one in flight, nothing sent for a copy equal to the
server's, retries no more often than once a minute after the fourth, and no retry at all for a
refusal. Each request is the whole project, as Save always sent; the 10 MB cap still applies and
a 413 stops autosave with the message instead of repeating.

## Tests

The four paths of the stateful flow standard (knowledge-base `standards/stateful-flow-testing.md`):

- `src/lib/projects/__tests__/autosave.test.ts` (controller, fake timers, real store and
  `openProject`): forward (debounce, max wait, one trailing save), Cmd+S flushing, backtrack
  (undo before the debounce, revised edit), resume (unload warning, reload, leaving), re-entry
  (409 pause, Cmd+S reopening without a request, "Save mine over it" also over a newer number
  and over an unchanged copy, backoff, the 10 minute cap, refusals with Retry, Retry after an
  undo back), Publish (holds, publishing phase, Cmd+S no-op, a retry armed again, a refused
  Publish), the review cases (no save without a server version, switching projects
  mid-debounce, registry release, background retry of a left project, a load during this tab's
  own save, a foreign write during it still refused), and real content: a style edit on a page
  node with undo and redo through the history store, a new page and its undo, site settings, a
  component definition.
- `src/lib/projects/__tests__/saveShortcut.test.ts`: the binding (Cmd, Ctrl, in a field) and
  the handler (flush, clean copy, demo, other keys).
- `src/components/__tests__/EditorAutosave.test.tsx` (the UI): no Save button; the status words
  and the 300 ms threshold both ways; Cmd+S; Retry after a 500 and after a 403; 401 with "Sign in
  again"; 413 wording; `beforeunload` for the project on screen and one left behind, with the
  notice; "Changed elsewhere" reopening the dialog; "Load the newer version" from the status,
  Publish and the notice without the warning; Publishing...; the demo's "Keep as project"; the
  generator's line in the top bar's words.
- `src/components/__tests__/SiteVersionLock.test.tsx` keeps the version lock's cases, driven by
  an edit and Cmd+S; `DemoProjectSaving.test.tsx` the demo versus a real project.
- Fifth review: the lost-answer chain end to end, the real controller against the real
  `SiteRepository` with a one-row database stand-in (`autosave.lostAnswers.e2e.test.ts`: two
  lost answers then the retry, newer content after two, a third-party write, a stale key after an
  older container); the repository's key binding (latest key, chain, stale key, third party);
  both routes taking `previousRequestKeys`; the controller's list and its cap, the lost "Save
  mine over it", Publish settling and naming the keys, the 400 attempt; the overview's Cmd+S
  with a conflict; Details on Escape.
- Fourth review: the reviewer's probes P1 to P5 (an undo after a lost answer, a 401 between lost
  answers, one recovery attempt also for a 503, leaving during a request, Publish during the
  backoff) in `autosave.test.ts`; the cached unsaved check (`autosave.unsavedCache.test.ts`);
  the measured body size (`saveBodySize.test.ts`); the shared keepalive budget
  (`projectWrite.test.ts` and the UI suite); the hidden tab keeping the inline edit open; Details;
  Cmd+S on the overview.
- Third review: unmounting the editor with a dirty panel draft and with an open inline edit
  saves the text; ColorInput and DimensionInput as open drafts (Cmd+S and unmount), a field
  nobody typed in is none; the notice's countdown outside the live region; "Save mine as a new
  project" ending the warning and the notice; the lost attempt's key in the controller (an edit
  during the backoff, a new version), the repository and the route;
  Publish refusing the key; recovery of 401 and stopped failures; the reload re-armed by a sign
  and not by time or after pagehide; the preview's Cmd+S block.
- Re-review: `src/stores/__tests__/openProject.test.ts` (stale read with and without unsaved
  work, legal details and description kept); `SaveShortcutInFields.test.tsx` (Cmd+S through the
  inline editor and the panel field: prevented, typed text saved, counted as unsaved);
  `projectWrite.test.ts` (key, keepalive limit, 2xx without version); controller and UI tests for
  the key reuse, the cancelled reload, the cleared pause, pagehide and hidden tab, online, the
  countdown and the announcements; `repository.test.ts` and `save-route.test.ts` for the
  stored-result replay.

## Open

- Pending, not done: a check in the browser on app.lumitra.co after the deploy: edit, wait,
  reload, the change is there; generate a page, reload, it is there; reload while saving, the
  browser warns; Cmd+S shows no browser dialog (also while typing on the canvas and in the
  panel); signed out in another tab, the status offers "Sign in again", Retry saves; Back from
  Preview after a few saves keeps the newest copy.
- The migration `20261104000000_site_last_write_key` runs with the deploy (additive, two
  nullable columns: `last_write_key` and, since the fifth review, `last_write_version`). It was
  extended in place rather than followed by a second migration because it has only ever run on
  continuous integration's throwaway databases, never on a database that is kept.
