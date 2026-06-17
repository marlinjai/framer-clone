---
name: slice1-crm-boardview-wiring
track: slice-1-offers-doc-tier
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-web
status: draft
dependsOn: [slice1-doc-tier-provisioning, slice1-admin-http-routes]
touchesSharedState: true
sharedState: [lockfile]
estimateDays: 1
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit
---

> **PARKED 2026-06-16:** separate lumitra-web workstream, NOT part of the framer-clone build loop. See `/Users/marlinjai/software-dev/ERP-suite/projects/framer-clone/docs/specs/build-2026-06/ROADMAP.md`. Content preserved for the lumitra-web offers/CRM workstream pickup; do NOT dispatch from the framer-clone orchestrator.

# CRM pipeline BoardView wiring (data-table BoardView grouped by the Offer.stage select column)

> Slice 1 spec 8 of 8. Critique fixes applied: the drag DoD now tests the PERSISTENCE/sync contract at the data layer (not synthetic PointerEvents); actual drag-drop is MANUAL-VERIFY per memory `feedback_no_chrome_devtools_for_dragdrop`; `@marlinjai/data-table-react` pinned to a version whose data-table-core matches adapter-prisma@0.2.1's core (verify before merge).

## Goal

The CRM pipeline kanban is FREE: a data-table BoardView grouped by the `Offer.stage` select column (Lead/Qualified/Offer Sent/Won/Lost) gives drag-and-drop pipeline with zero custom UI. This spec is mostly config: provision a BoardView on the Offers collection grouped by stage, surface it in lumitra-web admin via `@marlinjai/data-table-react`.

## Scope

**In:**
- Provision a BoardView on the Offers collection grouped by stage via `adapter.createView` (idempotent, alongside provisioning).
- Render the pipeline board in lumitra-web admin via `@marlinjai/data-table-react` BoardView.
- The stage<->status loose-sync contract: `status` (the state machine, owned by the domain layer) is the source of truth; `stage` is kept loosely in sync for the board. A board drag updates `stage` ONLY (a CRM-presentation move); a domain transition updates BOTH.

**Out (explicitly deferred):**
- BoardView/CalendarView as canvas components (that is framer-clone, not lumitra-web admin).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/offers/docTier/provision.ts` | edit | add a stage-grouped BoardView via adapter.createView on Offers |
| `src/app/admin/pipeline/page.tsx` | new | renders the board |
| `src/server/offers/docTier/boardSync.ts` | new | stage<->status loose-sync contract doc + guard helper |
| `package.json` | edit | add @marlinjai/data-table-react (pinned, core must match adapter-prisma@0.2.1) only if the full BoardView is used |
| `src/server/offers/docTier/__tests__/boardSync.test.ts` | new | sync-contract test (data layer, NOT DOM drag) |

## Test plan

- [ ] Unit (DATA LAYER): the stage-update handler updates `Offer.stage` ONLY and leaves `status` untouched.
- [ ] Unit: a domain transition to accepted sets BOTH `status=accepted` and `stage=Won`.
- [ ] Render: the board renders against seeded offers with the five stage columns.
- [ ] MANUAL (Marlin): dragging an offer card between columns persists the stage change and the board reflects it. NOT auto-tested with synthetic drag events (per memory `feedback_no_chrome_devtools_for_dragdrop`).

## Definition of done

- [ ] A stage-grouped BoardView exists on Offers (created idempotently alongside provisioning).
- [ ] Admin renders the pipeline board with five stage columns.
- [ ] Sync-contract data-layer tests green (stage-only on board move, both on domain transition).
- [ ] `@marlinjai/data-table-react` pinned to a core-compatible version (verified against adapter-prisma@0.2.1 core) IF the full BoardView is used.
- [ ] `pnpm exec tsc --noEmit` passes; board renders against seeded offers.

## Open questions

- If wrapping the full `data-table-react` BoardView is heavier than the 1-day slice allows, the fallback is a read-only stage-grouped board reading via `GET /api/offers` grouped client-side, with drag deferred. Flag to Marlin if the fallback is taken.

## References

- Plan: holistic plan 5.1, 5.3
- Code touchpoints: data-table `architecture.md` (BoardView), ViewType 'board' + BoardViewConfig.groupByColumnId
