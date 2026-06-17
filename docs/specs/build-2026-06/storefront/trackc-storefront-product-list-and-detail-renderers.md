---
name: trackc-storefront-product-list-and-detail-renderers
track: storefront
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-commerce-binding-scope-frame-and-resolver, trackc-commerce-http-provider-and-read-routes, slice2-read-only-data-components, slice2-data-loading-empty-error-states]
touchesSharedState: false
sharedState: []
estimateDays: 5
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# ProductList/Grid + ProductDetail renderers (bound to CommerceDataSource, repeating template + record)

> DEPENDENCY-ID FIX (critique major): depends on the REAL Track A spec ids `slice2-read-only-data-components` (the CMS data components / scope threading) and `slice2-data-loading-empty-error-states` (`resolveDataState`), NOT `trackc-cms-data-components` / `trackc-cms-loading-empty-error-states`.

> Two storefront canvas renderers modelled exactly on the CMS `CollectionRenderer`/`RecordViewRenderer` (first-child-as-template repeat, scope frame per iteration, scope threaded through children) but resolving the typed commerce graph via `useCommerceDataSource()`. Read-only; never write stock/money.

## Goal

`ProductListRenderer` reads its `products` binding + optional `CommerceQuery` on `props.query`, calls `listProducts`, pushes a product frame per product, repeats `children[0]` as the per-product card template (the storefront analog of Events->gallery). `ProductDetailRenderer` resolves a single product from `{{page.params.handle}}`, pushes a product frame, exposes `{{product.*}}`, and resolves the default/first variant into a variant frame so price + availability render. Both route through the shared `resolveDataState`.

## Scope

**In:**
- `src/lib/renderer/commerce/ProductListRenderer.tsx`: repeats `children[0]` per product, pushes a product frame per iteration.
- `src/lib/renderer/commerce/ProductDetailRenderer.tsx`: single product from `page.params.handle`, pushes product + default-variant frames.
- Both route through `resolveDataState` (loading/empty/error/content, both modes; zero products, product-not-found, fetch error: editor inline chip, preview/headless renders nothing, never throws SSR/static emit).
- Renderer dispatch goes through `createComponentElement`'s `dataComponentKind` branch (extended to the commerce kinds in the register spec).

**Out (explicitly deferred):**
- Variant selector (next spec), cart/checkout (later specs).
- Registry/dispatch wiring (the register spec; until then dispatch is reserved).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/commerce/ProductListRenderer.tsx` | new | repeats children[0] per product |
| `src/lib/renderer/commerce/ProductDetailRenderer.tsx` | new | single product + default variant frame |
| `src/lib/renderer/commerce/__tests__/*.test.tsx` | new | per renderer + editor/headless parity |

## API surface

```ts
function ProductListRenderer(props: { node; scope; query?: CommerceQuery }): ReactNode; // repeats children[0] per product
function ProductDetailRenderer(props: { node; scope }): ReactNode; // single product from page.params.handle, pushes product + default-variant frames
```

## Test plan

- [ ] `ProductListRenderer` bound to a fixture catalog with N products renders N card templates; each descendant `{{product.field}}` resolves to that product.
- [ ] `ProductDetailRenderer` from `page.params.handle` resolves the right product and exposes `{{product.*}}` + the default variant's `{{variant.price}}` / `{{availability.quantity}}` to descendants; a non-existent handle hits empty/error.
- [ ] Both route through `resolveDataState` (all four directives, both modes).
- [ ] `subscribe` re-renders on store change.
- [ ] Editor/headless parity test green.

## Definition of done

- [ ] Both renderers land; first-child-as-template; product (+ default variant) frames pushed.
- [ ] Both route through `resolveDataState`; all four directives in both modes.
- [ ] subscribe re-renders; parity test green.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Code touchpoints: the CMS `CollectionRenderer`/`RecordViewRenderer` (the model), `resolveDataState`, `useCommerceDataSource()`, `createComponentElement` dataComponentKind branch
- Depends on: `trackc-commerce-binding-scope-frame-and-resolver`, `trackc-commerce-http-provider-and-read-routes`, `slice2-read-only-data-components`, `slice2-data-loading-empty-error-states`
