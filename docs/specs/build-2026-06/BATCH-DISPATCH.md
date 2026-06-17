---
type: plan
status: decided
title: Batch dispatch order, build-2026-06 (CMS content tier + commerce engine + storefront)
summary: Wave-by-wave launch order for the 27-goal build-2026-06 batch, the strictly-serial Prisma schema chain, and the human merge gate (Gate B) that every dependent waits on.
tags: [orchestration, dispatch, framer-clone, prisma, dag]
date: 2026-06-16
---

# Batch dispatch order: build-2026-06

This is the launch contract for the 27-goal build-2026-06 batch (CMS content tier `slice2-*`, commerce engine `b1..b7`, storefront `trackc-*`), gated on the Track 0 backend-foundation pilot. It is the operational companion to `ORCHESTRATION-LOOP.md`. The DAG was verified sound: 27 nodes, zero dangling edges, no self-deps, fully acyclic (Kahn topo-sort), zero intra-wave shared-state collisions.

## The one rule that governs everything

**Nothing dispatches until the Track 0 pilot is blessed.** `track0-backend-foundation` is the sole `depends_on: []` root. It stands up Prisma, the `src/server/**` boundary, the api conventions, and the vitest `projects` test substrate that every downstream server spec consumes. Until a human reviews Track 0's branch diff and MERGES it (Gate B), no wave-1 task may launch, because every wave-1 task `depends_on: [track0-backend-foundation]`.

## Two human gates (from ORCHESTRATION-LOOP sections 6 and 11)

- **Gate A (approval, before launch).** The installed orchestrator CLI runs ONE goal per invocation (`orchestrator --goal <path>`); it does NOT scan a directory for a `status: approved` frontmatter field. Verified against the source: the dispatcher reads `verify`, `auth_mode`, and `marlin_proxy` from goal frontmatter, never a `status` gate. So Gate A is enforced by the OPERATOR selecting which goal files to fire, in the wave order below, never by an inert frontmatter flag. Treat each wave as the approve-and-launch unit: review the wave's specs, then launch that wave's goals.
- **Gate B (merge, after a Worker completes).** When a Worker reaches `completed` (verify green), a human reviews the branch diff and merges by hand (push, PR, squash-merge, cleanup per ORCHESTRATION-LOOP section 6). A merged task becomes a `depends_on` satisfier that unblocks its dependents. **Throughput is gated on the merge cadence, by design.** The verify gate proves "build is green," not "the feature is right"; Gate B is the right-ness gate.

A task in wave N+1 may launch only once ALL of its `depends_on` tasks have MERGED (Gate B), not merely completed. The waves below are the merge-readiness frontier.

## Launch waves (merge-readiness frontier)

Wave 0 is the pilot. Each later wave becomes launchable only after every task in its dependency closure has cleared Gate B. The dispatcher caps concurrency at 3 Workers; waves wider than 3 are throttled (ordering within a throttled wave is free because no two tasks in any wave share a `shared_state` tag).

### Wave 0 (1 task): the pilot, must merge before anything else
- `track0-backend-foundation` (owns: `prisma`, `lockfile`, `next-config`, `vitest-config`)

### Wave 1 (4 tasks): launch the instant Track 0 merges
- `slice2-admin-guard-stub`
- `slice2-cms-server-adapter-and-repo` (owns: `lockfile`)
- `slice2-read-binding-resolver-runtime` (owns: `vitest-config`, additive to Track 0's node project)
- `b1-commerce-module-skeleton`

### Wave 2 (2 tasks)
- `slice2-prisma-datasource-provider`
- `b2-inventory-ledger-schema` (Prisma chain link 1: `prisma`, `migrations`)

### Wave 3 (3 tasks)
- `slice2-read-only-data-components`
- `slice2-content-type-management-ui`
- `b3-guarded-reservation` (Prisma chain link 2: `prisma`, `migrations`)

### Wave 4 (4 tasks, throttled to 3 Workers)
- `slice2-data-loading-empty-error-states`
- `slice2-editor-binding-picker` (sole owner: `mst-tree`)
- `slice2-tableview-renderer` (owns: `lockfile`)
- `b4-catalog-schema` (Prisma chain link 3: `prisma`, `migrations`)

### Wave 5 (3 tasks)
- `slice2-publish-read-binding-hydration`
- `trackc-commerce-data-source-seam-and-dtos` (introduces `binding-types`)
- `b5-pricing-and-tax` (Prisma chain link 4: `prisma`, `migrations`)

### Wave 6 (3 tasks)
- `b6-minimal-orders` (Prisma chain link 5, last schema link: `prisma`, `migrations`)
- `b7-commerce-rest-reads`
- `trackc-commerce-binding-scope-frame-and-resolver` (owns: `binding-types`)

### Wave 7 (1 task)
- `trackc-commerce-http-provider-and-read-routes`

### Wave 8 (1 task)
- `trackc-storefront-product-list-and-detail-renderers`

### Wave 9 (1 task)
- `trackc-variant-selector-component`

### Wave 10 (1 task)
- `trackc-client-cart-state-and-cart-view`

### Wave 11 (1 task)
- `trackc-order-create-checkout-stop`

### Wave 12 (1 task)
- `trackc-register-storefront-components-as-bindable-blocks` (owns: `component-registry`)

### Wave 13 (1 task): the tail
- `trackc-commerce-binding-preview-and-publish-hydration` (owns: `hydrate-bindings`)

The 14-wave depth reflects the long serial storefront tail: `register-storefront` depends on all four upstream `trackc` runtime slices, which themselves chain through the b-schema, the resolver, and the http-provider.

## The Prisma serial chain (the load-bearing serialization)

`framer-clone/prisma/schema.prisma` is a single file with a single Postgres schema (NOT `multiSchema` for v1). Exactly ONE task creates it and a strictly serial chain extends it, so no two Workers ever edit it concurrently:

```
track0-backend-foundation   (creates schema.prisma + the 8 dt_* CMS models)
  -> b2-inventory-ledger-schema   (appends commerce: inventory ledger)
    -> b3-guarded-reservation     (appends: guarded reservation)
      -> b4-catalog-schema        (appends: catalog)
        -> b5-pricing-and-tax     (appends: pricing + tax)
          -> b6-minimal-orders    (appends: orders)
```

Each link carries `shared_state: [prisma, migrations]` and `depends_on` the prior link, so the dispatcher places them in separate waves (verified: waves 0, 2, 3, 4, 5, 6). The `b7` reads and the `trackc` commerce chain consume the FROZEN schema shape, they never edit it. This collapses N parallel schema-editors into one owner plus a serial chain: safer and conflict-free. Marlin reviews each schema-link diff with extra care at Gate B (the shape that lands first is the contract everyone downstream builds on).

## Shared-state ownership (single-owner invariants)

Verified: every shared-state tag has a single structural owner, and no two co-waved tasks share a tag.

| Tag | Owner | Serialization |
|-----|-------|---------------|
| `prisma` / `migrations` | `track0-backend-foundation` then the serial `b2 -> b3 -> b4 -> b5 -> b6` chain | separate waves by dep edges |
| `vitest-config` | `track0-backend-foundation` (the `projects` migration) | `slice2-read-binding-resolver-runtime` now `depends_on: [track0-backend-foundation]` and only ADDS its glob (wave 1, after track0 merges) |
| `lockfile` | `track0` (wave 0), `slice2-cms-server-adapter-and-repo` (wave 1), `slice2-tableview-renderer` (wave 4) | never co-waved |
| `mst-tree` | `slice2-editor-binding-picker` (sole) | single owner |
| `next-config` | `track0-backend-foundation` (sole) | single owner |
| `binding-types` | `trackc-commerce-data-source-seam-and-dtos` introduces, `trackc-commerce-binding-scope-frame-and-resolver` extends | serialized by dep edge (waves 5 -> 6) |
| `component-registry` | `trackc-register-storefront-components-as-bindable-blocks` (sole) | single owner |
| `hydrate-bindings` | `trackc-commerce-binding-preview-and-publish-hydration` (sole) | single owner |

## Headless-safe verify (no build-time secret)

Every goal's verify is `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint`, runnable headless: `next build` needs NO live `DATABASE_URL` because the Track-0 Prisma singleton is lazy (connects on first query, not on import). Every goal that creates, imports, or compiles a module on the `src/server/{cms,commerce}` or `/api/{cms,commerce}` path carries a throwaway placeholder prefix `DATABASE_URL='postgresql://placeholder:placeholder@localhost:5432/placeholder'` as belt-and-suspenders, so headless-safety never rides on "the singleton stayed lazy" as an unstated invariant. This now covers the full CMS + b-chain AND the six `trackc` commerce-path goals (made uniform 2026-06-16). No `.infisical.json` is copied into any worktree; no Worker reaches for `infisical run`.

## Fixes applied to this batch (2026-06-16, post DAG verification)

1. **Major (vitest-config collision), FIXED.** `slice2-read-binding-resolver-runtime` previously declared `depends_on: []` while also carrying `shared_state: [vitest-config]`, the same tag Track 0 carries. Both were launchable at t0, so a depends-only dispatcher would try to run them in parallel and hit a `vitest.config.ts` merge conflict (the shared-state lock would serialize them, but the graph did not show it). Fix: added `depends_on: [track0-backend-foundation]` to both the spec and the goal file, collapsing the resolver to the deterministic additive-only branch (Track 0 owns the `projects` migration; the resolver just registers its node glob). The resolver moved from wave 0 to wave 1. `ORCHESTRATION-LOOP.md` section 7 and section 11 updated to name Track 0 (not the resolver) as the `vitest-config` owner.
2. **Minor (status gate doc-vs-reality), RESOLVED in doc.** The installed orchestrator does not read a `status: approved` frontmatter gate (verified against source). Gate A is an OPERATOR convention (launch goals in wave order), captured above, not an inert frontmatter flag.
3. **Minor (DATABASE_URL prefix uniformity), FIXED.** Added the placeholder prefix to the six `trackc` commerce-path goal verify commands so the whole DB-touching surface is uniform with the CMS + b-chain.

## Hard constraints carried by every goal

Every goal forbids `git push`, `gh pr create`, `gh pr merge`, and any merge: "Do NOT push to main, do NOT open a PR, do NOT merge." Workers commit to their worktree branch only. The human drives every Gate B merge. Secrets via Infisical only, never `.env`, never a literal. No em-dashes or en-dashes in any file.
