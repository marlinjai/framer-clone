---
type: plan
status: draft
date: 2026-11-12
title: "Which page is open after Undo and Redo: the editor never ends with no page selected"
summary: "Undo of a page addition, or Redo of it, leaves the editor on \"No page selected\", because the open page is a reference that clears when its page leaves and nothing opens another. This records the reproduction, the root cause, three options for where the rule lives and what Redo should open, a recommendation, and the stateful-flow tests the fix needs. A draft: it needs one decision before anything is built."
tags: [framer-clone, editor, history, undo, selection, pages]
projects: [framer-clone]
---

# Which page is open after Undo and Redo

Found on 2026-11-12 while proving slice T5 (the AI generator's site tokens) in a real browser: Undo then Redo of a generated page restored the page and its theme token exactly, then the editor showed "No page selected". The roadmap line "Editor history leaves no page selected" in the root `ROADMAP.md` is this plan's home. It is the history store's and not the generator's: a plain Add page, Undo, Redo does the same.

## The failure, reproduced twice

1. **In the browser** (headless automation Chrome, the demo editor): Add page, then Undo: the Pages panel loses "Page 2" and the editor says "No page selected". Redo: "Page 2" is back in the list and the editor still says "No page selected". Opening the page from the Pages panel shows its content.
2. **At the store level, no browser** (`createRootStore`, `createPage`, `setCurrentPage`, `HistoryStore.undo`, `redo`): after the addition `currentPage` is Page 2; after Undo it is none; after Redo the page is in the project and `currentPage` is still none.

Both leave the document correct. Only the open page is wrong.

## Root cause

- `EditorUIStore.currentPage` is `types.maybe(types.safeReference(PageModel))` (`src/stores/EditorUIStore.ts`). A safe reference sets itself to undefined when the page it points at leaves the tree. Undo of an addition removes the page, so the reference clears.
- Selection is outside history by design (`src/stores/HistoryStore.ts` header: "selection/tool state in EditorUIStore ... stay out of history"). So Redo re-adds the page, and nothing writes the reference again.
- Nothing else reacts. The flows that delete a page on purpose choose a fallback themselves: the Pages panel's delete (opens the first other page, `PagesPanel.tsx`), `openProject.pickPage` on a load (the home page, else the first), and `AgentDeletedPageWatcher` for a page an agent deleted (which also reopens the page when any undo brings it back, but only while its own notice is up).
- `Canvas.tsx` then renders "No page selected", and the Layers and properties panels have nothing to show.

So the gap is general: any history step that removes the open page (Undo of an addition, Redo of a deletion, jumping in the history panel) leaves no page open, and a step that restores a page opens nothing.

## What is decided already, and what is not

Decided and not touched: the document is right after every step (the T5 regression test proves it for a generated page: the snapshot after Redo equals the snapshot after the apply); selection stays out of history, so Undo does not undo a selection.

Not decided anywhere in `docs/`, which is why this is a plan and not a fix:

1. Which page is open after an Undo that removes the open page.
2. Whether a Redo that restores a page opens it, or leaves the person where they are.
3. Where the rule lives, because a wrong place breaks the agent-delete watcher's contract or fires on ordinary edits.

## Options

**A. A fallback only.** When the open page leaves and pages remain, open the home page (else the first), the rule `pickPage` uses. (The Pages panel's own delete opens the first other page instead; the two rules differ today.) Redo opens nothing; the person stays on the fallback and can open the restored page. Smallest change, never leaves the editor empty, but Redo then shows a different page from the one just redone.

**B. Fallback plus follow the history.** A as above, and the page a history step restores opens: Undo of a deletion and Redo of an addition open the page that came back (the rule `AgentDeletedPageWatcher` already applies to an agent's deletion). The person sees what the step did. Needs to know which step restored which page.

**C. Make selection part of the history entry.** Each entry records the open page before and after. Exact, but it contradicts the decision that selection is outside history, and a remote adoption or a jump through several entries has no single "before".

## Recommendation: B, in one small reaction in the editor, not in the history store

Keep `HistoryStore` pure (it must not know the editor). Add a small observing component beside `AgentDeletedPageWatcher`, mounted once in the top bar, that reacts to the history position (`undoIdx`) and the project's page ids:

- **Only on a history step** (an `undoIdx` change not caused by a new recorded action, i.e. the length of `history` is unchanged or an entry was undone or redone), compare the project's page ids before and after the step.
- **A page was added by the step:** open it (the last one added when several). This covers Redo of an addition and Undo of a deletion, and agrees with the agent-delete watcher.
- **The open page was removed by the step:** open the home page, else the first page that remains (`pickPage`'s rule: the person has just lost the page they were on, so the site's front page is the stable landing), with the same selection of its root component that `setCurrentPage` makes.
- **Otherwise do nothing**, so an ordinary edit, a rename or a selection change never moves the person.
- Leave a page the agent-delete watcher is already reopening to it: it clears its notice in the same reaction, so the two must not fight (the new reaction runs after, and only when a page is still not open).
- A remote adoption (another writer's save, recorded as a remote entry) is not a person's Undo or Redo: it keeps its existing handling (`adoptServerCopy` moves the canvas when the open page is gone) and the new reaction ignores entries marked `remote`.

Why not A alone: it fixes "nothing selected", and leaves Redo showing the wrong page, the very symptom that was reported ("the page is there but I cannot see my generation"). Why not C: it reverses a deliberate boundary for a small benefit.

## What would be built (after the decision)

- `src/components/HistoryPageFocus.tsx` (a renderless observer, mounted next to `AgentDeletedPageWatcher` in `TopBar.tsx`) and a small pure function `pageAfterHistoryStep(before, after, openPageId)` in `src/lib/history/pageFocus.ts` that returns the page id to open or nothing, so the rule is unit-testable without React.
- No change to `HistoryStore`, `EditorUIStore.currentPage` or any model.

## Tests (stateful flow, the four paths)

Store and component level, real `RootStore` and `HistoryStore`, no mocks of either:

- **Forward:** add a page and open it; Undo opens the home page; Redo opens the restored page. The same for a generated page with a token (slice T5): the page opens and its hero shows the token's colour.
- **Backtrack and revise:** Undo, then a new edit (which discards the redo stack) never moves the open page; Undo twice then Redo once opens only what that Redo restored.
- **Resume from persistence:** reload the project at an earlier step (a fresh `openProject`): the existing `pickPage` rule still decides, and the new reaction does nothing on load.
- **Re-entry after completion or failure:** delete the open page and Undo the deletion (the page opens again); Undo when the only other page is the home page; a step that removes a page that is not open leaves the open page alone; an agent's deletion and its Undo through the notice still open the page exactly once; a remote adoption does not trigger the reaction.
- **The browser:** the same flow in the editor with `dev-browser`: Add page, Undo, Redo, with the Pages panel's current row and the canvas checked after each, and the same for a generated page (network reply stubbed, no model).

## Open question for the owner

One: B (recommended) or A alone. A small second choice rides on it: whether the fallback is the home page (recommended, as on load) or the first other page (as the Pages panel's delete does). Nothing is built until it is answered.
