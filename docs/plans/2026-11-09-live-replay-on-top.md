---
title: Live replay of a settled edit on top of an agent's write
description: Plan for keeping both changes when an agent writes while a person edits the open site, instead of asking with the Site Changed dialog, for the cases where that is safe.
summary: When a person's unsaved edit only replaced values of nodes an agent's newer copy left alone, the editor undoes it, adopts the agent's copy and applies it again under its own name, saved at once on the agent's version. Real conflicts still open the dialog. Built in #353, merged in #358 for edits made while the copy was held; extended on 2026-11-12 to a settled edit whose save was waiting or out (all unsaved steps since the last saved copy, or none).
type: plan
status: in-progress
date: 2026-11-09
tags: [framer-clone, editor, live-sync, plan]
projects: [framer-clone]
---

# Live replay of a settled edit on top of an agent's write

## Why

The live agent canvas (shipped; the editor follows every write of an agent) holds an agent's newer copy while the person types, edits text, drags or resizes, and once the edit settles opens the Site Changed dialog if the person's copy is unsaved. The dialog loses no work, but it makes the person choose between their edit and the agent's write even when the two touched different nodes. This plan keeps both in that case.

## What it does (decided)

- Only for a settled edit that is the person's one undo step since the hold began (found by history entry id) and that only replaced values of nodes (text, props, styles, a resize, the same value several times, also inside reusable components) the agent's copy still has, with the first old value unchanged there.
- The edit is first tried on a scratch copy of the agent's version: it must apply, and no reusable component the edit touches may grow past its size limit. Only then the person's step is undone, the agent's copy adopted, and the edit applied again as one undo step under its own name, then saved at once on the agent's version. Undo afterwards takes the person's step back first, then the agent's write.
- Everything else opens the dialog with the person's edit kept: the agent changed the same value, removed the node or page, the edit was a move, a page or site setting.
- Never while the person is still editing, and a replay that cannot be applied whole is taken back entirely with a notice.

## State of the work

Rebuilt on 2026-11-10 on a fresh branch from main, `feat/live-replay-on-top-v2` (the first branch, `feat/live-replay-on-top`, sat on #353's history before its squash), in three commits so one can come out on its own:

1. **The replay core**, ported from #353 onto main as it now is (after #355 and #356). A mark taken when a version was announced during editing is now dropped on any adoption (a stale mark, a low finding of #353's fourth review).
2. **The two orderings the fourth review found:**
   - A merged save refused before the agent's newer copy arrives (the usual order: the refusal is one round trip, the copy two): the replay mark is kept while the refusal stands, and the newer copy, fetched by the stream event or a poll, replays the edit on top of it.
   - Cmd+S right after typing: the shortcut asks the live sync to look at a copy held for that typing (`settleHeldEdit`) after committing the drafts and before saving, so the edit is replayed and saved on the agent's version instead of a save on the old version that is refused.
3. **The dialog gate, instead of deferring saves (decided, say so if you disagree).** Point 3 of the first version deferred autosave during the hold, and its reviews kept finding problems in it. What it was for is that no refused save opens the dialog under the cursor. A smaller mechanism gives that: the dialog of a refusal (409) waits while the person is mid-edit or a replay of the refused edit is pending (`setConflictDialogHold`, installed by the live sync), and opens once neither holds, at most after 60 s. Saves go out as before. Its watcher is apart from the save timers, so a version move by the live sync does not end the wait (the high finding of round seven); "Keep editing" is honoured; a sync removes only its own hold.

With the replay and the gate together, a refused save never shows a dialog that the replay resolves a moment later: the refusal waits, the newer copy arrives, the edit is replayed and saved.

Decided (say so if you disagree): a replay pushes the person's step on top of the history, so the Undo of the notice for a page an agent deleted (offered while that deletion is the last step, #355) gives way to the ordinary undo; the two only meet when the agent deleted the open page while the person edited another node of it, and then the edited node is gone with the page, so the dialog asks instead.

It must not block the deploy of the live agent canvas (completed 2026-11-09).

Merged on 2026-11-10 as #358 (29934db6).

## The edit nothing marked (2026-11-12)

A production proof on 2026-11-12 found the most common ordering still opened the dialog: the person commits a text edit (Enter), so the edit is settled and nothing marks it; its save is in the 1.5 s autosave wait or already out; the agent writes another node through the Model Context Protocol (MCP) endpoint. The save is refused with 409 (Conflict), or the agent's copy arrives first while the save waits, and the dialog opens although the edit is replayable. A second, smaller finding: while a marked replay was about to resolve a refusal, the top bar said "Not saved: this project was changed somewhere else. Choose what to keep." for about a second.

What changes:

1. **The replay finds the edit itself when nothing marked it.** `unsavedStepsMark` walks the undo history down from the top, applying each step's inverse patches to a plain copy of the working copy (nothing in the editor changes), until that copy is exactly the last saved copy. The steps above that point are the person's unsaved work. `rebaseEdit` then runs as before, with its safety check unchanged: once those steps are really undone, the working copy must equal the saved copy, otherwise nothing is replayed and the dialog asks.
2. **Where it is tried.** In `take`, when a newer copy arrives and the working copy is unsaved with no write of this tab out: either autosave is still waiting (phase `unsaved`, the 1.5 s debounce, so no refusal at all), or a refusal is held for it (below). Never while the person is mid-edit (the marked path handles that), and never once the dialog stands open: then the person decides.
3. **The refusal holds its dialog for the try.** The hold the live sync installs in autosave (`setConflictDialogHold`) is now told of the refusal as it lands, before the write counts as settled (until now it was only asked whether to hold, and at that moment nothing marked the edit, so the dialog opened at once). It holds when the person's unsaved steps can be found and are all values of nodes. The hold ends when the copy has been tried, or after `LIVE_HELD_FETCH_MS` (10 s) when the copy never comes; a failed try opens the dialog within one check (0.5 s).
4. **The status waits with the dialog.** A held refusal carries `held: true` in the autosave state. The top bar shows "Unsaved changes" (not "Changed elsewhere"), the screen reader hears nothing yet, and the flag goes as soon as the dialog opens (by itself, "Keep editing" or the status). This covers the marked path's flash too.

Decided (say so if you disagree), which edits are covered when several are unsaved: **all of the person's steps since the last saved copy, or none.** Concretely, a replay carries the run of history steps on top of the history (no redo tail) whose undo leads exactly back to the saved copy, when every one of them is a step of this tab (not an adopted write), only replaces values of nodes the newer copy still has, the newer copy left the first old value of each value unchanged (for a value several steps edit, the first old value of the oldest), and there are at most `LIVE_REPLAY_MAX_STEPS` (10) of them. With several steps, a step that replaces a node's children is not covered (the steps are resolved on today's tree, and a children replace could move the nodes an earlier step meant). Each step is applied again as its own undo step under its own name, in order, and saved once on the newer version, so undo after the replay takes back the person's latest step first, then the earlier ones, then the agent's write. So two quick edits inside one autosave window, or a second edit made while the first one's save is out, are both replayed. If any one step is not covered (a page or site setting, a move, the agent changed the same value), none is replayed and the dialog asks, with every edit kept. Reasoning: replaying only the latest step would leave the earlier unsaved step either lost or saved over the agent's write, and the safety check exists precisely to rule out replaying over other unsaved work; replaying all or none keeps that guarantee without a dialog for the most frequent case. The same rule now applies to the marked path (the steps since the mark), which before took exactly one step.

Decided (say so if you disagree), the cost of finding the steps: a first pass reads only the history (the run of this tab's value replacements on top), so a step that cannot be replayed costs nothing; only within that run is a plain copy of the site made and compared with the saved copy, once per step. Measured by the fresh review on the roughly 400-node, 160 KB performance site: about 5 ms per step in Node, at most 10 steps, and only when a save is refused or an agent's copy arrives during the 1.5 s wait. A deeper speed-up (comparing only the values the steps touched) would need the saved copy kept as a tree instead of one comparison key, which is not worth it at that cost.

Fixed after the fresh review of the pull request (#408): a held refusal put back after a Publish that changed nothing gets its timer again (it stayed held for good before, with no way to the dialog from the status); an edit mark whose copy already came no longer stops the refusal from being held (the edit marked while typing, then saved with Cmd+S before the copy came); a refused "Save mine over it" reopens the dialog at once instead of being held as a replay; an edit undone back to the saved copy while its refusal waits lets the copy be adopted, without a dialog about nothing; the notice of a failed replay of several steps says how many edits were taken back.

Fixed after CodeRabbit's review of #408: every step boundary of a multi-step replay must fit a reusable component's size limit, not only the end (each boundary is a state undo can bring back); and a replayed edit holds a refused save's dialog only while it waits for something (its save out, a copy held for it, or the copy being fetched, at most `LIVE_HELD_FETCH_MS`), never for a refused "Save mine over it".

Not covered, on purpose: unsaved work with no history behind it (the history was emptied, as a load does) is never replayed, since nothing says which values are the person's; the dialog asks and the work is kept.

Tests (src/lib/projects/__tests__/liveSync.test.ts, "a settled edit whose save was waiting or out when the agent wrote", and src/components/__tests__/EditorAutosave.test.tsx for the status): the save in flight with the copy first and with the refusal first; the 1.5 s wait; two edits in one window; a second edit while the first save is out; the agent writing the same node (dialog, in flight and in the wait); Cmd+S during the window; undo after the replay taking back only the person's step; a tab that only polls; no conflict wording on the way; a copy that never comes (dialog after 10 s); a copy that comes once the dialog stands open (nothing changes under the person); the four paths of the stateful flow standard (forward; backtrack and revise: the same value edited twice, an edit undone back to the saved copy; resume: the live sync restarted with the edit waiting, and an emptied history; re-entry: after a replay that failed and after a real conflict resolved with "Load the newer version"). Each fix was checked by reverting it: at least one of these tests fails without it.

