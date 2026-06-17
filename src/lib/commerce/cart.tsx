// Client-side cart state for the storefront.
//
// The cart is VISITOR SELECTION STATE: a list of {variantId, quantity} lines
// held in a small React context and persisted to localStorage so it survives a
// reload. It is EXPLICITLY NOT a server-authoritative cart and NOT a money or
// stock fact: it is a shopping list of intentions. Nothing here is permission
// to sell and nothing here is trusted money.
//
// The authoritative reservation and the authoritative totals are computed
// SERVER-SIDE at order-create (the next spec), inside Track B's atomic
// transaction (cross-check doc section 4.5: money is Layer-B authoritative).
// `computeDisplaySubtotalCents` below produces a DISPLAY-ONLY figure for the
// cart UI; it is never sent to the server and never trusted as the price.
//
// NO SERVER WRITE happens from any cart interaction: add / setQuantity / remove
// / clear are pure client-state mutations plus a localStorage persist. There is
// no fetch, no MST write, no commerce mutation anywhere in this module.
'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { PriceDTO } from './types';

/** The localStorage key the persisted cart lives under (versioned). */
export const CART_STORAGE_KEY = 'framer-clone:cart:v1';

/**
 * One cart line: the visitor wants `quantity` of variant `variantId`. This is
 * selection state only. `quantity` is always a positive integer; a line that
 * would drop to zero is removed rather than stored as a zero-quantity line.
 */
export interface CartLine {
  variantId: string;
  quantity: number;
}

/**
 * The cart store exposed through context. Every mutation is a pure client-state
 * change plus a localStorage persist: there is no server write of any kind.
 */
export interface CartStore {
  /** The current cart lines (selection state). */
  lines: CartLine[];
  /** Add `quantity` of `variantId`, merging into an existing line if present. */
  add(variantId: string, quantity: number): void;
  /** Set the absolute quantity of a line; a quantity <= 0 removes the line. */
  setQuantity(variantId: string, quantity: number): void;
  /** Remove a line entirely. */
  remove(variantId: string): void;
  /** Empty the cart. */
  clear(): void;
}

/**
 * Context carrying the active CartStore. Defaults to null so `useCart` can fail
 * loudly (rather than silently resolve an empty cart) when used outside a
 * CartProvider. Mirrors the SelectedVariantContext / CommerceDataSourceContext
 * loud-failure convention.
 */
export const CartContext = createContext<CartStore | null>(null);
CartContext.displayName = 'CartContext';

/**
 * Read the active CartStore. Throws when used outside a CartProvider: a missing
 * provider is a wiring bug, and failing loudly beats silently dropping every
 * add-to-cart into a throwaway cart.
 */
export function useCart(): CartStore {
  const ctx = useContext(CartContext);
  if (!ctx) {
    throw new Error(
      'useCart must be used within a CartProvider. Wrap your storefront tree ' +
        'with <CartProvider>.',
    );
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// localStorage persistence. Pure helpers, guarded for a server (no `window`)
// environment so the module is import-safe during SSR / static emit.
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary parsed value into a clean CartLine[]. Drops anything that
 * is not a {variantId: non-empty string, quantity: positive integer} entry, so
 * a partially-corrupt payload degrades to the valid subset rather than throwing
 * inside the render path.
 */
function normalizeLines(parsed: unknown): CartLine[] {
  if (!Array.isArray(parsed)) return [];
  const lines: CartLine[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const variantId = (entry as { variantId?: unknown }).variantId;
    const quantity = (entry as { quantity?: unknown }).quantity;
    if (typeof variantId !== 'string' || variantId.length === 0) continue;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) continue;
    lines.push({ variantId, quantity });
  }
  return lines;
}

/** Read the persisted cart, recovering loudly (never silently) from corruption. */
function readStoredLines(): CartLine[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return [];
    return normalizeLines(JSON.parse(raw));
  } catch (err) {
    // Corrupt localStorage must not brick the storefront. Surface to the
    // console (a loud failure, never a silent swallow) and recover empty.
    console.error('CartProvider: failed to read the persisted cart; starting empty.', err);
    return [];
  }
}

/** Persist the cart, surfacing a write failure to the console (never swallowed). */
function writeStoredLines(lines: CartLine[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
  } catch (err) {
    console.error('CartProvider: failed to persist the cart.', err);
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface CartProviderProps {
  children: ReactNode;
}

/**
 * Holds the cart lines in React state, hydrates them from localStorage after
 * mount, and persists every mutation. Hydration runs in an effect (not in the
 * initial render) so SSR and the first client render agree on an empty cart and
 * there is no hydration mismatch; the persisted lines arrive on the next tick.
 */
export function CartProvider({ children }: CartProviderProps) {
  const [lines, setLines] = useState<CartLine[]>([]);

  // A ref mirror of `lines` so a mutation can compute the next state from the
  // current one WITHOUT a side effect inside the state updater and without a
  // stale closure. Kept in sync on every render.
  const linesRef = useRef<CartLine[]>(lines);
  linesRef.current = lines;

  // Hydrate once from localStorage after mount. A persisted non-empty cart
  // replaces the empty initial state on the next tick.
  useEffect(() => {
    const stored = readStoredLines();
    if (stored.length > 0) setLines(stored);
  }, []);

  // Apply a pure transform to the current lines, then persist the result. The
  // localStorage write is the ONLY effect: no fetch, no server write.
  const mutate = useCallback((fn: (prev: CartLine[]) => CartLine[]) => {
    const next = fn(linesRef.current);
    linesRef.current = next;
    setLines(next);
    writeStoredLines(next);
  }, []);

  const add = useCallback(
    (variantId: string, quantity: number) => {
      const qty = Math.max(1, Math.floor(quantity));
      mutate((prev) => {
        const existing = prev.find((line) => line.variantId === variantId);
        if (existing) {
          return prev.map((line) =>
            line.variantId === variantId
              ? { variantId, quantity: line.quantity + qty }
              : line,
          );
        }
        return [...prev, { variantId, quantity: qty }];
      });
    },
    [mutate],
  );

  const setQuantity = useCallback(
    (variantId: string, quantity: number) => {
      const qty = Math.floor(quantity);
      mutate((prev) => {
        // A non-positive quantity removes the line (a cart never holds zero of
        // something); an explicit `remove` exists for clarity at the call site.
        if (qty <= 0) return prev.filter((line) => line.variantId !== variantId);
        return prev.map((line) =>
          line.variantId === variantId ? { variantId, quantity: qty } : line,
        );
      });
    },
    [mutate],
  );

  const remove = useCallback(
    (variantId: string) => {
      mutate((prev) => prev.filter((line) => line.variantId !== variantId));
    },
    [mutate],
  );

  const clear = useCallback(() => {
    mutate(() => []);
  }, [mutate]);

  const store = useMemo<CartStore>(
    () => ({ lines, add, setQuantity, remove, clear }),
    [lines, add, setQuantity, remove, clear],
  );

  return <CartContext.Provider value={store}>{children}</CartContext.Provider>;
}

// ---------------------------------------------------------------------------
// Display-only money. NOT AUTHORITATIVE.
// ---------------------------------------------------------------------------

/**
 * Sum a cart's lines into a DISPLAY-ONLY subtotal in integer cents.
 *
 * DISPLAY ONLY, NEVER AUTHORITATIVE. This figure exists purely so the cart UI
 * can show the visitor an estimate. It is NEVER sent to the server and NEVER
 * trusted as the price: the authoritative total is computed server-side at
 * order-create inside Track B's atomic transaction (cross-check doc section
 * 4.5, money is Layer-B authoritative). A client-computed total is an estimate
 * by definition because catalog prices, promotions, tax, and shipping can all
 * change between this read and order-create.
 *
 * Integer-cents math only: `PriceDTO.amountCents` is an integer and `quantity`
 * is an integer, so the product and the running sum stay exact integers (no
 * float money is ever authored). A line whose variant has no resolved display
 * price contributes nothing to the estimate rather than fabricating a zero or a
 * guessed amount.
 */
export function computeDisplaySubtotalCents(
  lines: CartLine[],
  prices: Record<string, PriceDTO>,
): number {
  return lines.reduce((sum, line) => {
    const price = prices[line.variantId];
    if (!price) return sum;
    return sum + price.amountCents * line.quantity;
  }, 0);
}
