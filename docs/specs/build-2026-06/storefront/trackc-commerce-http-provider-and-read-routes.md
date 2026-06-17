---
name: trackc-commerce-http-provider-and-read-routes
track: storefront
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-commerce-data-source-seam-and-dtos, b7-commerce-rest-reads]
touchesSharedState: false
sharedState: []
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# HTTP CommerceDataSource provider over the Track B /api/commerce/* read routes

> DEPENDENCY-ID FIX (critique major): depends on `b7-commerce-rest-reads` (the Track B spec that OWNS the `/api/commerce/*` GET routes), NOT a `trackb-commerce-repository` placeholder. The route handlers live in Track B (`b7`); this spec adds only the client-side `HttpCommerceDataSource` that calls them. touchesSharedState=false (no route files added here, no new deps; the routes are b7's).

## Goal

Back the `CommerceDataSource` seam with `HttpCommerceDataSource` calling the Track-B `/api/commerce/*` read routes (catalog list/detail, variants, prices, availability). `subscribe()` polls (default 5s). The HTTP provider passes the SAME contract suite the in-memory double passes. The availability read carries the HARD LINE: the number is advisory and NEVER permission to complete a sale (the b3 guarded reserve is the sole authority).

## Scope

**In:**
- `src/lib/commerce/httpCommerceDataSource.ts`: `HttpCommerceDataSource implements CommerceDataSource`, calling the b7 routes. Maps the b7 DTOs to the seam DTOs (or reuses them directly if shape-identical), surfaces errors well-formed (never leaks Prisma errors). `subscribe()` polls 5s.
- Note: b7 currently exposes `products` (list), `products/[handle]` (detail), `inventory` (availability). If the seam needs `products/[id]/variants` and `variants/[id]/prices` as separate routes, request them as a small additive PR to b7 (Track B owns the route files); do NOT add route files in this storefront spec.

**Out (explicitly deferred):**
- Adding/owning route handlers (Track B `b7` owns `/api/commerce/*`).
- Any write/checkout route (E8; the checkout spec posts to a Track-B order route).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/commerce/httpCommerceDataSource.ts` | new | HttpCommerceDataSource, calls b7 routes, polling subscribe |
| `src/lib/commerce/__tests__/httpCommerceDataSource.test.ts` | new | same contract suite, fetch mocked against b7 route shapes |

## API surface

```ts
export class HttpCommerceDataSource implements CommerceDataSource {
  constructor(opts?: { baseUrl?: string; pollMs?: number });
  // ...the CommerceDataSource interface methods, calling the b7 /api/commerce/* routes...
}
```

## Test plan

- [ ] `HttpCommerceDataSource` passes the SAME contract suite as `InMemoryCommerceDataSource` (fetch mocked against the b7 route shapes).
- [ ] The availability mapping carries the advisory-only marker; a test asserts no write/reserve happens on the read path.
- [ ] Errors are well-formed (never leak Prisma errors).

## Definition of done

- [ ] `HttpCommerceDataSource` implements the seam and passes the in-memory double's contract suite.
- [ ] Availability carries `availableQuantity` + `locationId` + `stale` + the advisory-only marker; the no-write-on-read test passes.
- [ ] Any new route NEEDED beyond b7's three is requested as an additive b7 PR, not added here.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- Confirm whether b7's three routes (`products`, `products/[handle]`, `inventory`) suffice, or whether the seam needs dedicated `variants`/`prices` routes. RECOMMEND: extend b7 additively (Track B owns the routes) rather than splitting route ownership across tracks.

## References

- Re-scope open decision: storefront reads are public for v1.
- Cross-check doc section 4.4 (advisory-only availability).
- Depends on: `trackc-commerce-data-source-seam-and-dtos` (the interface + DTOs), `b7-commerce-rest-reads` (the routes)
