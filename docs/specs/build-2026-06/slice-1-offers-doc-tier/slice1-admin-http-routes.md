---
name: slice1-admin-http-routes
track: slice-1-offers-doc-tier
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/lumitra-web
status: draft
dependsOn: [slice1-domain-numbering-totals-status-activity, slice1-variant-resolver-socket]
touchesSharedState: true
sharedState: []
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit
---

> **PARKED 2026-06-16:** separate lumitra-web workstream, NOT part of the framer-clone build loop. See `/Users/marlinjai/software-dev/ERP-suite/projects/framer-clone/docs/specs/build-2026-06/ROADMAP.md`. Content preserved for the lumitra-web offers/CRM workstream pickup; do NOT dispatch from the framer-clone orchestrator.

# Admin HTTP routes (clients/projects/offers/line-items/transition/activities) behind the auth.can interim stub

> Slice 1 spec 5 of 8. Critique fix applied: `src/server/offers/token.ts` (the byte-for-byte token util) is OWNED HERE because the admin `GET /share-link` route is the token's first consumer; `slice1-public-offer-page-token-resend` depends on this spec and reuses the single token implementation (no divergent hashing).

## Goal

Next.js route handlers under `src/app/api/offers` for the authenticated admin surface. Every route resolves the interim single shared login and gates through a local `auth.can(user, action, resource)`-shaped stub so the P2 auth-brain SDK retrofit is a ~3-day swap. Routes are the thin transport over the domain service; they MUST produce loud errors (no silent swallow).

## Scope

**In:**
- Route handlers: clients/projects/offers CRUD; `POST /api/offers` (creates offer + nested snapshot line items atomically via domain createOffer); `POST /api/offers/:id/line-items`; `POST /api/offers/:id/transition`; `GET /api/offers/:id/share-link`; `GET /api/activities`.
- `src/server/offers/token.ts`: `generateOfferAcceptanceToken`, `validateOfferAcceptanceToken`, `generateOfferAcceptanceUrl`, ported byte-for-byte from Medusa `src/utils/offer-token.ts`. SECRET from `OFFER_ACCEPTANCE_SECRET` (Infisical), no default-secret fallback.
- `src/server/auth/interimAuth.ts`: `requireAuth` (HTTP-only cookie, single credential in Infisical), `can(user, action, resource)` stub that always returns true for the shared user, tagged `TODO-AUTH-BRAIN`.
- Zod-validate every request body. Loud errors: invalid status transition -> 422 with reason; validation fail -> 400; not-found -> 404; auth fail -> 401.
- Totals returned from the persisted offer row (never recomputed in the route).

**Out (explicitly deferred):**
- Public/token-gated routes (`/o/:id`, `/accept`, `/send`) -> sibling spec `slice1-public-offer-page-token-resend`.
- Agent tools, CLI, BoardView (sibling specs).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/app/api/offers/route.ts` | new | GET list, POST create |
| `src/app/api/offers/[id]/route.ts` | new | GET/PATCH |
| `src/app/api/offers/[id]/line-items/route.ts` | new | POST |
| `src/app/api/offers/[id]/transition/route.ts` | new | POST |
| `src/app/api/offers/[id]/share-link/route.ts` | new | GET (uses token.ts) |
| `src/app/api/clients/route.ts` + `[id]/route.ts` | new | CRUD |
| `src/app/api/projects/route.ts` + `[id]/route.ts` | new | CRUD |
| `src/app/api/activities/route.ts` | new | GET |
| `src/server/offers/token.ts` | new | OWNED HERE; sha256(offerId+':'+email+':'+SECRET).slice(0,32) |
| `src/server/auth/interimAuth.ts` | new | requireAuth + can stub, TODO-AUTH-BRAIN |
| `src/server/offers/http/schemas.ts` | new | Zod request schemas |
| `src/app/api/offers/__tests__/adminFlow.test.ts` | new | full admin flow integration |

## API surface

```ts
// interimAuth.ts
export function requireAuth(req: Request): Promise<SharedUser>;   // 401 if cookie absent/invalid
export function can(user: SharedUser, action: string, resource: string): boolean; // TODO-AUTH-BRAIN: always true for shared user

// token.ts (single source of truth for the hash)
export function generateOfferAcceptanceToken(offerId: string, clientEmail: string): string;
export function validateOfferAcceptanceToken(token: string, offerId: string, clientEmail: string): boolean;
export function generateOfferAcceptanceUrl(offerId: string, clientEmail: string): string;
```

## Test plan

- [ ] Integration (Dockerized Postgres): create client -> create project -> `POST /api/offers` with 3 line items (asserts one ANG-YYYY-#### allocated, totals persisted) -> POST a line item -> POST an illegal transition (422 with reason) -> POST a legal transition (Activity written, stage updated).
- [ ] Unauthenticated request returns 401.
- [ ] The `can` stub exposes exactly the `can(user, action, resource)` signature with a `TODO-AUTH-BRAIN` marker.
- [ ] `GET /share-link` returns a URL whose token matches `token.ts` (byte-for-byte).

## Definition of done

- [ ] All admin routes implemented, each Zod-validated, each behind requireAuth + can stub.
- [ ] Loud error mapping (400/401/404/422) verified.
- [ ] token.ts ported byte-for-byte; share-link route uses it.
- [ ] `pnpm exec tsc --noEmit` + tests pass.

## Open questions

- None blocking.

## References

- Plan: holistic plan 5.4, 3.3
- Code touchpoints: Medusa `src/utils/offer-token.ts`
