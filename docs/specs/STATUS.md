---
type: documentation
title: Wave delivery ledger
summary: Live status of waves, specs, gates, and ownership for Phase 1.
---

# Wave delivery ledger

Updated by humans and agents as work progresses. Single source of truth for "what state is the wave system in".

**Last updated:** 2026-06-16 (re-scoped to framer-clone-only, see banner)

> [!warning] RE-SCOPED 2026-06-16 to a framer-clone-ONLY workstream. See `docs/specs/build-2026-06/ROADMAP.md`.
> This ledger (dated 2026-05-06) assumed the multi-tenant CMS SERVICE was Wave-1 "now"; that was already superseded once. As of the 2026-06-16 re-scope the active build is framer-clone-ONLY, sequenced as four tracks that all land in `projects/framer-clone`:
> - **Track 0: backend foundation** (Prisma + Postgres + server-only boundary + api conventions + test substrate). framer-clone has NO backend today (only `/api/ai/edit`). HARD GATE. Owns `prisma/schema.prisma` creation. Track-dir `cms-content-tier`.
> - **Track A: CMS content tier + read-binding layer** (self-contained, imports `@marlinjai/data-table-adapter-prisma` directly, NO `@marlinjai/doc-tier-core`). Track-dir `cms-content-tier`.
> - **Track B: owned commerce engine** (purpose-built Prisma, NOT data-table; inventory ledger + guarded reservation + typed catalog + German tax model + minimal orders). Track-dir `commerce-engine`. Track 0 IS its `b0`.
> - **Track C: storefront binding + components** (parallel CommerceDataSource seam reusing the Track A machinery; checkout stops at order-created). Track-dir `storefront`.
>
> **lumitra-web offers/CRM is a SEPARATE parked workstream.** The 8 `slice-1-offers-doc-tier/` specs + the dropped `slice2-doc-tier-shared-package` are PARKED (banners added in-place), NOT dispatched from the framer-clone orchestrator. The old `slice-2-data-bindings/` specs are SUPERSEDED by the canonical, blocker-fixed `cms-content-tier/` versions (banners point to the new location). The old `slice-0-backend-foundation/track0-backend-foundation.md` is superseded by the `cms-content-tier/` Track 0.
>
> The already-done foundation specs (data-bindings binding shape, multiplayer doc-shape, ai-bootstrap, mst-snapshot-serializer) still stand. The multi-tenant `cms.lumitra.co` SERVICE remains deferred (now epic E7). The 27 framer-clone leaf specs + the deferred tail (E4-E8) live in `docs/specs/build-2026-06/`.

## Current wave

**Active build (2026-06-16):** framer-clone-only Track 0 (backend foundation) -> Track A (CMS read-binding layer) -> Track B (owned commerce engine) -> Track C (storefront). 27 leaf specs, 102 engineer-days. See `docs/specs/build-2026-06/ROADMAP.md`.
**BLOCKER to resolve before dispatch:** `@marlinjai/data-table-adapter-prisma@0.2.1` leaks `workspace:*` specifiers and will NOT `pnpm add`. Marlin decides republish (`0.2.2`) vs vendor before the orchestrator is fed. See ROADMAP "single most important pre-dispatch decision."
**Next gate:** Marlin approves the Track 0/A/B/C goal files (spec-approval gate) before the autonomous orchestrator dispatches. See `docs/specs/build-2026-06/ORCHESTRATION-LOOP.md`.
**Historical (below):** the Wave 0/1/2/3 ledger is kept for context; its CMS-SERVICE sequencing is superseded as noted.

## Active framer-clone tracks (2026-06-16)

| Track | Dir | Specs | Days | Owns shared-state | Notes |
|-------|-----|-------|------|-------------------|-------|
| Track 0 + A: CMS content tier + read-binding | `build-2026-06/cms-content-tier/` | 11 | 37 | Track 0: `prisma` (schema.prisma creation), `vitest-config`; binding-picker: `mst-tree` (ONLY) | self-contained; imports adapter-prisma directly; NO doc-tier-core |
| Track B: owned commerce engine | `build-2026-06/commerce-engine/` | 7 | 28 | `prisma`/`migrations` serial chain (b2->b3->b4->b5->b6) | purpose-built Prisma; Track 0 IS b0; READ COMMITTED reserve |
| Track C: storefront binding + components | `build-2026-06/storefront/` | 9 | 37 | `binding-types` (C3), `component-registry` (C8), `hydrate-bindings` (C9) | parallel CommerceDataSource seam; checkout stops at order-created |

## Parked / superseded (2026-06-16)

| Path | State | Pointer |
|------|-------|---------|
| `build-2026-06/slice-1-offers-doc-tier/*` (8) | PARKED (lumitra-web workstream) | banners in-place -> ROADMAP |
| `build-2026-06/slice-2-data-bindings/*` (9) | SUPERSEDED (moved + blocker-fixed) | banners -> `cms-content-tier/` |
| `build-2026-06/slice-0-backend-foundation/track0-backend-foundation.md` | SUPERSEDED | banner -> `cms-content-tier/track0-backend-foundation.md` |
| `slice2-doc-tier-shared-package` | KILLED | framer-clone imports adapter-prisma directly; no shared package |

## Wave 1 (foundation): 18 specs

| Track | Spec | P | depends_on | Status |
|-------|------|---|------------|--------|
| ai-pattern-a | anthropic-sdk-bootstrap | P0 | (none) | done |
| ai-pattern-a | tool-schema-registry | P0 | sdk-bootstrap | draft |
| ai-pattern-a | mst-snapshot-serializer | P0 | (none) | done |
| ai-pattern-a | read-tools-and-context | P1 | tool-schema-registry, mst-snapshot-serializer | draft |
| cms | service-scaffold | P0 | (none, blocked by runtime decision) | DEFERRED TO P4 (see banner + ROADMAP epic E7) |
| cms | tenant-schema-bootstrap | P0 | service-scaffold | DEFERRED TO P4 (see banner + ROADMAP epic E7) |
| cms | auth-middleware-dual-principal | P0 | tenant-schema-bootstrap | DEFERRED TO P4 (see banner + ROADMAP epic E7) |
| data-bindings | binding-shape-on-component-model | P0 | (none) | done |
| data-bindings | data-source-provider-interface | P0 | (none) | done |
| data-bindings | component-registry-bindable-slots | P0 | binding-shape | done |
| lumitra-studio | component-id-attribution | P0 | (overlaps static-html-data-component-id-fix) | draft |
| lumitra-studio | project-binding | P0 | (none) | done |
| multiplayer | yjs-doc-shape | P0 | (none) | done |
| multiplayer | hocuspocus-server-scaffold | P0 | yjs-doc-shape | draft |
| multiplayer | yjs-mst-binding-slice | P0 | yjs-doc-shape | draft |
| multiplayer | auth-brain-seam | P0 | hocuspocus-server-scaffold | draft |
| static-html | data-component-id-fix | P0 | (none) | done |
| static-html | spike | P0 | data-component-id-fix | draft |

## Deferred to P4 (multi-tenant CMS SERVICE)

These specs build `cms.lumitra.co` (the multi-tenant Hono service over adapter-prisma). They are NOT the active build. They move to P4, gated behind the P3 validation gate, and are built only at tenant two. They live in `docs/specs/build-2026-06/ROADMAP.md` as epic **E7** (multi-tenancy chassis + cms.lumitra.co HTTP service).

| Track | Spec | Was | Now |
|-------|------|-----|-----|
| cms | service-scaffold | Wave 1 P0 | P4 / E7 |
| cms | tenant-schema-bootstrap | Wave 1 P0 | P4 / E7 |
| cms | auth-middleware-dual-principal | Wave 1 P0 | P4 / E7 |
| cms | collection-crud-api | Wave 2 P0 | re-scoped: Slice 2 content-type UI uses adapter-prisma single-tenant in-process; the multi-tenant HTTP CRUD is P4 / E7 |
| cms | row-crud-api | Wave 2 P0 | re-scoped as above (P4 / E7) |
| cms | migration-runner | Wave 2 P0 | P4 / E7 (N-schema runner) |
| cms | permission-registry | Wave 2 P1 | P4 / E7 |
| cms | app-users-schema-design | Wave 2 P1 (design-only) | design stands; build is P6 (end-user auth) |

The wave-2 data-bindings specs (`read-binding-resolver-runtime`, `read-only-data-components`, `editor-binding-picker`) are re-scoped as **Slice 2** and re-point their DataSourceProvider from the future cms HTTP client to the in-process single-tenant adapter-prisma store. Their concrete leaf specs live in `docs/specs/build-2026-06/slice-2-data-bindings/`.

## Wave 2 (build out): 19 specs

| Track | Spec | P |
|-------|------|---|
| ai-pattern-a | canvas-mutation-tools | P0 (MST-WRITE, will need Yjs cutover) |
| ai-pattern-a | streaming-assistant-panel | P1 |
| cms | collection-crud-api | P0 |
| cms | row-crud-api | P0 |
| cms | migration-runner | P0 |
| cms | permission-registry | P1 |
| cms | app-users-schema-design | P1 (design-only, no build) |
| data-bindings | read-binding-resolver-runtime | P0 |
| data-bindings | read-only-data-components | P0 |
| data-bindings | editor-binding-picker | P0 (MST-WRITE) |
| lumitra-studio | snippet-injection | P0 |
| lumitra-studio | settings-panel | P0 |
| lumitra-studio | dashboard-link | P0 |
| multiplayer | yjs-mst-binding-full | P0 (Yjs canonical cutover) |
| multiplayer | per-user-undo | P0 |
| multiplayer | presence-awareness | P1 |
| static-html | css-flattener | P0 |
| static-html | publish-pipeline | P0 |
| static-html | runtime-island | P1 |

## Wave 3 (compose and polish): 7 specs

| Track | Spec | P |
|-------|------|---|
| ai-pattern-a | project-page-tools-and-phase2-stubs | P2 (MST-WRITE) |
| cms | ops-runbook-and-observability | P1 |
| data-bindings | states-pagination-and-polish | P1 (MST-WRITE) |
| lumitra-studio | heatmap-overlay-edit-mode | P1 |
| multiplayer | drag-and-delete-conflicts | P1 |
| multiplayer | reconnect-and-persistence-hardening | P1 |
| static-html | data-binding-hydration | P1 |

## Wave 4 (human-led integration)

Not started. Reserved for Marlin: drag/drop edge cases, multiplayer + AI integration polish, judgment calls.

## Verification gates

A wave moves from "in progress" to "done" only when:

1. All specs in the wave have `status: done`.
2. A critic agent has reviewed the cumulative diff for that wave.
3. Marlin has reviewed and approved.

## Update protocol

- Spec status changes: edit the spec file's frontmatter AND the row above.
- Wave status changes: only Marlin or the planner-of-record (Claude orchestrating).
- Agents must not change wave-level status. Only spec-level.
