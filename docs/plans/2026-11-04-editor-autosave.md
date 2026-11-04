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
  409 such as `erased_since_load`): shown, and tried again only on Retry (or Cmd+S). For 401 this
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
  per project, so coming back finds the same state). No save is attempted during unload itself:
  `fetch` with `keepalive` caps the body at 64 KB and a project can be megabytes; the warning
  covers that case.
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
  Cmd/Ctrl+S, handled first by EditorApp's single keydown dispatcher.
- `src/hooks/useAutosave.ts`: `useAutosave` attaches the current project (never the demo) in an
  effect; `useAutosaveState` is the read-only view; `useSaveStatusLabel` is the one wording
  with the 300 ms threshold; `saveFailureReason` says what to do.
- `src/components/SaveStatus.tsx` (replaces `SaveButton.tsx`): the status, Retry, "Sign in
  again", "Changed elsewhere", the version lock dialog, and in the demo "Keep as project".
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

## Open

- Pending, not done: a check in the browser on app.lumitra.co after the deploy: edit, wait,
  reload, the change is there; generate a page, reload, it is there; reload while saving, the
  browser warns; Cmd+S shows no browser dialog; signed out in another tab, the status offers
  "Sign in again", Retry saves.
