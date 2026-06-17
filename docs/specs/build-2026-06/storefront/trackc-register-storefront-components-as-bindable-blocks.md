---
name: trackc-register-storefront-components-as-bindable-blocks
track: storefront
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-storefront-product-list-and-detail-renderers, trackc-variant-selector-component, trackc-client-cart-state-and-cart-view, trackc-order-create-checkout-stop]
touchesSharedState: true
sharedState: [component-registry]
estimateDays: 3
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Register storefront components as bindable canvas blocks (componentRegistry + dataComponentKind dispatch)

> REGISTRY-EDIT FIX (critique minor): the DoD names the TWO mandatory codebase edits the original surface omitted: (1) `ComponentCategory` is a CLOSED union `'basic' | 'layout' | 'data'` at `src/lib/componentRegistry.ts:31`, so adding `'commerce'` REQUIRES extending that union or tsc fails; (2) `src/components/sidebars/left/ComponentsPanel.tsx` enumerates categories by HARD-CODED literals (`listComponentsByCategory('basic'/'layout'/'data')` at lines 36-38), so a new category needs a new `listComponentsByCategory('commerce')` call + section. Both are required for the category to compile and render. PUBLISH NOTE: per the brief's "publish" instruction and the package-naming standard, the storefront components are published as `@marlinjai/*` canvas blocks if/when they stabilize; v1 keeps them in-repo.

## Goal

Register the storefront components (ProductList/Grid, ProductDetail, VariantSelector, AddToCart, CartView, CheckoutButton) in `src/lib/componentRegistry.ts` as draggable, bindable canvas blocks under a new `'commerce'` category, mirroring the CMS `collection`/`recordView`/`tableView` entries. Extend `createComponentElement`'s `dataComponentKind` dispatch to route the new commerce kinds to the Track C renderers. Mount the `CommerceDataSourceContext.Provider` (HTTP provider) at the same two root mount points as the CMS provider, alongside it.

## Scope

**In:**
- `src/lib/componentRegistry.ts`: extend the `ComponentCategory` union with `'commerce'`; add six entries (category `'commerce'`) with `bindableSlots` (ProductList: `products` slot scopeHint commerce-collection analog; ProductDetail: `product` slot scopeHint `'product'`; descendants bind `{{product.*}}`/`{{variant.*}}`/`{{availability.*}}`), a `dataComponentKind` extended union, and a `data-component-kind` HTML attribute marker. `getBindableSlotsFor` returns them.
- `DataComponentKind` union extended: `... | 'product-list' | 'product-detail' | 'variant-selector' | 'add-to-cart' | 'cart-view' | 'checkout-button'`.
- `src/lib/renderer/createComponentElement.tsx`: dispatch the commerce kinds to the Track C renderers; the dashed-box placeholder only when a commerce node is UNBOUND.
- `src/components/sidebars/left/ComponentsPanel.tsx`: add a `listComponentsByCategory('commerce')` call + a commerce section (so the category renders).
- `src/components/EditorApp.tsx` + `src/components/preview/PreviewShell.tsx`: mount `CommerceDataSourceContext.Provider` (HTTP) alongside `DataSourceProviderContext.Provider` (the `value={getSharedInMemoryDataSourceProvider()}` symbol-anchor site, one per file); keep the in-memory commerce double for tests.

**Out (explicitly deferred):**
- Publishing the components as `@marlinjai/*` packages (only if/when they stabilize).
- Any binding-picker change beyond the new `scopeHint` values it already tolerates (Track A picker default-branches on unknown hints).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/componentRegistry.ts` | edit | extend ComponentCategory union (+`'commerce'`); extend DataComponentKind; add 6 entries. `component-registry` shared-state |
| `src/lib/renderer/createComponentElement.tsx` | edit | dispatch the 6 commerce kinds to Track C renderers |
| `src/components/sidebars/left/ComponentsPanel.tsx` | edit | add listComponentsByCategory('commerce') + section |
| `src/components/EditorApp.tsx` | edit | mount CommerceDataSourceContext.Provider (symbol anchor) |
| `src/components/preview/PreviewShell.tsx` | edit | same |
| `src/lib/__tests__/componentRegistry.commerce.test.ts` | new | 6 entries, bindableSlots, getBindableSlotsFor |

## API surface

```ts
// src/lib/componentRegistry.ts
export type ComponentCategory = 'basic' | 'layout' | 'data' | 'commerce'; // EXTENDED (was closed at :31)
// DataComponentKind extended: ... | 'product-list' | 'product-detail' | 'variant-selector' | 'add-to-cart' | 'cart-view' | 'checkout-button'
// six new COMPONENT_REGISTRY entries, category: 'commerce', each with bindableSlots + dataComponentKind + 'data-component-kind' attr
```

## Test plan

- [ ] Six commerce entries land under category `'commerce'` with `bindableSlots`, `dataComponentKind`, the `data-component-kind` attribute; `getBindableSlotsFor` returns them.
- [ ] `DataComponentKind` union extended with the six commerce kinds.
- [ ] `createComponentElement` dispatches the commerce kinds to the Track C renderers; dashed-box only when a commerce node is unbound.
- [ ] `ComponentsPanel` surfaces the commerce category (new `listComponentsByCategory('commerce')` section).
- [ ] `CommerceDataSourceContext.Provider` (HTTP) mounted in EditorApp + PreviewShell alongside the CMS provider (symbol-anchor edit, one site per file).
- [ ] A bound ProductList drag-drop renders the live fixture catalog.

## Definition of done

- [ ] `ComponentCategory` union extended with `'commerce'` (tsc green); the panel renders the commerce section.
- [ ] Six entries + dispatch + provider mounts land; bound ProductList renders the fixture.
- [ ] Headless-safe (invariant, Track 0): mounting the HTTP `CommerceDataSourceContext.Provider` reaches the Prisma singleton only at request time via `/api/commerce` (lazy connect on first query), so `next build` needs NO live `DATABASE_URL`. The verify command carries a throwaway placeholder `DATABASE_URL` (belt-and-suspenders, uniform with the CMS + b-chain), so headless-safety holds even if a future edit pulls a server module onto the build path.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Critique (minor, fixed): ComponentCategory closed union at componentRegistry.ts:31 + hard-coded panel literals at ComponentsPanel.tsx:36-38 must both be edited.
- Code touchpoints: `src/lib/componentRegistry.ts:31` (ComponentCategory), `src/components/sidebars/left/ComponentsPanel.tsx:36-38`, `createComponentElement.tsx` (dataComponentKind dispatch), `EditorApp.tsx:114` / `preview/PreviewShell.tsx:97` (provider mounts)
- Depends on: the four renderer/component specs.
