---
title: Page generator ideas, Enhance and streaming sections
description: Plan for three additions to the Generate with AI dialog, an idea row to start from, an Enhance button that rewrites a brief, and a page that builds itself section by section while the model writes it.
summary: Pull request 1 adds tailored idea chips with a static fallback and a streamed Haiku rewrite of the brief with one-step undo. Pull request 2 streams complete top-level sections into a detached draft drawn on the canvas, so the result still lands as one undo step and is never saved half-finished.
type: plan
status: in-progress
date: 2026-11-04
tags: [framer-clone, ai, plan, page-generation, streaming]
projects: [framer-clone]
---

# Page generator ideas, Enhance and streaming sections

## Context

The "Generate with AI" dialog (`src/components/ai/GeneratePageDialog.tsx`, opened from the top bar) had a bare brief textarea. Three things were missing:

1. **No starting points.** A new user faces an empty box. Lumitra Studio's composer has "Assist", which turned out to be a fixed, searchable list of phrases with no AI behind it (`lumitra-studio/src/components/create/composer/AssistMenu.tsx`).
2. **No help with a weak brief.** Studio has "Enhance": one fast-model call that rewrites the prompt, with a one-step undo in the toast (`lumitra-studio/src/lib/enhance/*`). It is not streamed there.
3. **The page appears all at once.** The server already streams the model's tool input (`anthropic.beta.messages.stream` with eager input streaming, `src/lib/ai/pageGen/runPageGeneration.ts`), but it only counts characters for a progress line. The nodes reach the canvas in one piece after validation, a repair round and the image lookups. On Sonnet that is a long wait in front of a spinner.

The goal: ideas to start from, a fast rewrite of a brief typed by hand, and a page that visibly builds itself section by section while the model writes it. The result must still land as **one** undo step, and it must not be saved half-finished.

## Decided

- **The ideas are tailored, with an instant fallback.** Static ideas alone would not know the site. When the dialog opens, a curated static set shows at once. A Haiku call with the project context (project name, existing page titles, site context, target mode) then replaces it with 6 ideas for this site. A "More ideas" button fetches a fresh set. The ideas are cached per project for the browser session, so reopening the dialog costs nothing.
- **Enhance streams into the textarea** on Haiku (`claude-haiku-5-5`). The brief is rewritten word by word, so the result is visible within a second. Undo restores the original brief, as in Studio.
- **Streaming granularity: top-level sections.** A section (the hero, the features, the footer) is the natural unit: big enough to be worth showing and small enough to arrive every few seconds. The section still being written shows as a skeleton band ("Writing section 3...").
- **The streamed sections are a draft that never enters the project tree.** The undo history records MobX-State-Tree (MST, the in-memory tree behind the editor) patches with array indices (`src/stores/HistoryStore.ts`). Draft nodes inserted into the page would shift those indices for any edit made during the run, and later undos would misapply. So the draft is a detached MST tree held by the run, built with `ComponentModel.create` and not attached to the project. The canvas draws it in place of the target through `HeadlessComponentRenderer`, which needs no parent. When the final validated result arrives, the existing tracked apply runs unchanged and the draft is dropped. Cmd+Z goes back to the page before generation. The draft cannot be saved or published, because it is not in the project.
- **Two pull requests.** (1) Ideas plus Enhance: small, and independent of streaming. (2) Progressive streaming. The model context protocol (MCP) tool `generatePage` (`src/server/siteOps/index.ts`) shares `runPageGeneration`; the new section callback is optional there, so the MCP path is unchanged.

## Pull request 1: idea row and Enhance

### Server

- `src/app/api/ai/page-ideas/route.ts` and `src/app/api/ai/enhance-brief/route.ts` share one guard chain (`src/lib/ai/brief/routeGuard.ts`), the same boundary as `generate-page`: a zod body, `getVerifiedSession`, `resolveActiveScope`, `authenticateRequest(..., 'editSite')`, `withAuthAvailability` and `getAnthropicClient`.
- `src/lib/ai/brief/`:
  - `ideas.ts`: Haiku, effort low, a tool `emit_ideas` with `{ ideas: [{ title, brief }] }`, 6 items, each brief 1 to 3 sentences in the site's language. The context is what the generator's `buildRequest` sends: project name, existing page titles, site context and target kind (`siteInput.ts` builds it in the editor). For replace or insert the ideas are about the selected section (its serialized summary, about 2,000 tokens). The output is checked: trimmed, capped, duplicates and existing page titles dropped, fewer than 3 usable ideas is `invalid_output`.
  - `enhance.ts`: Haiku text streaming. The system prompt keeps every fact, name, constraint and the language of the brief, and adds structure only: sections in order, audience, tone, the main call to action, and content per section. It never invents prices, addresses or claims. Plain text, at most about 150 words, capped at the 4,000 characters the generator accepts. Streamed back as Server-Sent Events (SSE) through `src/lib/ai/sse.ts`: `enhance:delta`, then `enhance:done` or `enhance:error`, then `usage`.
  - `staticIdeas.ts`: the curated fallback, 12 page types (landing page, pricing, about, contact, blog index, product launch, event, portfolio, restaurant menu, shop front, careers, FAQ), each with a page brief and a section brief. The dialog picks 6 by target mode.
- Rate limits (`src/lib/ai/brief/rateLimit.ts`, built on `src/lib/ai/pageGen/rateLimit.ts`): ideas 20 and enhance 20 per user per 10 minutes, and one Enhance in flight per user. Over the limit returns 429 with `retry-after`, as the generate route does. Usage goes through `logAiCall` and `recordUsage`.

### Dialog

- An idea row above the textarea (`src/components/ai/IdeaBar.tsx`): chips (title only, the brief as tooltip and accessible description), a "More ideas" button, and a quiet static-tint skeleton while the tailored set loads. Picking a chip fills the brief, but never overwrites typed text without an undo: when the textarea has text, the pick replaces it and offers Undo under the brief. Keyboard: the row is one tab stop (a toolbar with a roving tabindex), arrow keys and Home / End move between chips, Enter picks.
- An "Enhance" button (wand icon) beside the character counter (`src/components/ai/EnhanceButton.tsx`, state in `src/components/ai/useBriefAssist.ts`), disabled for an empty brief. While it runs: `aria-busy`, a Stop button, the textarea read-only and filling as the text streams in, Generate disabled. Afterwards an "Undo enhance" link brings back the original until the next edit. If the stream fails midway, the original is restored and the error is shown. Errors are shown in the dialog (429 with the wait time, network, model error), never swallowed.
- The draft persistence (`framer-clone:page-gen-draft:`) saves the finished enhanced brief, never the partial text of a running stream. The undo copy is kept in memory only.

### Tests

- Route tests (`src/app/api/ai/__tests__/brief.routes.test.ts`): auth, 400, 429 with `retry-after`, the output shape against a fake Anthropic client, and a stream cut off midway.
- Unit tests for the prompts, the output checks, the static set and the browser client (`src/lib/ai/brief/__tests__/`).
- Dialog tests (`src/components/ai/__tests__/GeneratePageDialog.brief.test.tsx`) with the four paths of the stateful-flow standard: forward (pick an idea, generate), backtrack (enhance, undo, edit, enhance again, the undo copy dropped after an edit), resume (reload with a saved draft, a reload mid-stream keeps the original), re-entry (after a generation, "Generate another" shows the ideas again). Plus a stream cut off midway, Stop and a 429.

### Decided while building pull request 1 (say so if you disagree)

- **Stop restores the original brief** instead of keeping the partial rewrite: a half-written brief is worse than either version, and Enhance can simply be run again.
- **One Enhance in flight per user**, besides the window limit, reusing the generator's limiter. A second call while one runs answers 429 with a plain "still running" message; the button is disabled meanwhile, so a person never sees it. Ideas count against the window only: switching the target quickly aborts one fetch and starts the next while the aborted call may still hold a slot on the server.
- **An Enhance that hits the 60-second timeout reports `timeout`**, not the abort it surfaces as, so the dialog never says "stopped" when nobody pressed Stop.
- **The tailored set waits once the row was touched**: the button then reads "Show ideas for this site" and shows it without a second call; the next press is "More ideas" with the shown titles excluded.
- **The cache key is project, target kind and selected component**, so section ideas for one component never show for another target.
- **The static ideas are English.** The tailored set follows the site language; translating the static set belongs to the editor's localisation, which does not exist yet.
- **Errors of `page-ideas` map to HTTP statuses** (502 for unusable output or a refusal, 503 for a provider outage, 504 for the 30-second timeout); Enhance reports them inside its stream.

## Pull request 2: the page builds itself

### Server: find complete sections inside the streaming JSON

- New `src/lib/ai/pageGen/sectionStream.ts`: an incremental scanner over the raw tool-input text. It tracks string and escape state and the bracket depth, finds the `nodes` array, and yields each top-level element as soon as its closing brace arrives. It is a pure function with unit tests: escaped quotes and braces inside strings, chunk boundaries anywhere, `nodes` not being the first key, an empty array, and malformed JSON (it yields nothing and never throws).
- In `runPageGeneration.ts`, the `inputJson` handler feeds the scanner on the **first attempt only**. Each complete section is validated alone with `validateGeneration` against the remaining node budget. A section that fails validation is skipped in the preview (the final result corrects it anyway). A section that passes is sent as a new event `gen:section { generationId, index, node, attempt }`. Images in a draft section keep their placeholders; the Unsplash lookups and focal points still run once, on the final result.
- `src/lib/ai/pageGen/protocol.ts`: add the `gen:section` type. `runPageGeneration` gets an optional `onSection` callback, so the MCP caller passes nothing.
- `src/lib/ai/jobRegistry.ts`: the job keeps the sections sent so far, and `GET /api/ai/generate-page/[id]` returns them. A client that resumes after a reload or a dropped stream rebuilds the draft and continues.

### Client: a draft layer on the canvas

- `src/lib/ai/pageGen/flow.ts`: add `sections` to the running state, keyed by `requestKey`, so a late event from an older run is still dropped.
- New `src/lib/ai/pageGen/draft.ts`: a small observable draft store on the editor UI, `{ requestKey, target, sections }`. Each section snapshot first goes through the existing `toEditorSnapshot` / `breakpointKeyMap` (`apply.ts`), so its style keys match the real breakpoint ids, and is then built with `ComponentModel.create` and kept detached.
- Canvas: when a draft exists for the page on screen, the viewport renderer draws it with `HeadlessComponentRenderer`. New page: a draft canvas named after the requested title. Replace: the target's place shows the draft sections instead. Insert: the sections show after the target's existing children. The draft is visual only: not selectable, not in the layers panel.
- The user keeps working (runs survive app switches since 2026-10-29). Nothing is locked; on another page the draft is simply not drawn.
- Final result: the existing `applyResult`, then the draft is cleared in the same tick, so there is no empty frame. The undo record is exactly today's. Cancel, error and expiry clear the draft and change nothing else. Repair round: the attempt-1 draft stays and the progress line says "Polishing" until the final result replaces it.
- Spike first: render one detached tree through `HeadlessComponentRenderer` inside a canvas viewport, with bindings and the site theme. If anything in it reaches for the project, the fallback is a read-only, untracked copy of the target page that the run owns.
- Canvas feel: each section enters with a 200ms ease-out fade and an 8px rise, no animation with reduced motion, a static skeleton tint with no shimmer, and the canvas scrolls to a new section only if the user has not scrolled away.
- The dialog becomes a slim floating progress panel while sections arrive ("Section 3 of about 6", Cancel), so the canvas is visible. The full dialog returns for the result actions.

### Tests

- `sectionStream` unit tests, plus a fuzz test that cuts a real recorded tool input at every offset.
- `runPageGeneration` with a fake stream: `gen:section` arrives in order, before `gen:result`; nothing is sent on the repair attempt; the MCP path sends nothing.
- Bridge and history: one Cmd+Z after the final apply restores the page from before generation with no draft left; an edit during the run, the final apply, then two undos both land correctly; the saved snapshot during a run holds no draft; cancel mid-stream leaves the page unchanged; a resume through GET rebuilds the draft.
- Four paths: forward; backtrack (cancel mid-stream, change the brief, generate again); resume (reload mid-stream); re-entry (generate another after a result, and after an error).

## Also

- Neither pull request touches money, checkout or security beyond the existing auth chain, so both land through land-pr without the `hold` label.
- Per-section validation calls `validateGeneration({ nodes: [section] }, { allowStickyCta: false, ... })`. The page-level checks (essentials, tells) run on the final result only.

## Progress

- 2026-11-04: pull request 1 (the idea row and the streamed Enhance) merged as #327. Pull request 2 (the page that builds itself as a draft, branch `feat/pagegen-streaming`) is open; while it runs, the dialog gives way to a floating progress panel, so the idea row and Enhance live in the editing phase only, and the full dialog returns for the result.

## Verification

- `pnpm vitest run src/lib/ai src/components/ai`, then the full suite, lint and typecheck.
- In the browser through `dev-browser-auto` (headless), on the local dev server with the dev Infisical identity: the static then tailored ideas, picking one, Enhance streaming in and Undo; for pull request 2, a Haiku generation captured at about 3 points showing sections appearing, Cmd+Z back to the earlier page with no draft, a reload mid-run that brings the draft back and finishes, a cancel that leaves the page untouched, and a saved project without draft nodes.
