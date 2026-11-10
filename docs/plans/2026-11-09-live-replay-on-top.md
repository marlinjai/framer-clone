---
title: Live replay of a settled edit on top of an agent's write
description: Plan for keeping both changes when an agent writes while a person edits the open site, instead of asking with the Site Changed dialog, for the cases where that is safe.
summary: When a person's edit, made while an agent's newer copy of the site was held, only replaced values of nodes the agent left alone, the editor undoes the edit, adopts the agent's copy and applies the edit again as one undo step under its own name, saved at once on the agent's version. Real conflicts still open the dialog. Built in #353, taken out after four review rounds; continues here on its own.
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

Known limit: a replay pushes the person's step on top of the history, so the Undo of the notice for a page an agent deleted (offered while that deletion is the last step, #355) gives way to the ordinary undo; the two only meet when the agent deleted the open page while the person edited another node of it, and then the edited node is gone with the page, so the dialog asks instead.

It must not block the deploy of the live agent canvas (completed 2026-11-09).
