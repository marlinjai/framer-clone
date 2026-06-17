---
name: b7-commerce-rest-reads
track: commerce-engine
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [b4-catalog-schema, b3-guarded-reservation, b5-pricing-and-tax]
touchesSharedState: false
sharedState: []
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Commerce REST read surface: /api/commerce catalog + inventory available_quantity (advisory-only), polling-friendly, for the Track C storefront

> The read transport for the v1 cut (reads via plain REST/polling; NO realtime, NO CRDT, NO authoritative broadcast which is E6). DEPENDENCY FIX (critique minor): `dependsOn` now includes `b5-pricing-and-tax` because the product DTO carries `resolvedPriceCents` (via b5 `resolvePrice`). It also depends on `b4` (catalog) and `b3` (which transitively pulls b2's InventoryLevel + generated `available_quantity`). Adds API route handlers + DTOs only; ADDS no models to `prisma/schema.prisma`.

## Goal

Expose `/api/commerce/*` read routes (Track-0 api conventions + b1 withTenant + unauthenticated-reads-for-v1): catalog reads resolving typed commerce DTOs via the b4 CatalogRepository (+ b5 resolved price), and inventory reads (`inventory_level.available_quantity` per variant/location) via the b2/b3 inventory repo. CRITICAL: the exposed `available_quantity` is ADVISORY-ONLY (fire-and-forget freshness); NO client path may treat a read availability number as permission to complete a sale: the b3 guarded reserve is the SOLE authority and rejects at reserve time regardless.

## Scope

**In:**
- `src/app/api/commerce/products/route.ts` (GET list), `products/[handle]/route.ts` (GET detail), `inventory/route.ts` (GET available_quantity by variant+location). Run server-side through `withTenant`, return zod-validated typed commerce DTOs (product+options+variants+resolved price+advisory available_quantity), UNAUTHENTICATED reads.
- Each availability response is documented/typed as advisory-only with a comment citing the doc (no sale-completion authority).
- DTOs do NOT force the rich commerce graph through the flat CMS Collection/Row shape (a parallel commerce read surface; shares nothing in the DB with the CMS tier).

**Out (explicitly deferred):**
- Order-mutation route (E8 checkout; Track C posts to it).
- Authoritative broadcast (E6), Yjs (E5).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/app/api/commerce/products/route.ts` | new | GET list; typed ProductDTO[] |
| `src/app/api/commerce/products/[handle]/route.ts` | new | GET detail by handle |
| `src/app/api/commerce/inventory/route.ts` | new | GET available_quantity by variant+location; advisory-only |
| `src/lib/commerce/dto.ts` | new | ProductDTO / AvailabilityDTO (advisoryOnly: true) |
| `src/app/api/commerce/__tests__/*.itest.ts` | new (integration) | typed graph, handle resolution, availability matches generated col |

## API surface

```ts
// GET /api/commerce/products            -> { products: ProductDTO[]; nextCursor?: string }
// GET /api/commerce/products/[handle]    -> ProductDTO | 404
// GET /api/commerce/inventory?variantId=&locationId= -> AvailabilityDTO  // advisory only
export interface ProductDTO { id; handle; title; description; options; variants; resolvedPriceCents: number }
export interface AvailabilityDTO { variantId; locationId; availableQuantity: number; advisoryOnly: true }
```

## Test plan

- [ ] Integration: list returns the typed graph (NOT a flat CMS Row).
- [ ] Detail resolves by handle.
- [ ] Inventory returns `available_quantity` matching the b2 generated column.
- [ ] The DTO carries the advisory-only marker; a comment cites the doc (no sale-completion authority).
- [ ] Reads are unauthenticated; routes need only a placeholder DATABASE_URL at build (headless verify).

## Definition of done

- [ ] The 3 GET routes land, run through `withTenant`, return zod-validated typed commerce DTOs, unauthenticated.
- [ ] `resolvedPriceCents` resolves via b5 (dependency declared).
- [ ] Availability response is advisory-only (typed + commented); integration test asserts it matches the generated column.
- [ ] NO authoritative broadcast, NO Yjs, NO order-mutation route.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Cross-check doc section 4.4 (available_quantity advisory-only), 7-8 (v1 reads via plain REST).
- Critique (minor, fixed): b5 added to dependsOn because the DTO carries resolvedPriceCents.
- Depends on: `b4-catalog-schema`, `b3-guarded-reservation` (transitive b2 inventory), `b5-pricing-and-tax` (resolvePrice)
