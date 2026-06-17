---
name: slice1-domain-numbering-totals-status-activity
track: slice-1-offers-doc-tier
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-web
status: draft
dependsOn: [slice1-repository-and-withtenant-seam, slice1-variant-resolver-socket]
touchesSharedState: true
sharedState: [prisma]
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit
---

> **PARKED 2026-06-16:** separate lumitra-web workstream, NOT part of the framer-clone build loop. See `/Users/marlinjai/software-dev/ERP-suite/projects/framer-clone/docs/specs/build-2026-06/ROADMAP.md`. Content preserved for the lumitra-web offers/CRM workstream pickup; do NOT dispatch from the framer-clone orchestrator.

# Domain layer: ANG-YYYY-#### via a per-year Postgres SEQUENCE, server-computed integer-cents totals, verbatim status machine, Activity writer

> Slice 1 spec 3 of 8. Critique fixes applied: (1) now dependsOn `slice1-variant-resolver-socket` and OWNS the offerService VariantResolver DI wiring (default NullVariantResolver); (2) CREATE SEQUENCE runs once idempotently in a guarded pre-step, hot path only calls nextval; (3) nextval is non-transactional, so the 50-parallel test asserts 50 DISTINCT numbers (NOT gapless), DoD reworded "no duplicate" not "no gap-induced collision"; (4) raw writes via the tx client per the repository seam.

## Goal

The heart of Slice 1: the transport-agnostic domain service over the repository interface. ANG numbering via a per-year Postgres SEQUENCE (NOT Medusa's racy max(seq)+1), server-computed integer-cents totals, the status machine ported verbatim from busbasisberlin, and an Activity writer on every transition. `createOffer(client, lineItems[], ...)` is ONE `prisma.$transaction`.

## Scope

**In:**
- `allocateOfferNumber()`: `CREATE SEQUENCE IF NOT EXISTS ang_seq_<year>` runs ONCE in a guarded pre-step (idempotent, in provisioning or a first-use guard), and the hot path calls only `nextval` inside the same `$transaction` as the offer INSERT. Format `ANG-YYYY-####` (4-digit zero-pad). Gap-tolerant by design (nextval is non-transactional, a cancelled draft burns a number).
- Totals: server-computed on every offer/line-item mutation, integer cents EUR. Per line: `total_price = unit_price*quantity - discount`, `tax_amount = round(net_after_discount * tax_rate/100)` where tax_rate is the snapshot 19|7|0. Offer subtotal = sum of net line amounts, tax = sum of line tax, total = subtotal+tax. Do NOT port Medusa's gross/1.19 inclusive derivation (service.ts:404); compute per-line from the snapshot tax_rate. Totals persist onto the offer row; share/PDF read persisted totals.
- Status machine ported VERBATIM from `service.ts:507-520` (draft->active|cancelled; active->accepted|cancelled|draft; accepted->completed|cancelled|active; completed/cancelled terminal). Side effects: ->active makes shareable; ->accepted sets accepted_at + stage=Won; ->completed sets completed_at; ->cancelled sets cancelled_at + stage=Lost.
- Activity writer: every transition + every create writes an Activity row inside the same transaction.
- `offerService` accepts a `VariantResolver` via constructor/DI, defaulting to `NullVariantResolver` (the DI wiring moved here from the variant-resolver spec).

**Out (explicitly deferred):**
- Inventory checks (`checkOfferInventoryAvailability`, `getVariantAvailability`) NOT ported (NullVariantResolver).
- HTTP routes, public page, agent tools, BoardView (sibling specs).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/offers/domain/offerService.ts` | new | createOffer, addLineItem, transitionOffer, recomputeTotals; accepts VariantResolver (default NullVariantResolver) |
| `src/server/offers/domain/numbering.ts` | new | allocateOfferNumber (guarded CREATE SEQUENCE pre-step + nextval in tx), formatAngNumber |
| `src/server/offers/domain/totals.ts` | new | computeLineTotals, computeOfferTotals (integer cents) |
| `src/server/offers/domain/statusMachine.ts` | new | VALID_TRANSITIONS verbatim, isValidStatusTransition, applyTransitionSideEffects |
| `src/server/offers/domain/activity.ts` | new | writeActivity |
| `src/server/offers/domain/clientService.ts` | new | createClient |
| `src/server/offers/domain/projectService.ts` | new | createProject |
| `src/server/offers/domain/__tests__/*.test.ts` | new | atomicity, concurrency, totals, status machine, year rollover |

## API surface

```ts
class OfferService {
  constructor(repos: Repositories, variantResolver: VariantResolver = new NullVariantResolver()) {}
  createOffer(input: CreateOfferInput): Promise<OfferRow>;       // ONE $transaction
  addLineItem(offerId: string, input: AddLineItemInput): Promise<OfferRow>;
  transitionOffer(offerId: string, newStatus: OfferStatus, actor: Actor): Promise<OfferRow>;
  recomputeTotals(offerId: string, tx: RepositoryTx): Promise<OfferTotals>;
}
function allocateOfferNumber(tx: RepositoryTx, year: number): Promise<string>; // nextval only; sequence pre-created
function formatAngNumber(year: number, seq: number): string; // ANG-YYYY-####
const VALID_TRANSITIONS: Record<OfferStatus, OfferStatus[]>;   // verbatim from service.ts:507-520
```

## Data shapes

```ts
type OfferStatus = 'draft' | 'active' | 'accepted' | 'completed' | 'cancelled';
type Actor = { kind: 'user' | 'agent' | 'customer'; id?: string };
// numbering: CREATE SEQUENCE IF NOT EXISTS ang_seq_2026; nextval('ang_seq_2026'); non-transactional => gaps OK, no duplicates
```

## Test plan

- [ ] Integration: `createOffer` with N line items runs as one atomic `$transaction`; a forced throw after line item 2 leaves ZERO rows.
- [ ] Concurrency: 50 parallel `createOffer` calls yield 50 DISTINCT `ANG-YYYY-####` (no DUPLICATE; gaps are accepted because nextval is non-transactional). Assert via inspecting generated SQL uses a real SEQUENCE (`pg_sequences`).
- [ ] Unit: a fixtured offer (2 lines, mixed 19%/7%, one discount) produces exact expected integer-cents subtotal/tax/total.
- [ ] Unit: table-driven over all 25 status pairs rejects every illegal transition and applies correct side effects + writes an Activity on each legal transition.
- [ ] Unit: year rollover allocates `ANG-2027-0001` from a fresh sequence after `ANG-2026-N`.
- [ ] Unit: `offerService` defaults to NullVariantResolver and never calls setStock/setPrice (no such methods exist).

## Definition of done

- [ ] All atomicity / concurrency / totals / status / rollover tests pass.
- [ ] CREATE SEQUENCE runs once (guarded), hot path calls nextval only.
- [ ] offerService DI of VariantResolver wired, defaults to NullVariantResolver.
- [ ] `pnpm exec tsc --noEmit` + tests pass.

## Open questions

- Gapless numbering is NOT required (gap-tolerant by design). If a downstream legal/accounting requirement later demands gapless, switch to a `counters` row with `SELECT ... FOR UPDATE` inside the tx (holistic 5.2 alternative). Flag to Marlin only if such a requirement surfaces.

## References

- Plan: holistic plan 5.2, 5.3; commerce plan 8.2
- Code touchpoints: MedusaJS busbasisberlin `src/modules/offer/service.ts` status machine (507-520, ported verbatim), generateOfferNumber (474-502, NOT ported), calculateOfferTotals /1.19 (404, NOT ported)
