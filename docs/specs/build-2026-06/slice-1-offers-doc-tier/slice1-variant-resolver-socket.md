---
name: slice1-variant-resolver-socket
track: slice-1-offers-doc-tier
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-web
status: draft
dependsOn: [slice1-repository-and-withtenant-seam]
touchesSharedState: false
sharedState: []
estimateDays: 2
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit
---

> **PARKED 2026-06-16:** separate lumitra-web workstream, NOT part of the framer-clone build loop. See `/Users/marlinjai/software-dev/ERP-suite/projects/framer-clone/docs/specs/build-2026-06/ROADMAP.md`. Content preserved for the lumitra-web offers/CRM workstream pickup; do NOT dispatch from the framer-clone orchestrator.

# VariantResolver interface + NullVariantResolver socket (variant_ref nullable TEXT, source enum none|datatable|owned)

> Slice 1 spec 4 of 8. Critique fix applied (Option b): this spec is now a PURE leaf. It defines the interface + NullVariantResolver ONLY and does NOT edit offerService.ts. The "offerService accepts a VariantResolver" wiring lives in `slice1-domain-numbering-totals-status-activity`, which depends on this spec. This keeps the leaf truly independent (touchesSharedState: false) and removes the sibling-file-edit ordering bug.

## Goal

Wire the commerce-engine socket the offers module will later resolve against the owned commerce service in-process, without building any commerce engine now. Define the READ-ONLY, ENRICH-ONLY `VariantResolver` interface and ship `NullVariantResolver` as the only implementation. Swapping `NullVariantResolver -> OwnedCommerceVariantResolver` later (P4-inner, epic E3) is an in-process module swap with zero offers-side change.

## Scope

**In:**
- `VariantResolver` interface: `resolveMany(refs)` (prefill-on-ADD, never re-resolves a committed snapshot), `getAvailability(ref, location)`, `applyInventoryEffect(effect)`. NO `setStock`, NO `setPrice`, NO `merge`.
- `VariantRef { source: 'datatable' | 'owned'; id: string }` and `VariantRefSource = 'none' | 'datatable' | 'owned'` (NO `'medusa'`).
- `NullVariantResolver`: `resolveMany` returns refs un-enriched; `getAvailability` returns unmanaged/always-available; `applyInventoryEffect` is a no-op success.

**Out (explicitly deferred):**
- Editing offerService (moved to the domain spec, which depends on this one).
- Any commerce schema, inventory ledger, owned resolver (P4-inner, epics E1/E2/E3).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/server/offers/commerce/variantResolver.ts` | new | interface, VariantRef, VariantRefSource, AvailabilityResult, InventoryEffect |
| `src/server/offers/commerce/nullVariantResolver.ts` | new | NullVariantResolver |
| `src/server/offers/commerce/__tests__/nullVariantResolver.test.ts` | new | identity passthrough, always-available, no-op success |

## API surface

```ts
export type VariantRefSource = 'none' | 'datatable' | 'owned'; // NO 'medusa'
export interface VariantRef { source: 'datatable' | 'owned'; id: string }

export interface AvailabilityResult { managed: boolean; available: boolean; quantity?: number }
export interface InventoryEffect { type: 'reserve' | 'release' | 'fulfill'; ref: VariantRef; quantity: number; requestId: string }

export interface VariantResolver {
  resolveMany(refs: VariantRef[]): Promise<EnrichedVariant[]>; // prefill-on-ADD only, never re-resolve a snapshot
  getAvailability(ref: VariantRef, location?: string): Promise<AvailabilityResult>;
  applyInventoryEffect(effect: InventoryEffect): Promise<{ ok: true } | { ok: false; reason: string }>;
  // NO setStock, NO setPrice, NO merge anywhere
}

export class NullVariantResolver implements VariantResolver { /* identity / always-available / no-op success */ }
```

## Test plan

- [ ] Type test: the interface has no `setStock`/`setPrice`/`merge` members.
- [ ] Unit: `resolveMany` is identity-passthrough; `getAvailability` returns `{ managed:false, available:true }`; `applyInventoryEffect` returns `{ ok:true }`.
- [ ] Unit: a line item with `variant_ref=null`, `variant_ref_source='none'` round-trips; a line item with `source:'datatable'` + ref string persists the loose TEXT without an FK.

## Definition of done

- [ ] `VariantResolver` + `NullVariantResolver` compile.
- [ ] No-setStock/setPrice/merge type test passes.
- [ ] NullVariantResolver unit tests pass.
- [ ] `pnpm exec tsc --noEmit` + tests pass.
- [ ] No commerce schema/ledger/owned resolver built.

## Open questions

- None blocking.

## References

- Plan: commerce plan 2026-06-01 section 8.1
