---
title: Live replay of a settled edit on top of an agent's write
description: Plan for keeping both changes when an agent writes while a person edits the open site, instead of asking with the Site Changed dialog, for the cases where that is safe.
summary: When a person's edit, made while an agent's newer copy of the site was held, only replaced values of nodes the agent left alone, the editor undoes the edit, adopts the agent's copy and applies the edit again as one undo step under its own name, saved at once on the agent's version. Real conflicts still open the dialog. Built in #353, taken out after four review rounds; continues here on its own.
type: plan
status: decided
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

The implementation and its tests are on branch `feat/live-replay-on-top` (built in #353, taken out of it on 2026-11-09). The autosave deferral (point 3) is at #353's commit 0de7c711. Open before it can land, from review round four:

1. A merged save refused (409) because the agent wrote again: the replay again only works when the agent's copy arrives before the refusal; in the common ordering the refusal comes first and the dialog opens. Keep the replay mark when a refusal settles with nothing held, and replay once the copy arrives.
2. Cmd+S right after typing commits the draft and saves in the same step, before the replay can run, so the dialog opens. While a copy is held for editing, Cmd+S should replay first, then save.
3. Deferring autosave while a copy is held for the person's editing, so a save on the old version is never sent and refused mid-gesture (today the dialog can still open under the cursor then, as before the live canvas). Built in #353 and taken out after two review rounds; the last found that a later `noteChangedElsewhere` cleared the wait for the edit to end, so the dialog could never open, that the wait had no idle limit, and that a stop() of one sync could remove another's edit check. The code is on the same branch (`deferWhileLiveHeld`, `setEditInProgressCheck` in `src/lib/projects/autosave.ts`).
4. Fresh reviews of its own, on a branch from main that carries only these.

It must not block the deploy of the live agent canvas hardening (#350, #351, #353).
