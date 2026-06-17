---
name: trackc-commerce-binding-preview-and-publish-hydration
track: storefront
wave: 3
priority: P1
status: done
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-register-storefront-components-as-bindable-blocks, slice2-publish-read-binding-hydration]
touchesSharedState: true
sharedState: [hydrate-bindings]
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Commerce binding preview parity + (gated) static-publish hydration of commerce bindings

> DEPENDENCY-ID FIX (critique major): depends on `slice2-publish-read-binding-hydration` (the REAL Track A hydration spec), NOT `trackc-cms-publish-hydration`. SHARED-STATE FIX (critique minor): this spec EXTENDS the `hydrateBindings` signature/file `src/lib/renderer/publish/hydrateBindings.ts` (created and owned by `slice2-publish-read-binding-hydration`), so `touchesSharedState: true` with `sharedState: [hydrate-bindings]`. It is the sole later editor and the CMS spec is an upstream dependency, so serial ownership is sound; the additive options-object `{ cmsRepo, commerceRepo }` keeps the CMS call site working.

> Prove a commerce-bound tree resolves through the React-free resolver and assert preview parity, then extend `hydrateBindings` so the static-publish path can bake commerce READS (ProductList per-product expansion, ProductDetail resolution) into concrete prop values at build time, calling the `src/server/commerce` repository DIRECTLY in Node. HARD LINE: ONLY catalog + advisory availability are hydrated (display values); interactive cart/variant-selection/checkout remain client-side runtime islands (NOT baked).

## Goal

Extend `hydrateBindings` (the options-object form from the CMS spec) with a `commerceRepo` so the static-publish path bakes ProductList (one block per product via `listProducts`) and ProductDetail (resolved from a page slug/handle) into static output, reading `src/server/commerce` directly in Node (no HTTP, no React). Interactive components (variant selector, cart, checkout) are explicitly NOT baked. Assert preview-vs-hydrated parity against `HeadlessPageRenderer` for a commerce-bound tree. The publish-pipeline WIRING stays gated on the static-html wave.

## Scope

**In:**
- `src/lib/renderer/publish/hydrateBindings.ts` (extend): the signature gains the commerce repo: `hydrateBindings(pageTree, pageParams, { cmsRepo, commerceRepo })`. ProductList -> one block per `ProductDTO` via `commerceRepo.listProducts` (Node-direct); ProductDetail -> resolved from `pageParams.handle` via `commerceRepo.getProductByHandle`. Advisory availability bakes as a display value with the stale/advisory comment. Empty catalog -> empty content; a fetch error renders nothing for the slot, never throws the build.
- A preview-vs-hydrated parity test against `HeadlessPageRenderer` for a commerce-bound tree.
- Interactive kinds (variant-selector / add-to-cart / cart-view / checkout-button) are NOT baked (left as runtime islands; documented + tested).

**Out (explicitly deferred / GATED):**
- The publish-pipeline WIRING (gated on the static-html wave, same gate as the CMS hydration spec).
- Runtime-island hydration for the interactive components (static-html wave).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/publish/hydrateBindings.ts` | edit | add `commerceRepo` to the options object; bake ProductList/ProductDetail. `hydrate-bindings` shared-state |
| `src/lib/renderer/publish/__tests__/hydrateBindings.commerce.test.ts` | new (node project) | per-product expansion, detail-from-handle, empty/error, interactive-not-baked |
| `src/lib/renderer/publish/__tests__/parity.commerce.test.ts` | new | commerce preview-vs-hydrated parity |

## API surface

```ts
// hydrateBindings now also expands commerce dataComponentKinds:
//   product-list   -> one block per ProductDTO via commerceRepo.listProducts (Node-direct)
//   product-detail -> resolved from pageParams.handle via commerceRepo.getProductByHandle
// signature gains the commerce repo (additive options field):
export async function hydrateBindings(
  pageTree: ComponentNode,
  pageParams: Record<string, string>,
  repos: { cmsRepo: CmsReadRepository; commerceRepo: CommerceServerRepository },
): Promise<ComponentNode>;
// interactive kinds (variant-selector/add-to-cart/cart-view/checkout-button) are NOT hydrated (runtime islands)
```

## Test plan

- [ ] `hydrateBindings` expands ProductList (one block per product) and resolves ProductDetail (from a handle) via the `src/server/commerce` repo called directly in Node (no React/jsdom, asserted).
- [ ] Advisory availability bakes as a display value with the stale/advisory comment.
- [ ] Interactive commerce components are NOT baked (test that their nodes are left as runtime placeholders).
- [ ] Empty catalog -> empty content; a forced hydration error renders nothing, never throws.
- [ ] Preview-vs-hydrated parity test green against `HeadlessPageRenderer` for a commerce-bound tree.

## Definition of done

- [ ] `hydrateBindings` extended with `commerceRepo` (additive options object; CMS call site unbroken).
- [ ] ProductList/ProductDetail bake; interactive kinds left as islands; empty/error handled; never throws.
- [ ] Commerce parity test green.
- [ ] A follow-on stub records the publish-pipeline wiring is gated on the static-html wave.
- [ ] Headless-safe (invariant, Track 0): compiling the `src/server/commerce` import in `next build` must NOT need a live `DATABASE_URL`; the Track-0 Prisma singleton is lazy (connects on first query, not on import) and the publish-pipeline wiring stays GATED (helper only, not invoked at build). The verify command carries a throwaway placeholder `DATABASE_URL` (belt-and-suspenders, uniform with the CMS + b-chain) so headless-safety never depends on the singleton staying lazy; a future edit that connects at import time must keep the lazy boundary regardless.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Critique (minors, fixed): real Track A dep id; touchesSharedState flagged on the hydrateBindings extend; additive options object.
- Code touchpoints: `src/lib/renderer/publish/hydrateBindings.ts` (the CMS-spec-owned helper), `HeadlessPageRenderer.tsx`, `src/server/commerce` repo
- Depends on: `trackc-register-storefront-components-as-bindable-blocks`, `slice2-publish-read-binding-hydration`
