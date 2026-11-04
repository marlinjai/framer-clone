---
type: plan
status: in-progress
date: 2026-11-04
title: "Editor autosave: the working copy saves by itself"
summary: "The editor saves the project about 1.5 s after the last change (at most 10 s after the first), right away after a generated page, through the same request and version lock as Save. A refusal by the version lock pauses autosave and asks; passing failures retry with backoff; a beforeunload warning covers unsaved or in-flight work. Save stays as save now and shows the state. The demo editor at / keeps its Save-as flow."
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

Decided by Marlin on 2026-11-04 (the brief of this work):

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
7. Save stays as "save now" and shows the state: Saved, Saving..., Unsaved changes, or the error.
8. The generator's "Save the project to keep it" line goes away (it says Saved instead).

Decided while building (say so if you disagree):

- **A maximum wait of 10 s.** A pure trailing debounce never fires during a long drag or a long
  typing burst, which is exactly when work piles up; the first unsaved change is saved at most
  10 s later.
- **Resuming after a 409 needs a successful write of this tab**: "Save mine over it", a click on
  Save that succeeds, or a Publish that succeeds; or a reload ("Load the newer version"). "Keep
  editing" closes the dialog and leaves autosave paused (the top bar says why and that clicking
  Save asks again). Resuming on "Keep editing" would bring the dialog back 1.5 s later, the loop
  decision 3 forbids.
- **A load that kept this tab's work over a newer server copy starts paused.** `openProject`
  already reports this (`changedElsewhere`, with the editor's notice); autosave starts in the
  paused state with the server's version, so "Save mine over it" works at once, instead of
  sending a write 1.5 s later only to be refused.
- **Which failures retry by themselves**: a network failure, 408, 429 and every 5xx (including
  503 `auth_unavailable` and `authz_unavailable`), with waits of 2 s, 5 s, 15 s, 30 s, then every
  60 s. Every other failure is a refusal that cannot pass by itself (401 signed out, 403 no
  permission, 400 malformed or `version_required`, 404, 413 too large, another 409 such as
  `erased_since_load`): shown, and tried again only on the next click on Save. For 401 this
  differs slightly from decision 4 ("auth retried"): repeating a request every minute while
  signed out achieves nothing until the person signs in, and the message stays visible until
  then.
- **No notice per autosave.** On the compact top bar a success notice is a popup under the bar;
  one at every pause in typing would be constant noise. An autosave changes only the button
  label; a click on Save still shows "Saved n pages".
- **Publish holds autosave.** Publish waits for a save in flight, no save starts while it runs,
  and its success counts as saved. Without this the two requests of one tab would race on the
  version lock and one would be refused by the other.
- **Leaving the editor in the same tab saves a pending change at once** (the controller lives on
  per project, so coming back finds the same state). No save is attempted during unload itself:
  `fetch` with `keepalive` caps the body at 64 KB and a project can be megabytes; the warning
  covers that case.
- **The name is not part of what autosave compares.** The rename route
  (`PATCH /api/projects/<id>`) owns it and the editor mirrors it outside undo history, so a
  rename never triggers a save.

## Design

- `src/lib/projects/autosave.ts`: `AutosaveController`, one per project id in a module registry
  (`autosaveFor`, `existingAutosave`). It watches the live `ProjectModel` with an MST (MobX State
  Tree) `onSnapshot`, which also leaves out volatile state such as `refusedComponents`. States:
  `saved`, `unsaved`, `saving`, `savedNow` (a click succeeded), `retrying`, `failed`, `conflict`.
  `saveNow` (a generated page), `saveManually(overVersion?)` (the button and the dialog),
  `exclusive(write)` and `noteConflict` (Publish), `hasUnsavedWork` (the unload warning).
- `src/stores/openProject.ts` gains what the controller asks: `isSaved(projectId, snapshot)`
  compares every saved part (pages and components as a load compares them, the whole site
  settings, the analytics binding and the description; not the name) with what the server last
  held for this tab; `isApplyingServerCopy()` is true while a load puts the server copy into the
  store, so that is never a change; `changedElsewhereVersion(projectId)` reports a load that kept
  unsaved work over a newer copy. `markServerVersion` records the saved content too; the load
  records it from the copy as the store holds it, with the model's defaults and repairs, so
  opening never reads as a change. When the debounce fires on a copy that equals the saved one
  (an undo back, a repair), nothing is sent.
- `src/lib/projects/projectWrite.ts`: an error carries the HTTP `status` (absent for a network
  failure), which is how a passing failure is told from a refusal.
- `src/hooks/useAutosave.ts`: `useAutosave` attaches the current project (never the demo),
  registers the `beforeunload` listener and returns the state; `useAutosaveState` is the
  read-only view.
- `src/components/SaveButton.tsx`: the label shows the state; the top bar status
  (`TopBarStatus`) shows a click's success, a failure, or a paused conflict; the dialog's choices
  call the controller. "Load the newer version" turns the warning off before reloading.
- `src/components/PublishButton.tsx`: the write runs inside `exclusive`; a refusal pauses
  autosave quietly (Publish shows its own dialog).
- `src/components/ai/GeneratePageDialog.tsx`: after a result is applied, `saveNow()`; the line
  under the result is `GeneratedSaveNote` (Saving..., Saved, Not saved yet), and "Save the
  project to keep it" stays only in the demo editor. `editorBridge.applyResult` stays a pure
  model function.

Usage and cost: at most one save request per 1.5 s of editing pauses and at least one per 10 s
during continuous editing, never more than one in flight, nothing sent for a copy equal to the
server's, retries no more often than once a minute after the fourth, and no retry at all for a
refusal. Each request is the whole project, as Save always sent; the 10 MB cap still applies and
a 413 stops autosave with the message instead of repeating.

## Tests

The four paths of the stateful flow standard (knowledge-base `standards/stateful-flow-testing.md`):

- `src/lib/projects/__tests__/autosave.test.ts` (controller, fake timers, real store and
  `openProject`):
  - forward: one save after the debounce with the loaded version, the answered version adopted;
    a 12 s burst saved by the max wait; changes during a request make exactly one trailing save
    of the latest state;
  - backtrack: an edit undone before the debounce sends nothing; a revised edit saves the current
    state; back to the saved state after a save sends nothing;
  - resume: unsaved and in-flight work reported for the warning, not when clean; "Load the newer
    version" turns it off; after a reload the saved content opens through `openProject` and
    nothing is sent; leaving the editor sends a pending save at once;
  - re-entry: a 409 pauses (later edits, "Keep editing" and a generated page send nothing),
    "Save mine over it" sends the reported version and resumes; a click while paused asks again;
    a load that kept work over a newer copy starts paused; a 5xx and a network failure retry with
    the backoff, which grows and stays at its last step; 400, 401, 403, 404 and 413 never retry
    by themselves and a click tries again;
  - opening a project (also again in the same tab, renamed or with a newer server copy) sends
    nothing; a generated page saves at once; Publish holds autosave; a refused Publish pauses it.
- `src/components/__tests__/EditorAutosave.test.tsx` (the UI): the label through Saved, Unsaved
  changes, Saving..., Saved with no request on open and no notice per autosave; a server error in
  the top bar and the retry; `beforeunload` while dirty or in flight and not when clean or after
  the editor closed; the dialog's pause, "Keep editing", asking again, "Save mine over it"
  resuming; "Load the newer version" without the warning; the demo editor never saving or
  warning; a generated page saved at once with "Saved." in the dialog.
- `src/components/__tests__/SiteVersionLock.test.tsx` keeps the version lock's earlier cases
  (the clean button now reads "Saved").

## Open

- A check in the browser on app.lumitra.co after the deploy: edit, wait, reload, the change is
  there; generate a page, reload, it is there; reload while saving, the browser warns.
