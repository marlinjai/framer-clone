---
name: trackc-commerce-binding-scope-frame-and-resolver
track: storefront
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-commerce-data-source-seam-and-dtos, slice2-read-binding-resolver-runtime]
touchesSharedState: true
sharedState: [binding-types]
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Commerce scope frames + resolver extension (productId/variantId scope, advisory availability binding)

> DEPENDENCY-ID FIX (critique major): depends on `slice2-read-binding-resolver-runtime` (the real Track A resolver spec id), NOT `trackc-cms-resolver-runtime`. SHARED-STATE FIX (critique minor): this spec EDITS `src/lib/bindings/types.ts` (the shared `BindableSlotMeta.scopeHint` union consumed by the Track A binding picker), so `touchesSharedState: true` with `sharedState: [binding-types]`. The edit is additive and serial (after the CMS resolver lands), and the Track A picker must default/`any`-branch on unknown scopeHint values (enforced in `slice2-editor-binding-picker`). PRICE-ROOT FIX (critique minor): there is NO standalone `price.*` lookup root and NO `pushPriceFrame`; price is resolved as `variant.price.*` inside the variant frame (`pushVariantFrame` takes an optional `price`). The `scopeHint` union adds exactly `'product' | 'variant' | 'availability'` (no `'price'`).

## Goal

Extend the Track A React-free resolver with commerce scope frames so storefront components resolve `{{product.title}}`, `{{variant.sku}}`, `{{variant.price}}`, `{{availability.quantity}}` through the SAME mustache parser + scope chain + `applyBindings` machinery, against the typed commerce DTOs. The resolver stays PURE, provider-free, React-free (Node-evaluable for the publish path). Resolution NEVER throws on a miss.

## Scope

**In:**
- `src/lib/bindings/resolver/scope.ts` (extend): `pushProductFrame(scope, product)`, `pushVariantFrame(scope, variant, price?)`, `pushAvailabilityFrame(scope, availability)` (parallel to `pushRowFrame`/`pushCollectionFrame`).
- Teach `lookup` the roots `product.*`, `variant.*` (including `variant.price.*` resolved from the optional price folded into the variant frame), `availability.*`. NO standalone `price.*` root.
- `src/lib/bindings/types.ts` (edit): extend `BindableSlotMeta.scopeHint` union with `'product' | 'variant' | 'availability'` (additive). The `availability.*` frame is read-only advisory; resolving it carries the display-only / no-sell-permission comment.

**Out (explicitly deferred):**
- Renderer wiring (the storefront renderers feed the frames).
- Any standalone price frame/hint.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/bindings/resolver/scope.ts` | edit | add pushProduct/pushVariant(price?)/pushAvailability frames + lookup roots |
| `src/lib/bindings/types.ts` | edit | extend scopeHint union additively. `binding-types` shared-state |
| `src/lib/bindings/resolver/__tests__/commerceScope.test.ts` | new (node project) | product/variant/variant.price/availability resolution |

## API surface

```ts
export function pushProductFrame(scope: BindingScope, product: ProductDTO): BindingScope;
export function pushVariantFrame(scope: BindingScope, variant: ProductVariantDTO, price?: PriceDTO): BindingScope;
export function pushAvailabilityFrame(scope: BindingScope, availability: AvailabilityDTO): BindingScope; // advisory only
// lookup roots added: product.*, variant.* (incl. variant.price.*), availability.*  (NO standalone price.*)
// src/lib/bindings/types.ts:
//   BindableSlotMeta.scopeHint?: 'row' | 'collection' | 'page' | 'product' | 'variant' | 'availability' | 'any'
```

## Test plan

- [ ] `lookup` resolves `product.title`, `variant.sku`, `variant.price` (from the folded price), `availability.quantity` against the innermost matching frame; returns undefined (never throws) on a miss.
- [ ] The resolver still has ZERO React imports (grep/lint, reusing the Track A enforcement).
- [ ] `BindableSlotMeta.scopeHint` union extended with the three commerce hints (no `'price'`).
- [ ] Node-env test asserts identical output (Track A vitest node-env config).

## Definition of done

- [ ] The three frame-push functions land; `lookup` resolves the three roots (price via the variant frame).
- [ ] No React import in the resolver.
- [ ] `scopeHint` union extended additively; the Track A picker tolerates the new values (enforced in `slice2-editor-binding-picker`).
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Critique (minors, fixed): no standalone price root (resolve as variant.price); types.ts edit flagged touchesSharedState; picker tolerates unknown scopeHint.
- Code touchpoints: `src/lib/bindings/resolver/scope.ts`, `src/lib/bindings/types.ts` (BindableSlotMeta)
- Depends on: `trackc-commerce-data-source-seam-and-dtos` (DTOs), `slice2-read-binding-resolver-runtime` (the resolver to extend)
