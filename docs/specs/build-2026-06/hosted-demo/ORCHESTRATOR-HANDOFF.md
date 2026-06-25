---
name: orchestrator-handoff-framer-build-dag
type: handover
title: Orchestrator handoff: framer-clone hosted-demo + content-agent build DAG
summary: Self-contained handoff for a FRESH ultracode session to drive the autonomous orchestrator (CLI) and land the §17 build plan. main is reconciled and green; specs are on main; here is exactly what to dispatch and what is blocked on Marlin.
date: 2026-06-25
tags: [orchestrator, handoff, framer-clone, hosted-demo, content-agent]
---

# Orchestrator handoff: framer-clone build DAG (for a fresh ultracode session)

> Paste this into a FRESH Claude Code session at the framer-clone repo root, with **ultracode ON**.
> It is self-contained. Your job: operate the **autonomous-orchestration** skill (the orchestrator
> CLI: Worker + Decision Proxy, one goal file per task, worktree, verify-gated, auto-review -> PR ->
> merge) to land the build DAG below, ultracode-thorough (adversarially review each Worker diff
> before merge). Two things are BLOCKED on Marlin (see section 6): do NOT do them autonomously.

## CRITICAL UPDATE (2026-06-25): an unmerged static-publish pipeline already exists

A PRIOR orchestrator run (`task-id framer-p2-publish`, state `completed`, tamper-clean) already built
a **static-HTML publish pipeline** and it is sitting UNMERGED on branch `orchestrator/framer-p2-publish`
(commit `f0903ee`, 14 files, based on the P1 foundation that is now main). It contains:
`projectPublisher` + per-page static HTML emitter (inline) + `assetCollector` + `manifest` +
`experiments` (A/B) + `trackerSnippet` (analytics injection, injects only the public `ap_live_` key) +
a local/memory `diskSink` seam (NO real R2/Cloudflare call). Worktree at `../framer-clone-orch-p2`.

This MATERIALLY changes section 4. Two consequences, reconcile BEFORE writing render-layer goal files:
1. **Architecture fork (needs a decision, likely Marlin's):** `f0903ee` took the **static-HTML-emit**
   path. The demo plan + Marlin's verbal decision were **SSR-on-request**. The static path is now
   ~80% built. Options: (a) ADOPT the static pipeline (mostly done, finish + wire it), (b) keep its
   reusable parts (`trackerSnippet`, `experiments`, `assetCollector`, `manifest`, the sink seam) and
   build the renderer as SSR, (c) do pure SSR and shelve the static work. Read `f0903ee`'s diff
   (`git show f0903ee` / check out `../framer-clone-orch-p2`) AND `docs/plans/2026-06-23-framer-hosting-platform-foundation.md`
   first, then either proceed with strong justification or escalate the fork to Marlin. Do NOT
   silently pick; this reshapes tasks #1 and #3 and folds in #8 (analytics).
2. **Do NOT auto-merge `f0903ee` blind.** It is a completed run, but it predates the SSR decision and
   is unreviewed. Reconcile the architecture first. The `framer-server-renderer` / `framer-publish-write`
   tasks below must be rewritten against whatever architecture is chosen (and against the P1
   `Site`/`SitePage` models), not built greenfield.

## 0. First moves
1. Invoke the `autonomous-orchestration` skill (it is the operator playbook; read it before dispatching).
2. Read, in this order: `docs/plans/2026-06-23-framer-hosting-platform-foundation.md` (the P1 hosting
   plan, now AUTHORITATIVE for the render layer), `docs/specs/build-2026-06/cms-content-tier/slice4-content-agent-phase2.md`
   (the locked content-agent spec), `docs/specs/build-2026-06/hosted-demo/hosted-page-demo.md` (the
   demo plan, PARTIALLY SUPERSEDED, see section 4), `src/lib/renderer/publish/hydrateBindings.ts`,
   `src/server/sites/snapshot.ts` + `src/server/sites/repository.ts`.
3. Prune the stale orchestrator worktree (see section 5, pre-flight).

## 1. Current state (verified 2026-06-25, all gates green)
- `main` HEAD = `09d9701` (#33), on top of `2d0c830` (#31), `43dc93c` (#30), `140bc6b` (#29).
- **Reconciliation is DONE.** PR #30 (Studio design wave: editor chrome redesign + CMS workspace
  phase 1) and PR #31 (P1 hosting foundation) were merged to main; they were nearly disjoint (no
  schema conflict). PR #33 recovered the locked slice4 spec that PR #30's push had missed.
- **Combined main is GREEN:** `pnpm exec tsc --noEmit` (0), `pnpm lint` (0), `pnpm test` (632 tests,
  75 files), `pnpm build` (ok, `ƒ Middleware` active). Reconfirm with `rm -rf .next && tsc && build`
  (the `.next/types` cache goes stale and reports phantom errors for the deleted column/row routes).
- The local `feat/cms-grid-studio-refresh` branch was pruned (fully merged). No active orchestrator
  task should be using it.

## 2. What is DONE (do not rebuild)
- Editor chrome redesign + CMS workspace phase 1 (#30): the `[rail | grid]` `CmsWorkspaceOverlay`
  (with a RESERVED right-column slot for the content agent), Studio tokens, `Collection.itemCount`.
- P1 hosting foundation (#31): Prisma `Site` / `SitePage` / `SiteDomain` / `SiteExperiment` models +
  migration `20260624000000_site_persistence`; `src/server/sites/` (`repository.ts`, `snapshot.ts`,
  `scope.ts`, `errors.ts`); `src/middleware.ts` (host-based routing); auth-brain integration
  (`src/lib/auth*.ts`, `permissions.ts`); `.env.example`.

## 3. What EXISTS but is NOT wired (the levers for the render layer)
- `src/lib/renderer/publish/hydrateBindings.ts`: PURE, expands CMS Collection/RecordView + commerce
  ProductList/ProductDetail into primitive subtrees, leaves the 4 interactive commerce kinds as
  islands. Written, NEVER CALLED.
- `getCmsRepository()` (`src/server/cms/`, server-only, Prisma): RSC-callable, implements the
  `CmsReadRepository` hydrateBindings expects.
- ALL render components are `'use client'` + `observer()` + hooks. The published page therefore does
  NOT port them; it renders the already-expanded primitive tree from hydrateBindings + emits the 4
  islands. This is LOW risk (verified): a pure snapshot tree-walk, not a renderer rewrite.

## 4. The build DAG (dispatch one orchestrator goal file per task)

Reconcile the demo plan with the P1 foundation FIRST: the P1 branch already shipped persistence
(`Site`/`SitePage`) + middleware + auth, which the `hosted-page-demo.md` plan listed as TODO under a
`PublishedSite` name. ADOPT the P1 `Site`/`SitePage` models as canonical; DROP the `PublishedSite`
proposal; build the render layer ON TOP of `src/server/sites/snapshot.ts`. Write/refresh the
per-task specs accordingly before authoring goal files.

| # | Task (task-id) | What | spec / DoD source | depends_on | shared_state | status |
|---|---|---|---|---|---|---|
| 5 | `framer-content-agent` | The right-rail NL content agent: `/api/ai/cms-agent` route (Anthropic tool-use loop, SSE via `src/lib/ai/*`), 14 tools over the admin-guarded CMS actions, `AgentRun`+`AgentChange` undo persistence, the agent panel in the workspace right slot. | `slice4-content-agent-phase2.md` (LOCKED, all 5 Lead-required fixes already in it) | (none; CMS workspace is on main) | `prisma`, `migrations` | READY: dispatch FIRST |
| 1 | `framer-publish-write` | Publish write: serialize the MST project to a `SitePage` snapshot via `src/server/sites/snapshot.ts`; admin-guarded `POST /api/projects/publish`; a "Publish" button in the editor top bar. Plus VERIFY the auth-brain integration actually gates CMS+commerce writes (replace any `can()` stub usage). | write a thin spec from `hosted-page-demo.md` item #1-2 reconciled to the P1 `Site`/`SitePage` models | (none) | maybe `prisma` if it adds fields (prefer not) | READY after demo-plan reconcile |
| 2 | `framer-commerce-read-repo` | `getCommerceServerRepository()`: read-only Prisma (`listProducts` / `getProductByHandle` / `listVariants` / `getPrices` / `getAvailability`). Today only write/tx-bound commerce repos exist. | `hosted-page-demo.md` item #3 | (none) | (none) | READY (parallel-safe) |
| 3 | `framer-server-renderer` | `ServerComponentRenderer` (snapshot tree-walk + emit the 4 commerce islands) + the public RSC route `app/(site)/[[...slug]]` that resolves the site (via the existing `middleware.ts`), loads the `SitePage` snapshot, runs `hydrateBindings(snapshot, params, {cmsRepo, commerceRepo})`, returns HTML + islands. | `hosted-page-demo.md` items #4-5 reconciled to P1 | `framer-commerce-read-repo` (uses it) | (none) | dispatch after #2 merges |
| 6 | `framer-ci-integration-tests` | Wire `pnpm test:integration` into CI (it runs nowhere today; the only CI check is a GitGuardian scan, so local verify is currently the only gate). | the known CI gap (orchestrator memory) | (none) | (none) | READY (parallel-safe, low risk) |
| 4 | `framer-prod-provision` | scaffold-project: Postgres + Infisical + Coolify + wildcard DNS + DNS-01 cert + analytics injection. | `hosted-page-demo.md` items #7-8 | #1, #2, #3 | n/a | BLOCKED on Marlin, do NOT dispatch (section 6) |

File/image storage (real Storage Brain/R2) is a separate later task; today upload throws a loud
unconfigured error. Defer (needs Storage Brain provisioning).

Suggested dispatch order (respecting the 3-concurrent cap + shared_state):
- Wave A (parallel): `framer-content-agent` (prisma writer, runs alone among prisma tasks),
  `framer-commerce-read-repo`, `framer-ci-integration-tests`.
- Wave B: `framer-publish-write` (after demo-plan reconcile), `framer-server-renderer` (after #2 merges).
- Then STOP and hand prod (#4) to Marlin.

## 5. Orchestrator operating notes (the essentials; full detail in the skill)
- CLI confirmed installed at 0.3.0 (meets the 0.3.0 minimum). `orchestrator start --goal <path>
  --project <repo> --task-id <id> --max-iterations N --max-hours H [--worktree]`. Default
  `--auth-mode subscription` (scrubs `ANTHROPIC_API_KEY`, uses the Claude login; note: headless
  subscription is METERED as of 2026-06-15). Goal files at `~/software-dev/orchestrator/goals/<id>.md`,
  template at `goals/_template.md`.
- **Stakes gate: framer-clone is `stakes_tier = 2` (reversible)** in `~/.config/orchestrator/repos.toml`,
  so the orchestrator WILL start without `--confirm-stakes`. (erp-suite and the orchestrator repo are
  tier 3: NEVER pass `--confirm-stakes` for those on your own judgment.)
- Goal frontmatter: `task`, `spec`, `depends_on`, `shared_state`, `verify`, `verify_fix_cap: 2`,
  `verify_timeout_s: 1800`. Use the `shared_state` vocab: `prisma`, `migrations`, `lockfile`.
- **Worktree node_modules:** a fresh worktree has none. Either install once in a manual worktree
  before launch, OR have the goal instruct the Worker to `pnpm install && pnpm exec prisma generate`
  first. The `verify` command must run in a worktree that has deps. The pnpm "multiple lockfiles"
  warning (it selects the ERP-suite root lockfile) is BENIGN; install completes.
- **verify command** (the in-loop completion gate): for prisma-touching tasks use e.g.
  `DATABASE_URL='postgresql://x:x@localhost:5432/x' pnpm exec prisma generate && pnpm exec tsc --noEmit && pnpm lint && pnpm test && DATABASE_URL='postgresql://x:x@localhost:5432/x' pnpm build`.
  The dummy DATABASE_URL is fine: prisma generate + next build do not connect; headless tests mock.
- **CI is only a GitGuardian scan** (no test workflow), so YOUR local verify (the `verify:`
  frontmatter + your manual gate before merge) is the authoritative gate.
- **Auto-review -> PR -> merge is the operator's job** and is DELEGATED to you for orchestrator slices
  (Marlin's standing rule, tier-2). Squash-merge, `--delete-branch`. NEVER push to main directly;
  always PR. After each merge: `git fetch --prune`, `git checkout main && git pull`, remove the
  worktree + branch. Ultracode: adversarially review each diff (acceptance criteria, signature
  changes, no scope creep, no test-tampering) before merging.
- **Pre-flight prune (DO THIS FIRST):** there is a STALE worktree
  `../framer-clone-orch-p2` on `orchestrator/framer-p2-publish` (f0903ee) from a prior run. Check
  `~/.orchestrator/tasks/framer-p2-publish/state.json`: if terminal + merged/abandoned, prune it
  (`git worktree remove` + `git branch -D`); if it holds real unmerged publish-write work, reconcile
  it with task #1 instead of duplicating. Do not blindly `--force`.

## 6. BLOCKED on Marlin (escalate, never autonomous)
- **Prod provisioning (#4)** is `irreversible_ops` (DNS, deploy, secrets) and needs Marlin's inputs +
  his hands (Infisical/Coolify/DNS auth). Get from Marlin before #4: (a) the demo domain + subdomain
  label for the wildcard, (b) which analytics project/key to bind, (c) plain "order placed"
  confirmation vs a fake-pay step (current plan: plain). The orchestrator hard-escalates
  irreversible_ops; do not try to route around it.
- Tenancy is decided: **wildcard DNS + a single wired site** (the P1 `SiteDomain` model is the seam
  for multi-tenant later; do not build the full E7 chassis for the demo).
- Other locked decisions (do not relitigate): render = SSR-on-request; checkout STOPS at
  order-created (no payment); basic analytics IN, A/B deferred (a `SiteExperiment` model exists for
  later).

## 7. Hard constraints (non-negotiable)
- Studio tokens only (no hardcoded gray/blue/red); reuse `src/components/ui/*`; keep the CMS grid
  `.light`. data-table-react IS the engine. Server owns money/stock. Admin-guarded writes, public
  reads. The content agent's removals use `archiveRow` (reversible), NOT hard delete.
- Production-grade, not gate-passable: cover unhappy paths, surface errors loudly. ZERO tech debt:
  fix follow-ups in the same PR. Headless `.test.ts(x)` for correctness-bearing code.
- Secrets via Infisical / the secrets-proxy ONLY. NO em-dashes or en-dashes anywhere. Commit
  messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context)` line; PR bodies end with the
  Claude Code generated-by line. Specs follow the document-lifecycle.

## 8. First action
Dispatch `framer-content-agent` (task #5) first: its spec is locked and self-contained. In parallel,
dispatch `framer-commerce-read-repo` (#2) and `framer-ci-integration-tests` (#6). Then reconcile the
demo plan to the P1 models and dispatch `framer-publish-write` (#1) + `framer-server-renderer` (#3).
Hand prod (#4) to Marlin. Keep PR-per-task; ultracode-review every diff before merge.
