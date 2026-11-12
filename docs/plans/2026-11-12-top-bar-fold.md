---
title: The editor top bar's fold and the agent chip
description: Decision record for how the editor's wide top bar gives way when its controls do not fit, and for the agent presence chip's own slot beside the save status.
summary: Seen on production on 2026-11-12 at about 1680px, on a site branch while an agent wrote, the agent's note was drawn over the save status and both were unreadable, and the page name was cut short. The note is now a compact chip ("Agent editing") in a slot of its own beside the save status, with the full sentence in a tooltip that keyboard focus opens too; neither ever shrinks. From 1024px up the bar measures what it holds and folds in a fixed order (words of four buttons, then the page name, then the secondary icons into More), so it never squeezes or overlaps a control. Under 1024px the compact bar of the editor-on-phones plan stays as it was.
type: plan
status: completed
date: 2026-11-12
tags: [framer-clone, editor, top-bar, accessibility, live-agent-canvas, branches, plan]
projects: [framer-clone]
---

# The editor top bar's fold and the agent chip

## What was wrong

Marlin's screenshots of 2026-11-12, 15:02 (app.lumitra.co, site "Lumitra (new landing page)", branch "Test new design", window about 1680px):

1. The agent note ("lumitra-sites-agent-mcp is editing thi...") was drawn over the save status ("Saved"). Cause: the save status had `min-w-0` and no-wrap words, so it shrank to almost nothing and its words spilled under the note beside it.
2. The note truncated both the agent's name and the action, so it said neither.
3. The bar held back, site name, branch switcher, Branch badge, page name, Generate, Polish, status and note, Share preview, Review and merge, settings, theme, preview, undo, redo and history. The page name and the note took the squeeze, and the branch controls were folded by fixed window breakpoints (`2xl`, `lg`) that knew nothing of what the bar held.

## Decisions

Taken by the session lead's brief and, where the brief left a choice, by the worker; say so if you disagree.

1. **The agent chip has a slot of its own.** It sits beside the save status in one status slot (`data-testid="topbar-status-slot"`), and neither shrinks on the wide bar. The chip is the presence dot (the existing `bg-agent-presence`, drawn in the text colour under forced colours) and a short label built from the activity mode and the agent count: "Agent editing", "Agent reading", "2 agents planning". It is a button: pressing it opens the Agent activity feed, which keeps every step. Its accessible name is the short label; the full sentence ("lumitra-sites-agent-mcp is editing this site") is its description and its tooltip, which hover and keyboard focus both open. The polite announcer (`AgentAnnouncer`) is unchanged. Under 1024px the chip is the dot alone, with the same name, description and tooltip.
2. **The fold is measured, not guessed.** The header is fixed to the full window, so a container query on it would only be a media query in disguise, and it could not tell a branch (more controls) from main. Instead `useTopBarFold` (`src/components/topbar/fold.ts`) measures, in a layout effect, what the bar's content needs at the level shown (its scroll width less the free gap in the middle), remembers that need per level, and steps one level at a time until the content fits. Each step renders before paint (`flushSync` from the ResizeObserver and MutationObserver callbacks), so nobody sees a bar that does not fit. A level's need does not depend on the window's width, because every control keeps its own width until the last level, so the fold settles and never swings. A change of what the bar holds (an agent starts, a save fails, a branch control appears, a name changes) clears the remembered needs.
3. **The fold order**, each level keeping the folds before it:
   1. Generate, Polish, Share preview and Review and merge lose their words and become icon buttons, each keeping its name for a screen reader and saying what it does in a tooltip. Update (on a branch behind main) folds with them, and the sentence "Main has changed" goes; its results and refusals always show.
   2. The page name narrows from 10rem to 6rem (its full name on hover, and in the Pages panel), and the Branch badge gives way (the switcher names the branch and its menu says what a branch is).
   3. Site settings, theme and history, and on main the published versions, domains, form submissions and the light and dark switch, move into the More menu (the Radix menu: `aria-haspopup="menu"`, arrow keys, Escape returns the focus). Last, the site and branch names truncate.
   - Never folded: undo, redo, preview, the save status and the agent chip. Review and merge (or Publish on main) stays the bar's one filled button at every level; Publish keeps its words.
4. **The page name's width is 10rem, as before** (160px). A 16rem cap was tried: with the production page name it made the bar fold its words at exactly 1680px. At 10rem the 1680px branch bar of the screenshot keeps every word.
5. **Under 1024px nothing changes**: the compact bar of `docs/plans/2026-10-24-editor-on-phones.md` (undo and redo in the bottom bar, everything else in More) still applies, and the fold stays at level 0 there.
6. **Every control keeps its own width on the wide bar.** Nothing in it shrinks except the free gap in the middle (and, at the last level, the site and branch names), so what the bar needs can be measured and the bar folds instead of squeezing. A branch note's result or refusal ("Updated from main", a conflict) wraps inside its own cap of 20rem to 26rem, as before. A first version let these sentences shrink to a floor; the behaviour proof caught the bar overflowing by 3px at 1680px with "main has changed" showing, because a shrinking note hides the overflow from the measure.

## Measured

In Chromium, the bar of the screenshot (branch, agent at work, the production names) needs 1661px with every word, 1300px at level 1, 1169px at level 2 and about 1024px at level 3. It settles on level 0 at 1680px, 1 at 1440px, 2 at 1280px and 3 at 1024px. The same bar on main needs 1420, 1296, 1232 and 1012px. These figures drive the component test `src/components/__tests__/TopBarFold.test.tsx`; the real layout is proven in Chromium and WebKit in `test/behaviour/branches.spec.ts` (the save status and the agent chip never overlap, nothing is over another or outside the window, at 1680, 1440, 1280, 1024, 768 and 390px).
