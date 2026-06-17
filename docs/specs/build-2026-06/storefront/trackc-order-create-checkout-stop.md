---
name: trackc-order-create-checkout-stop
track: storefront
wave: 2
priority: P1
status: draft
targetRepo: /Users/marlinjai/software-dev/ERP-suite/projects/framer-clone
dependsOn: [trackc-client-cart-state-and-cart-view, b6-minimal-orders, b3-guarded-reservation, slice2-admin-guard-stub]
touchesSharedState: false
sharedState: []
estimateDays: 5
verify: pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint
owner: unassigned
---

# Order-create call into the Track B atomic write path (checkout STOPS at order-created, payment deferred)

> DEPENDENCY-ID FIX (critique major): depends on the REAL Track B ids `b6-minimal-orders` (the atomic `createOrder`) and `b3-guarded-reservation` (the guarded `reserve`), plus `slice2-admin-guard-stub` for the mutation-route guard seam. The single write seam from the storefront into the server-authoritative commerce engine. checkout STOPS at order-created: NO payment provider, NO Stripe, NO redirect to pay (E8).

## Goal

A `CheckoutButton` that posts the client cart ({variantId, quantity} lines) to `POST /api/commerce/orders`, which calls Track B's atomic `createOrder` (b6). The client sends INTENTIONS only (variant ids + quantities, NEVER a price or stock number); the server computes authoritative integer-cents totals/tax, runs the guarded conditional decrement (b3 `reserve` inside a real `prisma.$transaction` with the 3 stacked guards), and returns order-created OR typed per-line shortages. On success the cart clears + an order-confirmation shows; on a shortage the response surfaces the per-line shortage, the cart is NOT silently cleared, and the visitor sees which lines failed + the next action.

## Scope

**In:**
- `src/app/api/commerce/orders/route.ts` (POST): the ONLY storefront-side write. Imports Track B's `createOrder` (b6) + reserve (b3) and runs them inside the atomic `$transaction` (NOT `adapter.transaction()`, the verified no-op). Server computes totals/tax authoritatively (request body has NO price/stock fields, asserted). Guarded by the `slice2-admin-guard-stub` `can()`-shaped guard seam (one constant tenant) so the auth-brain swap later is an adapter change. NOTE: this POST mutation route lives in the storefront track because it is the storefront write seam; b7 explicitly deferred the order-mutation route to here.
- `src/lib/renderer/commerce/CheckoutButton.tsx`: posts `useCart()` lines, STOPS at order-created; clears cart + shows confirmation on success; surfaces per-line shortages + next action on 409 (cart NOT cleared).

**Out (explicitly deferred):**
- Payment / Stripe / pay-redirect (E8).
- Tax-engine call, invoice rendering (E8).

## Files and changes

| Path | Change | Notes |
|------|--------|-------|
| `src/app/api/commerce/orders/route.ts` | new | POST, guarded, calls b6 createOrder; the storefront write seam |
| `src/lib/renderer/commerce/CheckoutButton.tsx` | new | posts cart lines, stops at order-created |
| `src/app/api/commerce/orders/__tests__/route.itest.ts` | new (integration) | server totals, oversell rejection, no client price/stock |
| `src/lib/renderer/commerce/__tests__/CheckoutButton.test.tsx` | new | success clears cart; shortage keeps cart + shows failing lines |

## API surface

```ts
// POST /api/commerce/orders
//   body: { lines: { variantId: string; quantity: number }[] }   // intentions only, NO price/stock from client
//   -> 201 { orderId: string; totalCents: number; currency: string }   // server-authoritative total
//   -> 409 { ok: false; shortages: { variantId; needed; available }[] } // guarded reserve rejected
function CheckoutButton(props: { node; scope }): ReactNode; // posts useCart() lines, STOPS at order-created
// guard stub (one constant tenant, can()-shaped) wraps the mutation route only
```

## Test plan

- [ ] Integration: server computes totals/tax authoritatively; the request body has no price/stock fields (asserted).
- [ ] A successful order returns an order id + server-computed total; the client cart clears + confirmation shows.
- [ ] A simulated oversell returns typed per-line shortages; the cart is NOT cleared; the failing lines + next action show (unhappy-path).
- [ ] NO payment/Stripe code exists (checkout stops at order-created, documented).
- [ ] The mutation route carries the `can()`-shaped guard stub.

## Definition of done

- [ ] `CheckoutButton` posts cart lines; the route runs b6 `createOrder` inside the atomic `$transaction` (NOT adapter.transaction).
- [ ] Server is the sole author of money + stock; client sends only variantId+quantity (asserted).
- [ ] Success clears cart + confirmation; oversell keeps cart + surfaces shortages + next action.
- [ ] No payment/Stripe; the mutation route is guarded.
- [ ] `pnpm test && pnpm build && pnpm exec tsc --noEmit && pnpm lint` green; STATUS row flipped.

## Open questions

- Confirm the order POST route HOME: storefront track (recommended, it is the storefront write seam and b7 deferred it here) vs Track B b6. RECOMMEND storefront, since the route shape (cart intentions -> order) is a storefront concern; b6 owns the `createOrder` function the route calls.

## References

- Cross-check doc section 8.2 (atomic order create), 4.3 (guarded reserve is the sole authority).
- Depends on: `trackc-client-cart-state-and-cart-view`, `b6-minimal-orders`, `b3-guarded-reservation`, `slice2-admin-guard-stub`
