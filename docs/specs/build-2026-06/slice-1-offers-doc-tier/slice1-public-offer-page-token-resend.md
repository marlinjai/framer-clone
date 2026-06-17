---
name: slice1-public-offer-page-token-resend
track: slice-1-offers-doc-tier
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-web
status: draft
dependsOn: [slice1-admin-http-routes]
touchesSharedState: true
sharedState: []
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit
---

> **PARKED 2026-06-16:** separate lumitra-web workstream, NOT part of the framer-clone build loop. See `/Users/marlinjai/software-dev/ERP-suite/projects/framer-clone/docs/specs/build-2026-06/ROADMAP.md`. Content preserved for the lumitra-web offers/CRM workstream pickup; do NOT dispatch from the framer-clone orchestrator.

# Tokenized branded public offer/accept page + Resend send

> Slice 1 spec 6 of 8. Critique fix applied: token.ts is OWNED by `slice1-admin-http-routes` (the share-link route is its first consumer); this spec CONSUMES that single implementation, it does not re-port the hashing. The byte-for-byte hashing assertion still lives here as the public-page contract.

## Goal

The public, no-account-required acceptance flow (port of Medusa offer-token.ts + accept/route.ts). A public server-rendered Next route at `/o/:offerId` in Lumitra branding, reusing the existing `src/components/offer/OfferPage.tsx` repointed at the data-table-backed offer. Accept is one POST gated by the stateless token. `POST /api/offers/:id/send` transitions draft->active then emails the share link via Resend.

## Scope

**In:**
- Public SSR route `/o/:offerId` reading `?token=&email=`, rendering client block, line items table, subtotal/VAT-per-rate/total from PERSISTED totals, valid_until, customer_notes. `internal_notes` NEVER rendered.
- First GET writes a `viewed` Activity (open tracking); refresh does not double-write within a window.
- Accept POST: validate token (via `token.ts` from the admin spec) + email matches the offer's client email + status==='active', transition to accepted, write Activity(actor='customer').
- `POST /api/offers/:id/send`: transition draft->active then email the share link via Resend.
- Reuse/adapt `src/components/offer/OfferPage.tsx` repointed at the data-table-backed Offer + integer-cents formatting (old string-money type superseded; pre-MVP, no back-compat).
- Resend wrapper `src/server/email/resendClient.ts` (`RESEND_API_KEY` from Infisical).
- Unhappy paths LOUD: bad token -> 403 page; email mismatch -> 403; accepting a non-active offer -> 409 with clear message; expired valid_until -> shown as expired (viewable, accept blocked); Resend send failure -> 502 (not a silent success).
- `OFFER_ACCEPTANCE_SECRET` from env, default-secret fallback removed (fail loudly if unset in production).

**Out (explicitly deferred):**
- PDF generation (print-to-PDF later; Medusa `pdf-generator.ts` is the reference port, not built now).
- Invoicing (offers stop at accepted), Stripe, multi-currency.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/app/o/[offerId]/page.tsx` | new | public SSR accept page |
| `src/app/api/offers/[id]/accept/route.ts` | new | public POST, token-gated |
| `src/app/api/offers/[id]/send/route.ts` | new | transition->active + Resend |
| `src/components/offer/OfferPage.tsx` | edit | repoint to data-table-backed Offer + integer-cents formatting |
| `src/server/email/resendClient.ts` | new | Resend wrapper |
| `src/app/o/__tests__/publicFlow.test.ts` | new | token, leak, accept, send |

## API surface

```ts
// consumes token.ts from slice1-admin-http-routes (no re-port)
import { validateOfferAcceptanceToken } from '@/server/offers/token';
export async function sendOffer(offerId: string): Promise<void>; // transition->active + Resend; throws -> 502 at route
```

## Test plan

- [ ] Unit: `generateOfferAcceptanceToken`/`validate` (from token.ts) produce byte-for-byte match against the Medusa formula for a fixed input.
- [ ] Public `/o/:id` renders persisted totals and never leaks `internal_notes` (assert absent from HTML).
- [ ] First GET writes one `viewed` Activity; refresh does not double-write within the window.
- [ ] Accept with valid token+email+active offer -> accepted + customer Activity; bad token -> 403; non-active offer -> 409.
- [ ] `POST /send` transitions to active and calls Resend with the share URL (Resend client mocked; a send failure surfaces as 502, not silent success).

## Definition of done

- [ ] All public-flow tests pass; internal_notes leak test green.
- [ ] OfferPage repointed; old string-money type removed.
- [ ] SECRET from env, fail-loud-if-unset in production.
- [ ] `pnpm exec tsc --noEmit` + tests pass.

## Open questions

- None blocking.

## References

- Plan: holistic plan 5.4, 4.2
- Code touchpoints: Medusa `src/utils/offer-token.ts`, `accept/route.ts`, `pdf-generator.ts` (reference only)
