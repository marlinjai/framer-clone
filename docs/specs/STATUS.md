---
type: documentation
title: Wave delivery ledger
summary: Live status of waves, specs, gates, and ownership for Phase 1.
---

# Wave delivery ledger

Updated by humans and agents as work progresses. Single source of truth for "what state is the wave system in".

**Last updated:** 2026-05-06 (Wave 0 spec writing complete, synthesis pending review)

## Current wave

**Wave 0 (spec writing):** done. 44 specs landed across waves 1, 2, 3.
**Next gate:** Marlin reviews `docs/specs/wave-0-synthesis.md` and decides on the open architectural questions before Wave 1 dispatch.

## Wave 1 (foundation): 18 specs

| Track | Spec | P | depends_on |
|-------|------|---|------------|
| ai-pattern-a | anthropic-sdk-bootstrap | P0 | (none) |
| ai-pattern-a | tool-schema-registry | P0 | sdk-bootstrap |
| ai-pattern-a | mst-snapshot-serializer | P0 | (none) |
| ai-pattern-a | read-tools-and-context | P1 | tool-schema-registry, mst-snapshot-serializer |
| cms | service-scaffold | P0 | (none, blocked by runtime decision) |
| cms | tenant-schema-bootstrap | P0 | service-scaffold |
| cms | auth-middleware-dual-principal | P0 | tenant-schema-bootstrap |
| data-bindings | binding-shape-on-component-model | P0 | (none) |
| data-bindings | data-source-provider-interface | P0 | (none) |
| data-bindings | component-registry-bindable-slots | P0 | binding-shape |
| lumitra-studio | component-id-attribution | P0 | (overlaps static-html-data-component-id-fix) |
| lumitra-studio | project-binding | P0 | (none) |
| multiplayer | yjs-doc-shape | P0 | (none) |
| multiplayer | hocuspocus-server-scaffold | P0 | yjs-doc-shape |
| multiplayer | yjs-mst-binding-slice | P0 | yjs-doc-shape |
| multiplayer | auth-brain-seam | P0 | hocuspocus-server-scaffold |
| static-html | data-component-id-fix [done] | P0 | (none) |
| static-html | spike | P0 | data-component-id-fix |

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
