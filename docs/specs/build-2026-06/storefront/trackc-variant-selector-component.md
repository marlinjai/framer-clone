---
name: trackc-variant-selector-component
track: storefront
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-storefront-product-list-and-detail-renderers]
touchesSharedState: false
sharedState: []
estimateDays: 4
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# VariantSelector component (option-matrix driven, advisory availability, selects active variant frame)

> An interactive storefront component that renders one control per product option, lets the visitor pick a value per option, resolves the matching variant by walking the variant<->option_value matrix (the composite-coordinate match against `ProductVariantDTO.optionValues`), and re-pushes the SELECTED variant into the binding scope so descendant `{{variant.*}}` / `{{availability.*}}` re-resolve. Selection state is CLIENT-SIDE only (React state / a small context), NEVER written to MST and NEVER to the server: ephemeral UI state, not a stock or money fact.

## Goal

Render one control per product option from the `options` DTO; selecting an option_value per option resolves the matching variant via the matrix; re-push the selected variant so sibling/descendant bindings re-resolve. Fetch `getAvailability(variantId)` for the selected variant and surface it ADVISORILY (`In stock` / `Only N left` / `Out of stock`), with the explicit comment that this reflects the advisory poll, NOT permission to sell. Combinations with no matching variant are unselectable.

## Scope

**In:**
- `src/lib/renderer/commerce/VariantSelector.tsx`: one control per option; matrix-lookup variant resolution; re-pushes the selected variant frame.
- `src/lib/commerce/selection.tsx`: `SelectedVariantContext`, `useSelectedVariant()`, `resolveVariantFromSelection(product, variants, selection)` (the matrix walk). Client-only, NOT MST, NOT server.
- Advisory availability text on the selected variant (advisory comment + the reserve-at-checkout-is-the-gate note).
- Disable/grey-out of combinations with no matching variant.

**Out (explicitly deferred):**
- Cart (next spec), checkout (later).
- Any server write or MST write.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/renderer/commerce/VariantSelector.tsx` | new | option controls + matrix resolution + re-push variant |
| `src/lib/commerce/selection.tsx` | new | client-only selection state + matrix walk |
| `src/lib/renderer/commerce/__tests__/VariantSelector.test.tsx` | new | selection -> variant -> re-resolve; unselectable combos; no MST/server write |

## API surface

```ts
function VariantSelector(props: { node; scope }): ReactNode;
export const SelectedVariantContext: React.Context<SelectionState>;
export function useSelectedVariant(): { variant: ProductVariantDTO | null; setOptionValue(optionId: string, valueId: string): void };
export function resolveVariantFromSelection(product: ProductDTO, variants: ProductVariantDTO[], selection: Record<string, string>): ProductVariantDTO | null; // matrix walk
```

## Test plan

- [ ] One control per option; selecting a value updates the resolved variant; descendant `{{variant.*}}` + `{{availability.*}}` re-resolve to the selected variant (2-option/4-variant fixture).
- [ ] An option combination with no matching variant is unselectable (matrix-lookup test).
- [ ] Availability text is advisory + carries the no-sell-permission comment; a test asserts selecting never triggers a write/reserve.
- [ ] `useSelectedVariant()` exposes the selection to add-to-cart.
- [ ] Selection is client-only (no MST write asserted).

## Definition of done

- [ ] VariantSelector renders option controls, resolves the variant via the matrix, re-pushes the variant frame.
- [ ] Unselectable combos; advisory availability + no-sell comment; no MST/server write.
- [ ] `useSelectedVariant()` available to the next spec.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Cross-check doc section 4.4 (advisory availability), 3.3 (the option matrix).
- Depends on: `trackc-storefront-product-list-and-detail-renderers`
