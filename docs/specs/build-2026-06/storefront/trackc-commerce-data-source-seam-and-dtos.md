---
name: trackc-commerce-data-source-seam-and-dtos
track: storefront
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [b4-catalog-schema, b2-inventory-ledger-schema, track0-backend-foundation]
touchesSharedState: false
sharedState: []
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# CommerceDataSource read seam + typed commerce DTOs (parallel to DataSourceProvider)

> DEPENDENCY-ID FIX (critique major): all cross-track dep IDs use the REAL canonical spec names. Track B commerce specs are `b2-inventory-ledger-schema`, `b4-catalog-schema`, etc. (NOT `trackb-commerce-*`); Track A CMS specs are `slice2-*` (NOT `trackc-cms-*`). This spec's edges resolve against the actually-emitted specs.

> Adds a SECOND read seam, `CommerceDataSource`, alongside the existing `DataSourceProvider`, so storefront components resolve a RICH TYPED commerce graph instead of being squeezed through the flat CMS `Collection`/`Row` shape. Shares the Track A resolver/scope/registry machinery but carries its own typed DTOs.

## Goal

A `CommerceDataSource` React context (`CommerceDataSourceContext` + `useCommerceDataSource()`) mirroring `src/lib/bindings/dataSource/context.tsx`, with an in-memory provider (test double, seeded with a Medusa-shape fixture catalog) and (next spec) an HTTP provider behind the same interface. Reads ONLY: catalog, price, and `availability` reads that surface `inventory_level.available_quantity` as ADVISORY (never permission to sell). NO write methods on the catalog/stock path (those are Track B server-authoritative).

## Scope

**In:**
- `src/lib/commerce/context.tsx`: `CommerceDataSourceContext`, `useCommerceDataSource()` (throws loudly outside a provider, mirroring `useDataSource()`).
- `src/lib/commerce/provider.ts`: the `CommerceDataSource` interface (reads only).
- `src/lib/commerce/types.ts`: `ProductDTO`, `ProductOptionDTO`, `ProductOptionValueDTO`, `ProductVariantDTO` (title, sku, barcode, resolved option_value coordinate), `PriceDTO` (integer cents + currency + tax_class), `AvailabilityDTO` (`available_quantity`, `location_id`, `stale: boolean`).
- `src/lib/commerce/inMemoryCommerceDataSource.ts`: `getSharedInMemoryCommerceDataSource()` test double (Medusa-shape fixture: 1 product, 2 options, 4 variants, prices, inventory levels per location) implementing the full interface.
- Map Track B catalog/inventory rows to these DTOs in the provider; never leak Prisma types to the client.

**Out (explicitly deferred):**
- HTTP provider + `/api/commerce/*` routes (next spec; Track B `b7-commerce-rest-reads` provides the routes).
- Any write/reserve method (Track B authoritative).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/commerce/context.tsx` | new | CommerceDataSourceContext + useCommerceDataSource (throws) |
| `src/lib/commerce/provider.ts` | new | CommerceDataSource interface (reads only) |
| `src/lib/commerce/types.ts` | new | typed DTOs |
| `src/lib/commerce/inMemoryCommerceDataSource.ts` | new | shared in-memory test double |
| `src/lib/commerce/__tests__/inMemoryCommerceDataSource.test.ts` | new | contract suite |

## API surface

```ts
export const CommerceDataSourceContext: React.Context<CommerceDataSource | null>;
export function useCommerceDataSource(): CommerceDataSource; // throws if no provider
export interface CommerceDataSource {
  listProducts(query?: CommerceQuery): Promise<ProductPage>;
  getProduct(productId: string): Promise<ProductDTO | null>;
  getProductByHandle(handle: string): Promise<ProductDTO | null>;
  listVariants(productId: string): Promise<ProductVariantDTO[]>;
  getVariant(variantId: string): Promise<ProductVariantDTO | null>;
  getPrices(variantId: string): Promise<PriceDTO[]>;
  getAvailability(variantId: string, locationId?: string): Promise<AvailabilityDTO>; // advisory only
  subscribe(productId: string | null, onChange: () => void): () => void; // polling
}
export interface ProductDTO { id; handle; title; description; options: ProductOptionDTO[]; variantIds: string[] }
export interface ProductVariantDTO { id; productId; title; sku?; barcode?; optionValues: { optionId: string; valueId: string; label: string }[] }
export interface PriceDTO { variantId; amountCents: number; currency: string; taxClass?: string }
export interface AvailabilityDTO { variantId; locationId: string; availableQuantity: number; stale: boolean }
export function getSharedInMemoryCommerceDataSource(): CommerceDataSource;
```

## Test plan

- [ ] `InMemoryCommerceDataSource` (Medusa-shape fixture) implements the full interface and passes a contract suite (listProducts/getProduct/listVariants/getVariant/getAvailability/getPrices + subscribe polling).
- [ ] `useCommerceDataSource()` throws loudly outside a provider.
- [ ] No catalog/stock WRITE method exists on the interface (asserted).

## Definition of done

- [ ] Context, hook, interface, typed DTOs, in-memory double land.
- [ ] Contract suite green; the hook throws outside a provider.
- [ ] No write method on the interface.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Re-scope open decision: a parallel CommerceDataSource seam alongside DataSourceProvider, sharing the resolver + scope-frame infra.
- Code touchpoints: `src/lib/bindings/dataSource/context.tsx` (the seam this mirrors), `useDataSource()` (the throw-loudly contract)
- Depends on: `b4-catalog-schema`, `b2-inventory-ledger-schema`, `track0-backend-foundation`
