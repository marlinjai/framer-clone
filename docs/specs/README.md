---
type: documentation
title: Wave-based delivery for Phase 1
summary: How Phase 1 scope is decomposed into leaf specs and executed across waves.
---

# Wave-based delivery

Phase 1 (Framer parity) is delivered across **three execution waves**, each gated by a verification step. A fourth human-led integration phase closes the loop. This directory holds the leaf specs that describe each unit of work.

## Tracks

Phase 1 has six tracks, derived from `memory/project_strategic_thesis_bubble_killer.md`:

| Track | Slug | Source plan |
|-------|------|-------------|
| CMS service | `cms` | `docs/plans/2026-05-05-cms-data-layer-research.md` |
| Editor multiplayer | `multiplayer` | `docs/plans/2026-05-05-editor-multiplayer-research.md` |
| Read-only data-bindings | `data-bindings` | (component-side of CMS plan) |
| Static HTML publish | `static-html` | `docs/plans/2026-05-01-framework-agnostic-renderer-research.md` |
| AI inline assistant (Pattern A) | `ai-pattern-a` | `docs/plans/2026-05-05-ai-agent-layer-research.md` |
| Lumitra Studio Phases A+B | `lumitra-studio` | (analytics-platform repo) |

## Waves

- **Wave 1 (foundation):** scaffolds, prototypes, must-fix bugs. Examples: CMS scaffold, multiplayer prototype, AI tool surface, `data-component-id` fix, storage-brain stubs, multiplayer auth scaffold, static HTML spike.
- **Wave 2 (build out):** depends on Wave 1 foundation. Most of Phase 1 feature work lives here.
- **Wave 3 (compose and polish):** cross-track integration, edge cases, performance, docs.
- **Wave 4 (human-led):** integration, drag/drop edge cases, judgment calls. Marlin drives, agents assist.

## Spec lifecycle

```
draft -> ready -> in-progress -> in-review -> done
                                            \-> blocked
```

- `draft`: written by spec agent, awaits review
- `ready`: approved, can be dispatched to a worker
- `in-progress`: a worker is executing
- `in-review`: worker finished, critic reviewing
- `done`: critic + Marlin approved, merged
- `blocked`: dependency unresolved or external blocker

## Hard rules

- MST tree is shared state. Serialize MST-touching specs OR pick one owner.
- Yjs is canonical for canvas mutations once multiplayer lands. AI mutations route through Yjs, never direct to MST.
- Decomposition quality dominates. A bad spec graph cannot be saved by good agents.
- Last 20 percent (integration, edge cases) does not compress with agents. Reserve for human serial work in Wave 4.

## Files in this directory

- `README.md` (this file): wave model
- `STATUS.md`: live ledger of specs, waves, gates, owners
- `leaf-spec-template.md`: template every leaf spec follows
- `wave-1/`, `wave-2/`, `wave-3/`: leaf specs by wave
