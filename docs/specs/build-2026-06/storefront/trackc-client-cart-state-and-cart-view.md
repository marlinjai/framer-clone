---
name: trackc-client-cart-state-and-cart-view
track: storefront
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-variant-selector-component]
touchesSharedState: false
sharedState: []
estimateDays: 5
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Client-side cart state + AddToCart + CartView components (selection only, no server cart, no money authored)

> A CLIENT-SIDE cart: cart contents are visitor selection state (a list of {variantId, quantity} lines), held in a React context / small store, persisted to localStorage. Explicitly NOT a server-authoritative cart and NOT a money/stock fact: the cart is a shopping list of intentions; the authoritative reservation + totals happen only at order-create (next spec) inside Track B's atomic transaction.

## Goal

A localStorage-backed client cart, an `AddToCartButton` (reads `useSelectedVariant()`), and a `CartView` (renders lines, resolves variant + price DTOs for DISPLAY, computes a DISPLAY-ONLY integer-cents subtotal clearly labelled an estimate). The display subtotal carries a hard comment: the authoritative total is computed server-side at order-create, never trusted from the client. No money is authored client-side.

## Scope

**In:**
- `src/lib/commerce/cart.tsx`: `CartContext`, `useCart()` (lines {variantId, quantity}; add/setQuantity/remove/clear; localStorage-backed). `computeDisplaySubtotalCents(lines, prices)` (DISPLAY ONLY, never authoritative).
- `src/lib/renderer/commerce/AddToCartButton.tsx`: reads `useSelectedVariant()`; adds selected variant + quantity; disabled when no variant selected or advisory availability shows zero (the disable is a UX hint, NOT the authority).
- `src/lib/renderer/commerce/CartView.tsx`: renders lines, each line resolves variant + price DTOs for display, computes the display-only subtotal labelled estimate, quantity change / line removal, an advisory-availability warning on a line whose availability dropped (not auto-removed).
- All three route through `resolveDataState` for the per-line variant/price fetch.

**Out (explicitly deferred):**
- Checkout / order-create (next spec), payment (E8).
- Any server cart or server write.

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/lib/commerce/cart.tsx` | new | client cart store, localStorage, display subtotal |
| `src/lib/renderer/commerce/AddToCartButton.tsx` | new | adds selected variant; UX-hint disable |
| `src/lib/renderer/commerce/CartView.tsx` | new | lines + display subtotal + advisory warning |
| `src/lib/commerce/__tests__/cart.test.ts` | new | persistence, display subtotal, no money authored |
| `src/lib/renderer/commerce/__tests__/*.test.tsx` | new | AddToCart disable, CartView display |

## API surface

```ts
export interface CartLine { variantId: string; quantity: number }
export const CartContext: React.Context<CartStore>;
export function useCart(): { lines: CartLine[]; add(variantId: string, qty: number): void; setQuantity(variantId: string, qty: number): void; remove(variantId: string): void; clear(): void };
export function computeDisplaySubtotalCents(lines: CartLine[], prices: Record<string, PriceDTO>): number; // DISPLAY ONLY, never authoritative
function AddToCartButton(props: { node; scope }): ReactNode;
function CartView(props: { node; scope }): ReactNode;
```

## Test plan

- [ ] Cart holds {variantId, quantity} lines, persists to localStorage, survives reload.
- [ ] `AddToCartButton` adds the selected variant; disabled with no selection / advisory-zero availability (UX-hint comment + test).
- [ ] `CartView` renders lines, fetches variant+price DTOs for display, computes a DISPLAY-ONLY integer-cents subtotal labelled estimate (not-authoritative comment + a test that no money is authored client-side).
- [ ] Quantity change + line removal work; an advisory-availability warning shows on a line whose availability dropped.
- [ ] No server write happens from any cart interaction (asserted).

## Definition of done

- [ ] Cart state persists to localStorage; AddToCart disable is a UX hint; CartView display subtotal is labelled estimate with the not-authoritative comment.
- [ ] No money authored client-side; no server write from cart interactions.
- [ ] All three route through `resolveDataState`.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- None blocking.

## References

- Cross-check doc section 4.5 (money is Layer-B authoritative, computed server-side).
- Depends on: `trackc-variant-selector-component`
