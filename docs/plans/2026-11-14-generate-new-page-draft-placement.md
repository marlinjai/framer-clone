---
type: plan
status: draft
date: 2026-11-14
title: "A generated new page shows as a page from the first second, not as frames on another page's canvas"
summary: "Marlin reported that generating a page with AI showed it on the same canvas as another page instead of as its own page in the left Pages selector. A local reproduction with a real editor store shows the finished result is right (one new page, opened, draft gone) and that what he saw is the designed draft: while the run is going, a new page is drawn as ghost frames beside the open page's own frames, and it joins the project, and so the Pages panel, only when the result is applied. This records the evidence, the cause, three options, a recommendation and the stateful-flow tests, and needs one decision before anything is built."
tags: [framer-clone, editor, ai, page-generation, pages-panel, draft]
projects: [framer-clone]
---

# A generated new page shows as a page from the first second

Reported by Marlin on 2026-11-14: generating a new page with AI "appears on the same canvas as another page instead of as a separate page in the left Pages selector". Nothing was deployed or changed; no model was called.

## What was checked

- **Code path:** the Generate dialog (`src/components/ai/GeneratePageDialog.tsx`) defaults to the "New page" target. During a run it fills a draft store (`src/lib/ai/pageGen/draft.ts`, `PageGenDraftStore`). `targetOn(pageId)` returns the draft for the page the run started on (or, for an agent's new page, for whichever page is open: `followsCurrentPage`). `DraftPageFrames` (`src/components/ai/PageGenDraftLayer.tsx`) draws the new page's three frames, titled with a "Draft" chip, to the right of the open page's own frames, in the same canvas. Only on the result does `applyResult` (`editorBridge.ts`) call `ProjectModel.addGeneratedPage`, which adds the page to the project in one history entry, after which the dialog opens it (`setCurrentPage`) and saves at once.
- **Reproduction, no browser, no model:** the real `RootStore` and the real dialog with an injected transport (the harness of `GeneratePageDialog.test.tsx`, run in a scratch test, not kept). Readouts: while running, the project has 3 pages, the open page is the starting one, `pageGenDraft.target` is set (the ghost frames). After the result: 4 pages, the new page open, the draft cleared, the starting page's nodes unchanged. The existing 25 dialog tests pass on `origin/main` (71137133). So the finished state is correct for the in-editor dialog.
- **Completed generation and adoption, on a scratch Postgres (added 2026-11-14, no paid call):** `src/server/siteOps/__tests__/generatePageAdoption.itest.ts` (run with `pnpm test:integration`) uses the integration harness's throwaway Postgres container and a scripted model. Agent path: a one-page site is saved, an editor store opens it, `generatePage` (the agent's tool) saves a new page through the real repository, and the stored site read back holds two pages: the new one with its own id, slug `menu`, title, its section and three frames, the home page untouched (one child). The open editor then adopts that version with `adoptServerCopy`, the same call the live sync makes: its Pages list is Home, Menu; the open page stays Home (by the adoption rules, the new page opens only when its draft frames were in view, otherwise a notice offers it: `liveSync.test.ts`, "a new page drafted out of view ... waits in the Pages panel"); nothing was put into the home page. Editor path: `applyResult` adds the page, the project as the save sends it is stored on the version read, and a fresh editor load lists both pages. Both pass. Not covered: the save route's HTTP layer and sign-in (the repository call it makes is covered), and a browser run of the real canvas.

## Cause

Not a defect in the apply; a gap in the draft's presentation. For the whole run (often minutes) the new page exists only as ghost frames on the starting page's canvas. The Pages panel has no row for it, so it reads as "this was added to that page". If the person switches page mid-run the ghost frames vanish with no sign of where the work went (`targetOn` matches the starting page only), and a run that ends in a refused apply, a Cancel or an error leaves no page and no trace. The ghost frames' chip says "Draft" but not "a new page called X is being made".

The design is deliberate and documented (live agent canvas plan: "a new page as draft frames ... beside whichever page is on screen"); no decided plan says what the Pages panel should show during a run, which is why this is a plan and not a fix.

## Open question for the owner: ask him which moment he meant

He is unsure whether he saw it during or after generation. After is now checked on both paths and the page is separate (see above), so the in-progress display is the only reading that matches. If it ever recurs after the run ended, capture the Pages panel and the version number at that moment: that would be a different bug this plan did not find. The options below are for the in-progress reading; choosing one is his.

## Options

**A. A transient row, same ghost frames (recommended).** While a new-page run is active the Pages panel shows a dimmed row "Bakery, being generated" with a spinner at the end of the list (a view of the draft store, not a project page, so saving, history, slugs and Cancel are untouched). The ghost frames' chip reads "New page: Bakery" instead of "Draft". Pressing the row focuses the draft frames; a finished run replaces the row with the real page, which is the page that opens. Smallest change, no model change, no new history rules.

**B. Create the page at once, draw into it.** The empty page joins the project when the run starts (untracked), the draft is drawn on its own canvas, and the result fills it. The most honest picture, but it reverses "nothing enters the project until the result is valid" (a cancelled or refused run must then delete a page, a reload mid-run can save an empty page, the one-undo-step contract changes) and the live sync's agent path needs the same.

**C. Words only.** Change the chip to "New page: X (added to Pages when done)". Cheapest, still no row.

## Recommendation: A

It answers the reported confusion (a page in the selector from the first second, clearly not part of the open page), leaves the apply contract alone, and extends to the agent's draft (the same store). Not B: it moves the apply boundary for a presentation problem. Not C alone: it explains the gap and does not close it.

## What would be built (after the decision)

- A pure selector `generatingPageRows(draft)` in `src/lib/ai/pageGen/draft.ts` (or beside it) returning the transient rows; the Pages panel renders them after the real pages, never in the page list the project holds, drag order or keyboard order of real pages.
- The chip text in `DraftPageFrames`; a press on the row focuses the draft frames (the camera follow already knows how).
- No change to `ProjectModel`, `applyResult`, history or the save.

## Tests (stateful flow, the four paths)

- **Forward:** start a new-page run: one transient row, real pages unchanged; the result: the row is gone, one real page, opened, one history entry.
- **Backtrack and revise:** Cancel, an error or a refused apply removes the row and leaves no page; a second run replaces the first's row, never two; switching to another page mid-run keeps the row and the draft is still reachable.
- **Resume from persistence:** reload mid-run (`savePendingRun`): the resumed run shows the row again; a run the server no longer has removes it.
- **Re-entry after completion or failure:** Generate another; the Replace and Insert targets show no row (they draw in place); an agent's draft shows the same row and the result opens as today.
- **The browser:** the same in the editor with `dev-browser` on the demo editor, reply stubbed (no model): Pages panel and canvas checked during and after.

## Roadmap

One line on the root `ROADMAP.md` points here.
