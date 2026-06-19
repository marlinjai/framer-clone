---
name: agent-team-continuation
type: handover
title: framer-clone CMS workspace + content agent + editor refresh — agent-team continuation
summary: Bootstrap prompt for a fresh agent team to finish the CMS workspace, content agent, and editor chrome refresh, writing missing scopes then spawning teammates under the established conventions.
date: 2026-06-20
tags: [cms, agent-team, handover, studio-design-system]
---

> Paste the block below into a FRESH Claude Code session at the project root
> (`projects/framer-clone`). It is self-contained: it tells the lead where the
> work stands, the conventions, the roles, and how to orchestrate the rest.

---

You are the **Lead** of an agent team continuing a substantial, already-in-flight build on **framer-clone** (a Framer/Webflow-class visual website builder). Your mission: finish the **CMS workspace**, the **content agent**, and the **editor chrome refresh** to best-in-class quality, by writing any missing scopes + implementation plans, then spawning and coordinating specialist teammates to execute, following every established convention, production-grade, with zero tech debt.

## 0. First moves (before touching code)
1. Read your persistent memory: `~/.claude/projects/-Users-marlinjai-software-dev-ERP-suite-projects-framer-clone/memory/MEMORY.md` and the files it points to, especially `project_cms_grid_datatable_rebuild_2026_06_19.md` (the full state of this build). Read the global `~/.claude/CLAUDE.md` and the project `.claude/rules/suite-context.md`.
2. Open + screenshot the two APPROVED design mockups (these are your visual targets, match them exactly): `docs/specs/build-2026-06/editor-chrome-redesign-mockup.html` and `docs/specs/build-2026-06/cms-workspace-agent-mockup.html`.
3. Read the architecture spec `docs/specs/build-2026-06/cms-content-tier/slice2b-cms-datatable-grid-ui.md` (completed).
4. `git log --oneline -8` on branch `feat/cms-grid-studio-refresh` (open as **PR #30**). The tree is GREEN at HEAD (`a13aee1`).

## 1. Where it stands
- Branch `feat/cms-grid-studio-refresh` / PR #30, all gates green (`tsc`, `lint`, `pnpm test` = 564 headless tests, `build`).
- DONE: the data-table-react CMS editing grid (server-actions adapter over the existing PrismaAdapter); the "Studio" design system (iris `--brand` #5B5BD6 + `--status-*` on the shadcn Tailwind-v4 tokens); whole-editor blue→iris accent migration + chrome token-polish; the Content panel redesign; the item detail panel + reserved Draft/Published "Status" select field; the collection settings dialog (icon picker + auto slug); the grid light-theme fix (`.light` on `<html>` + `src/app/cms-grid-theme.css`).
- APPROVED, NOT YET BUILT (your work): (a) the **editor chrome redesign** (Layers tree + right Properties panel); (b) the **CMS workspace phase 1** (collections navigator rail + full-screen `[rail | grid]` workspace + per-collection item counts); (c) the **content agent phase 2** (the right-rail AI agent — write a spec first).
- Run it: `docker start fc-dev-pg`; then `DATABASE_URL='postgresql://fc:fc@localhost:55432/framerclone' FRAMER_CLONE_ADMIN_SECRET='dev-local-verify' pnpm exec next dev -p 3001`. CMS writes require an `admin_secret=dev-local-verify` cookie in the browser. Throwaway Docker Postgres, fully migrated.

## 2. Non-negotiable conventions (the memory + CLAUDE.md hold the full set)
- **Design** — the Studio system: iris `--brand` accent, `--status-published/draft/scheduled`, the shadcn `--color-*` tokens. NO hardcoded gray/blue/red Tailwind colors anywhere; everything token-driven (light + dark ready). Reuse the `src/components/ui/*` primitives (button `brand` variant, dropdown-menu, alert-dialog, dialog) and the Studio patterns. The data-table grid must stay light (don't regress the `.light` fix).
- **CMS architecture** — data-table-react IS the engine; never hand-roll a grid. In-collection writes go through the server-actions adapter (`src/server/cms/actions.ts`, admin-guarded via `requireAdminAction`); collection CRUD via the admin-guarded `/api/cms/*` routes; reads public. Reserved "Status" select field per collection via `ensureStatusField`. Single-tenant; server-only DB; UI never touches MST for CMS data.
- **Quality** — production-grade, not gate-passable: cover unhappy paths, surface errors loudly, no silent failures. ZERO tech debt: fix every follow-up in the same PR, never park a TODO. Headless `.test.ts(x)` coverage for anything correctness-bearing (the `pnpm test` gate excludes `.itest.ts`). The left/right editor panels are MobX-State-Tree driven: preserve all store wiring, only restyle.
- **Gates before every commit** — `pnpm exec tsc --noEmit` + `pnpm lint` + `pnpm test` + `pnpm build`, all green. Then live-verify in the running editor and screenshot. Synthetic browser events are unreliable for drag/grid interactions; verify those manually.
- **Process hygiene** — NEVER run `pnpm build` while `pnpm dev` holds the same `.next` (it clobbers the dev server: kill dev + `rm -rf .next` first). Secrets via Infisical / the secrets-proxy ONLY (never `.env`, never `op run`). NO em-dashes or en-dashes anywhere (code, prose, commits, docs). Expand acronyms on first use. Commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context)` line; PR bodies end with the Claude Code generated-by line.
- **Docs** — follow the document-lifecycle standard: specs are `type: plan`, `status: draft → decided → in-progress → completed`, under `docs/specs/build-2026-06/<track>/`.

## 3. The team (roles)
Stand up these roles as teammates. Each role: read the context + its mockup; if its area lacks a scope + implementation plan, WRITE one (a `type: plan, status: draft` spec) and get it decided (you decide per the conventions; escalate genuine product/UX forks to the human); then implement to the mockup + conventions; verify (all gates + live); report. Parallelize ONLY across disjoint file sets; one integrator commits.

1. **Lead / Orchestrator (you)** — own the roadmap + task list; write/assign specs; spawn + coordinate teammates; enforce conventions + gates; integrate; run the global gates; commit + manage the branch/PR. You write only integration glue, not feature code.
2. **Design Systems Engineer** — editor chrome redesign (Layers tree + right Properties panel) per `editor-chrome-redesign-mockup.html`. Files: `src/components/sidebars/left/LayersPanel.tsx`, `src/components/sidebars/right/*`. Preserve all MST wiring; token-driven only.
3. **CMS Workspace Engineer** — CMS workspace phase 1 per `cms-workspace-agent-mockup.html` (LEFT collections navigator rail + CENTER items grid; agent deferred). A full-screen `[rail | grid]` overlay: the rail lists all collections (icon + name + item count + active state + the existing Open/Rename/Settings/Delete actions) with Collections/Fields/Bindings tabs (Collections active; others "coming soon") + a toolbar; clicking a rail row swaps the center grid without closing. REUSE the existing `CmsGrid` for the center. Files: `src/components/cms/*` + item-count plumbing (`Collection.itemCount` in `src/lib/bindings/dataSource/types.ts`, populated in `src/server/cms/repository.ts listCollections` via a cheap per-table count). Collection grouping/sub-collections need a data-model feature — flat for phase 1.
4. **Content Agent Engineer** — phase 2: the right-rail AI content agent. WRITE THE SPEC FIRST. Scope (per the mockup's right rail): a chat panel that drives the CMS in natural language — CSV import, generate/translate/bulk-publish, edit fields — via tool-use over the CMS server actions, with an agent-run model and reversible changes (Undo all). Use Claude via the AI SDK (default to the gateway `"anthropic/claude-..."` string, the latest Claude model); LLM calls stay server-side; reuse the existing `/api/ai/*` patterns.
5. **Platform / Data Engineer** — CMS server tier + data-model extensions: item counts, collection grouping/sub-collections, a Featured-column convention, the agent's tool API + run/undo persistence, and the deferred file/image storage slice (Storage Brain — flag the Infisical/env needs). Writes stay admin-guarded; reads public.
6. **QA / Verification Engineer** — the gates, headless test coverage, live verification (screenshots), accessibility (focus rings, contrast, 44px targets, aria), and a no-tech-debt sweep before each merge.

## 4. Execution mechanism
- Orchestrate via the **Agent tool** (forks for disjoint parallel work — never overlapping files), the **`autonomous-orchestration` skill** (the orchestrator CLI: a goal file → Worker + Decision Proxy loop that lands a scoped spec end-to-end autonomously), and/or the **Workflow tool** for deterministic fan-out (e.g. a review → adversarial-verify pipeline before merge).
- Sequencing: the editor chrome (role 2) and CMS workspace phase 1 (role 3) can run in PARALLEL — disjoint files. The content agent (role 4) is phase 2: it plugs into the workspace, so land the workspace first and get the agent spec decided before building it.
- After each teammate reports: integrate, run the full gates, live-verify + screenshot, then commit onto `feat/cms-grid-studio-refresh` (or a stacked branch) and keep PR #30 (or successors) current.

## 5. Definition of done
CMS workspace + content agent + editor chrome complete, mockup-quality, all gates green, live-verified, zero tech debt; specs marked `completed`; PR(s) ready for review; ROADMAP updated / `/release` run; memory refreshed.
