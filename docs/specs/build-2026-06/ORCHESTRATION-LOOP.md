---
type: documentation
title: Continuous speccer to autonomous orchestrator loop (framer-clone build)
status: draft
date: 2026-06-16
summary: Two-tier loop. Tier 1 (continuous speccer) decomposes one after-roadmap epic per tick into leaf specs + goal files. Tier 2 (autonomous orchestrator) builds approved goals in isolated worktrees with the real in-loop verify gate. Two irreducible human gates: spec approval before build, merge approval after build.
projects: [framer-clone, lumitra-web]
---

# Design: continuous speccer to autonomous orchestrator loop (framer-clone)

Status: draft. Date: 2026-06-16. Owner: Marlin. Target repos: `~/software-dev/ERP-suite/projects/framer-clone` and `~/software-dev/ERP-suite/projects/lumitra-web`. The active specs this loop dispatches first live in `docs/specs/build-2026-06/` (Slice 1 + Slice 2, see `ROADMAP.md`); the after-roadmap epics (E1-E8) are the speccer's continuous fuel.

## 0. Ground-truth correction (read this first, it changes the safety story)

The 2026-06-06 motion-engine handover asserts: "the in-loop verify gate does NOT exist in orchestrator source yet, so every run needs operator review + HUMAN merge." **That is stale as of the installed `claude-code-orchestrator v0.3.0`.** Verified against source:

- `~/software-dev/orchestrator/orchestrator/verify.py` exists (2026-06-06) and is wired into `orchestrator.py:509-573`.
- On a `stop`-candidate iteration, if the goal frontmatter declares a `verify:` command, the orchestrator runs it in the worktree BEFORE accepting `completed`. Pass: `completed`. Fail: feeds the failure tail back to the Worker (evaluator-optimizer) up to `verify_fix_cap` times (default 2), then `escalated`. Denylisted command / timeout / can't-start: `escalated` immediately (`verify.py:108-165`, `decide_after_verify` at `verify.py:168-210`).
- A goal with NO `verify:` command completes with a logged warning and zero build verification (`orchestrator.py:510-520`).

So the real situation is the inverse of the handover: **the machine-checkable gate exists, but the human merge gate is a discipline, not a code lock.** Workers cannot push to a remote or `gh pr merge` (bash denylist in `guardrails.py`, also enforced inside `run_verify`), but nothing in the orchestrator stops the operator-side skill from auto-merging. The `autonomous-orchestration` SKILL's step 5 actively auto-reviews, pushes, opens, and squash-merges PRs without a user gate.

This design therefore inverts the SKILL's auto-merge default for this loop: **Marlin's live review is reinstated as a hard gate between every build batch and merge,** because (a) the verify gate proves "build is green," not "the feature is correct / on-altitude," and (b) the shared-state files here (MST tree, Yjs doc shape, Prisma) are exactly the convergence points where a green build can still be semantically wrong.

## 1. The two tiers and the one human gate

```
TIER 1: CONTINUOUS SPECCER (background, single Worker, interactive Claude or cron)
  ROADMAP epics ──pick next epic──▶ decompose to leaf specs ──verify specs──▶ emit goal files
        │                                                                          │
        │                                                                          ▼
        │                                                              goals/<epic>-sliceN.md (status: queued)
        │                                                                          │
        └────────────────────────── reports each tick to Marlin ◀─────────────────┘
                                                                                   │
══════════════════════════ HUMAN GATE A (irreducible): SPEC APPROVAL ═══════════════
   Marlin reviews the spec batch + the proposed DAG. APPROVES, EDITS, or KILLS.
   Nothing in Tier 2 starts on a goal file until Marlin flips its status queued -> approved.
═══════════════════════════════════════════════════════════════════════════════════
                                                                                   │
                                                                                   ▼
TIER 2: AUTONOMOUS ORCHESTRATOR (up to 3 concurrent Workers, worktree-isolated)
   batch dispatch (dep-aware) ──▶ Worker builds in worktree ──▶ in-loop verify gate (real)
                                                                                   │
══════════════════════════ HUMAN GATE B (irreducible): MERGE APPROVAL ══════════════
   Marlin reviews each completed branch's diff before MERGE. Worker cannot merge.
   Operator skill's auto-merge is DISABLED for this loop (--no-auto-merge discipline).
═══════════════════════════════════════════════════════════════════════════════════
```

Two human gates, both irreducible: **spec approval** (before build) and **merge approval** (after build). The verify gate is a third gate but it is machine-owned and runs unsupervised inside the loop.

## 2. Where everything physically lives

| Artifact | Path | Notes |
|---|---|---|
| Authoritative build sequence + epic source | `docs/specs/build-2026-06/ROADMAP.md` (this build) | Slice 1/2 are the first dispatch; epics E1-E8 are the speccer's queue. |
| Leaf specs (Tier 1 output) | `framer-clone/docs/specs/build-2026-06/<track>/<id>.md` | Frontmatter `status: draft`, `targetRepo`, `dependsOn`, `touchesSharedState`, `sharedState`, `verify`. |
| Goal files (Tier 1 output) | `~/software-dev/orchestrator/goals/<epic>-sliceN.md` | One per leaf spec. Frontmatter: `task`, `spec`, `depends_on`, `shared_state`, `verify`, `marlin_proxy`, `status`. |
| Approval state | `status: queued\|approved` in each goal file | Speccer writes `queued`, Marlin flips to `approved`. The dispatcher only launches `approved`. |
| Build worktrees (Tier 2) | `~/software-dev/ERP-suite/projects/<repo>-orch-<task-id>` | `git worktree add -b orchestrator/<task-id> ../<repo>-orch-<task-id> main`. |
| Orchestrator run state | `~/.orchestrator/tasks/<task-id>/{state.json,run.log,STOP}` | Per-task, atomic writes. |
| Speccer cursor / progress | `~/.orchestrator/speccer/framer-clone.json` + `notes.md` | NEW. Tracks last epic specced, specs awaiting approval, specs approved + dispatched. |

The split is deliberate: **specs live in the target repo** (project artifacts, version-controlled with the code they describe), **goal files live in the orchestrator repo** (dispatch instructions, coupled to the runner).

## 3. Tier 1: what one speccer tick does

A tick is one pass of the Tier-1 loop. Run it interactively or on a slow cron. One tick = one epic decomposed, never more (bounded blast radius, bounded review load).

**Tick steps:**

1. **Read the cursor.** If there are specs still `status: queued` beyond a backpressure cap (recommend 1 epic = max ~13 unapproved specs at once), STOP this tick and report "blocked on approval." Do not run ahead of the human gate.
2. **Pick the next epic.** From `ROADMAP.md`'s after-roadmap epic table, take the next epic not already specced (cross-check the cursor). The first epics in the queue are E1 (owned inventory ledger) and E4 (MST<->Yjs binding slice), the two un-gated/gate-defining starts after Slice 1/2 land.
3. **Decompose to leaf specs.** Read the epic. Produce N per-slice spec files in `docs/specs/build-2026-06/<track>/`, each scoped to land in one PR with TDD, using the leaf-spec template. A leaf spec is "leaf" iff it names every file it touches, its co-located test files, its `targetRepo`, its `verify` command, and lists no unresolved design questions.
4. **Verify the specs (the Tier-1 quality gate).** Adversarial self-check per spec: do named files exist or is their creation specified? Is `shared_state` declared (does it touch `pnpm-lock.yaml`, an MST model, the Yjs doc shape, Prisma)? Is the verify command runnable headless (no secrets needed)? Are the `dependsOn` edges acyclic? A failing spec is rewritten, not emitted.
5. **Emit goal files.** For each verified spec, write `~/software-dev/orchestrator/goals/<epic>-sliceN.md` with `status: queued` and the full frontmatter (section 5). The speccer fills `verify` (`pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint`) and `targetRepo` itself; `orchestrator roadmap-next` leaves those as operator TODOs.
6. **Update the cursor + report.** Write the cursor JSON, append to `notes.md`, emit the tick report (section 8).

**Tier-1 hard constraints:** the speccer writes ONLY `docs/specs/**` and `goals/**`. It never touches app code, never runs `infisical`, never deploys, never opens worktrees. If an epic has unresolved product decisions, the speccer does NOT decide: it writes the question into the tick report and leaves the affected slice unspecced. That is a `product_decision` for Marlin.

## 4. Tier 2: what one orchestrator dispatch does

The existing `autonomous-orchestration` SKILL's batch-dispatch loop, with one config change (auto-merge OFF) and one precondition (only `approved` goals):

1. **Pre-flight prune** stale worktrees from prior batches.
2. **Parse frontmatter** of all `goals/<epic>-*.md` with `status: approved`. Build the dep graph from `depends_on`; annotate `shared_state` tags.
3. **Compute the launchable set:** tasks whose `depends_on` have all MERGED, and that share no `shared_state` tag with a currently-running task.
4. **Dispatch** up to 3 concurrent (the proven envelope). One worktree per task. **Copy `.infisical.json` into the worktree iff the verify command needs secrets.** For framer-clone and lumitra-web the verify command is fully headless (`next build` needs no build-time secrets), so no `.infisical.json` copy: state that explicitly in each goal's constraints so the Worker does not reach for `infisical run`.
5. **Each Worker** builds in its worktree, self-reports via `update_state`, and on `stop` triggers the in-loop verify gate (real, automatic). Green -> `completed`. Red after `verify_fix_cap` retries -> `escalated`. A `product_decision`/`scope_change`/`risk_tradeoff` mid-build -> Decision Proxy `escalate` -> Marlin Proxy classifies -> in `shadow` mode it still escalates to Marlin (and logs the would-be call).
6. **On terminal state**, the orchestrator fires its notification. The harness-tracked launch re-invokes the dispatching session.
7. **STOP at the merge gate.** Do NOT auto-push/PR/merge. Hand the completed branch to Marlin (section 6).

## 5. Goal-file frontmatter the speccer emits (concrete)

```yaml
---
task: e1-inventory-slice1-ledger-schema
spec: docs/specs/build-2026-06/owned-commerce/e1-slice1-ledger-schema.md   # path inside targetRepo
target_repo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-infra
status: queued                      # speccer writes queued; Marlin flips to approved
depends_on: []                      # must MERGE first
shared_state: [prisma, migrations]  # see section 7; [] = parallel-safe
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
verify_fix_cap: 2
verify_timeout_s: 1200
marlin_proxy: shadow                # whole programme starts in shadow
marlin_proxy_categories:
  scope_change: escalate
  product_decision: escalate
  risk_tradeoff: escalate
  irreversible_ops: escalate        # hard-wired anyway; declared for clarity
---
```

The goal BODY follows `goals/_template.md`: goal paragraph naming the spec, "Read first," "Definition of done," "Constraints" (stay in worktree, never push, never merge, never `infisical`, no em/en-dashes, conventional commits body <=100), and Notes.

## 6. The two irreducible human checkpoints (concrete commands)

**Checkpoint A: spec approval (Tier 1 -> Tier 2).** After a tick, Marlin reviews `docs/specs/build-2026-06/<track>/` and the proposed DAG. To approve a slice, flip its goal's frontmatter:

```bash
# approve one slice:
sed -i '' 's/^status: queued$/status: approved/' \
  ~/software-dev/orchestrator/goals/slice1-doc-tier-provisioning.md
# or approve a reviewed batch:
grep -rl '^status: queued$' ~/software-dev/orchestrator/goals/slice1-*.md \
  | xargs sed -i '' 's/^status: queued$/status: approved/'
```

The dispatcher only ever launches `status: approved`. This gate replaces the (still-unbuilt-for-correctness) automatic semantic check: Marlin reads the spec and decides it is the right thing to build, at the right altitude, before any Worker spends tokens.

**Checkpoint B: merge approval (Tier 2 -> main).** When a task reaches `completed`, Marlin reviews the branch diff and merges by hand:

```bash
cd ~/software-dev/ERP-suite/projects/lumitra-web-orch-slice1-doc-tier-provisioning
git --no-pager diff main...HEAD          # review the actual change
# Marlin's eyes: is the doc-tier provisioning idempotent? do the relation columns use createColumn not createRelation?
git -C ../lumitra-web push -u origin orchestrator/slice1-doc-tier-provisioning   # only Marlin/operator pushes
gh pr create --base main --head orchestrator/slice1-doc-tier-provisioning
gh pr merge <n> --squash --delete-branch   # after CI green AND Marlin's approval
# cleanup:
cd ~/software-dev/ERP-suite/projects/lumitra-web && git fetch --prune && git checkout main && git pull
git worktree remove ../lumitra-web-orch-slice1-doc-tier-provisioning
git branch -D orchestrator/slice1-doc-tier-provisioning
```

A merged slice becomes a `depends_on` satisfier for its dependents, unblocking the next launchable set. **The loop's throughput is gated on Marlin's merge cadence, by design.** The verify gate gates "green," not "right," so the right-ness gate is Marlin at merge time.

## 7. Shared-state serialization (so parallel Workers don't collide)

The convergence files for this build are the MST tree, the Yjs doc shape, Prisma, the lockfile, and the vitest config. Two Workers editing any of these in parallel produce a guaranteed merge conflict or a green-but-divergent schema. The speccer MUST tag every slice that touches them so the dispatcher serializes them.

| File / area | `shared_state` tag | Why it serializes |
|---|---|---|
| `pnpm-lock.yaml` (any dep add) | `lockfile` | Guaranteed lockfile conflict at merge. |
| `framer-clone/prisma/schema.prisma` | `prisma` (+ `migrations` for migration runs) | Single framer-clone schema file. Created by `track0-backend-foundation`, then extended by the strictly-serial commerce schema chain `b2-inventory-ledger-schema` -> `b3-guarded-reservation` -> `b4-catalog-schema` -> `b5-pricing-and-tax` -> `b6-minimal-orders`. No two Workers edit `schema.prisma` concurrently. |
| `vitest.config.ts` | `vitest-config` | Concurrent edits to the env config collide. |
| `src/models/*.ts`, `src/stores/*.ts` (MST tree shape) | `mst-tree` | The MST snapshot IS the data contract; two Workers changing it diverge silently even if both builds are green. Owned solely by `slice2-editor-binding-picker`. |
| `src/lib/multiplayer/yjsDocShape.ts` + test | `yjs-doc` | The Yjs doc shape must mirror the MST tree exactly. A slice changing MST AND a slice changing the Yjs mirror MUST serialize, so tag BOTH `mst-tree` and `yjs-doc` on any binding slice. |
| `src/lib/bindings/**` `BindableSlotMeta` (additive) | `binding-types` | Introduced by `trackc-commerce-data-source-seam-and-dtos` (additive to `BindableSlotMeta`). Serializes any slice extending the binding type surface. |
| component registry | `component-registry` | Introduced by `trackc-register-storefront-components-as-bindable-blocks`. Concurrent registrations collide. |
| the CMS-owned hydrate helper | `hydrate-bindings` | `trackc-commerce-binding-preview-and-publish-hydration` extends the hydrate helper owned by the CMS tier; serializes with the CMS hydrator. |
| `next.config.ts` | `next-config` | Framework root config. |

**In this build's specs:** `prisma` is created by `track0-backend-foundation`, then held by the strictly-serial commerce schema chain `b2-inventory-ledger-schema` -> `b3-guarded-reservation` -> `b4-catalog-schema` -> `b5-pricing-and-tax` -> `b6-minimal-orders` (no two Workers edit `schema.prisma` concurrently); `track0-backend-foundation` owns the `vitest-config` `projects` migration (it stands up the test substrate), and `slice2-read-binding-resolver-runtime` `dependsOn: [track0-backend-foundation]` so it only ADDS its node-project glob additively (no concurrent `vitest.config.ts` edit); `slice2-editor-binding-picker` is the ONLY spec touching `mst-tree`; the storefront track introduces `binding-types` (`trackc-commerce-data-source-seam-and-dtos`), `component-registry` (`trackc-register-storefront-components-as-bindable-blocks`), and `hydrate-bindings` (`trackc-commerce-binding-preview-and-publish-hydration`). The dispatcher serializes any two slices sharing a tag.

**Serialization at the SCHEMA level, not just the file level.** The deeper protection: the speccer structures the DAG so exactly ONE early slice owns each shared-state shape change, and downstream slices `depends_on` it rather than re-editing it. `track0-backend-foundation` creates `framer-clone/prisma/schema.prisma`; the commerce schema chain (`b2` -> `b3` -> `b4` -> `b5` -> `b6`) extends it strictly serially, each depending on the prior merge and consuming the frozen shape. This collapses N parallel schema-editors into one serial owner + a serial chain, both safer and conflict-free.

## 8. How each tick reports back to Marlin (live monitoring)

**Tier 1 (speccer) tick report** (printed at end of every tick, appended to `notes.md`):

```
SPECCER TICK <ts>  epic: E1 owned inventory ledger
  decomposed into: 6 leaf specs (docs/specs/build-2026-06/owned-commerce/e1-slice1..6-*.md)
  emitted goals:   goals/e1-inventory-slice1..6-*.md  (all status: queued)
  DAG:             slice1 (prisma+migrations, owns ledger schema)
                     <- slice2 (movement writer)  <- slice3 (reservation guards)
                     <- slice4 (available_quantity generated col) ...
  shared_state:    slice1 [prisma, migrations]; slice3 [prisma] (SERIALIZES with slice1)
  OPEN QUESTIONS FOR MARLIN (unspecced, product_decision):
    - default fulfillment location resolution rule when a line omits a location? (slice3 blocked)
  awaiting approval: 6 specs. Backpressure cap reached; speccer idles until you approve.
  ACTION: review docs/specs/build-2026-06/owned-commerce/, then flip status queued->approved.
```

**Tier 2 (build) live monitoring:**

```bash
# what is running right now, with autonomy + cost + verify state:
for d in ~/.orchestrator/tasks/slice1-*; do orchestrator status --task-id "$(basename "$d")"; done
# tail one Worker live:
orchestrator logs --task-id slice1-doc-tier-provisioning -f
# the proxy's would-be decisions (shadow mode agreement data):
orchestrator marlin-proxy review
```

`orchestrator status` surfaces per-task: `status`, `iteration/max`, `commits[]` with `decided_by`, `last_verify` (pass/fail/exit-code/tail), `autonomy_stats`, `estimated_cost_usd`. Terminal states fire notification channels automatically. Red flags: `commits[*].decided_by == system` (Worker not self-reporting), `usage` input growing with no `cache_read` (caching broken), `iteration` climbing with no new commits/files (stagnation).

## 9. Kill switches (three independent layers)

1. **Per-task STOP** (halts one Worker): `orchestrator stop --task-id <id>` touches the STOP file; the run halts at the next iteration boundary.
2. **Marlin-Proxy disable** (forces every escalation to interrupt Marlin): `touch ~/.orchestrator/marlin-proxy.disabled`. Remove to resume. Independent of per-task STOP.
3. **Speccer pause** (stops Tier 1 emitting more work): kill the speccer session/cron. For a global stop: stop the speccer, `touch STOP` on every running build task, and leave goal files at `status: queued` (nothing dispatches an un-approved goal).

Plus the always-on hard guarantees: the bash denylist blocks `gh pr merge`, `git push`, `infisical run`, `terraform apply`, `pnpm publish` from any Worker (and from the verify command); `irreversible_ops` is hard-wired to escalate; malformed proxy output fails safe to escalate; the cost guard stops a runaway token bill.

## 10. What is NOT safe to run unsupervised yet (honest assessment)

1. **Correctness, taste, and altitude are not machine-checked.** The verify gate proves the build is green; it does NOT prove the slice does the right thing or sits at the right altitude. For a visual editor where "the MST snapshot is the contract," a green build with a subtly wrong snapshot shape is the dangerous case. **Merge stays human.**
2. **Marlin Proxy stays in `shadow` for the whole programme.** Promote a category to `live` only after >95% shadow agreement over 20+ decisions. `scope_change`, `product_decision`, `risk_tradeoff` stay `escalate` indefinitely. `irreversible_ops` is hard-wired.
3. **The speccer must not make product decisions.** Epics contain unresolved design questions; the speccer surfaces them and leaves the affected slice unspecced.
4. **Shared-state schema convergence is a human merge, always.** The MST/Yjs/Prisma shape change that lands first defines the contract everyone else builds on. Marlin reviews that one slice's diff with extra care.
5. **No infra, no money, no external systems from a Worker.** Deploy, secret rotation, DNS, destructive Prisma migrations all escalate. The build path is headless by design; the moment a slice needs a real secret (e.g. a live Storage Brain upload or a real Resend send against prod), that slice escalates and Marlin drives it. Note: Slice 1's offer-send and accept flows use Resend; the verify command MOCKS Resend (no live send in the gate).
6. **Concurrency above 3 Workers, and long multi-iteration runs under load, are untested.** Keep the cap at 3 and prefer many small single-iteration slices over few large ones.
7. **`closed-loop-sync` is the epic-ranking dependency** (if used for ranking). Ensure the speccer's environment has `~/.local/bin` on `PATH`, or the tick fails closed (the safe failure: no epic picked, nothing emitted).

## 11. Concretely, to start the loop on this build today

```bash
# Slice 1 + Slice 2 specs already exist under docs/specs/build-2026-06/.
# Step 0: emit goal files for the 16 Slice 1/2 leaf specs (status: queued).
#   One goal per spec, frontmatter per section 5, verify = pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint.

# HUMAN GATE A: review specs, approve the true root (track0-backend-foundation) first.
# track0 is the ONLY dependsOn:[] spec in the current build-2026-06 batch; it owns prisma + vitest-config
# and is the pilot that must be blessed at Gate B before ANY dependent launches.
grep -rl '^status: queued$' ~/software-dev/orchestrator/goals/track0-backend-foundation.md \
  | xargs sed -i '' 's/^status: queued$/status: approved/'
# Then, the instant track0 MERGES (Gate B), approve the wave that unblocks on it
# (e.g. slice2-admin-guard-stub, slice2-cms-server-adapter-and-repo, b1-commerce-module-skeleton,
#  and slice2-read-binding-resolver-runtime which now dependsOn:[track0-backend-foundation]).
# See BATCH-DISPATCH.md for the full wave order.

# Tier 2, dispatch the approved batch (dep-aware, max 3 concurrent, NO auto-merge):
#   Run the autonomous-orchestration dispatcher over approved goals, one worktree per task,
#   harness-tracked launch, stop before push/PR/merge.

# Monitor:
orchestrator status --task-id slice1-doc-tier-provisioning
orchestrator logs --task-id slice1-doc-tier-provisioning -f

# HUMAN GATE B: per completed slice, review diff, push, PR, merge by hand (section 6), then cleanup.

# Once Slice 1/2 are merging, start the SPECCER on epic E1 (or E4) to keep the pipeline fed:
#   one tick = one epic decomposed, status: queued, awaiting Gate A.
```

The version floor is met (`v0.3.0` installed; SKILL requires `>=0.3.0`). The verify gate is real, the kill switches are real, the notification channels are real. What this design adds on top of the shipped orchestrator: (a) the speccer cursor + `status: queued/approved` discipline, (b) the two framer-clone `shared_state` tags (`mst-tree`, `yjs-doc`), and (c) the explicit decision to keep auto-merge OFF so Marlin's review is the right-ness gate the machine cannot yet be.

## References (all absolute)

- Orchestrator source: `/Users/marlinjai/software-dev/orchestrator/orchestrator/{verify.py,orchestrator.py,roadmap.py,guardrails.py,worker.py}`
- Goal template: `/Users/marlinjai/software-dev/orchestrator/goals/_template.md`
- Proven speccer pattern: `/Users/marlinjai/software-dev/orchestrator/goals/lola-marketplace-phaseb-specs.md`
- Proven slice goal: `/Users/marlinjai/software-dev/orchestrator/goals/lumitra-u1-fx-adopt-schema.md`
- Build sequence: `docs/specs/build-2026-06/ROADMAP.md`
- Slice specs: `docs/specs/build-2026-06/slice-1-offers-doc-tier/`, `docs/specs/build-2026-06/slice-2-data-bindings/`
- Shared-state files: `framer-clone/src/models/*.ts`, `src/stores/*.ts`, `src/lib/multiplayer/yjsDocShape.ts`
