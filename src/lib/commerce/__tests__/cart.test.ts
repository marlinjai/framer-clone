// Client cart store: persistence, the DISPLAY-ONLY subtotal, and the hard
// guarantees that no money is authored and no server write happens client-side.
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import {
  CartProvider,
  useCart,
  computeDisplaySubtotalCents,
  CART_STORAGE_KEY,
  MAX_LINE_QUANTITY,
  cartLineQuantity,
  type CartLine,
} from '@/lib/commerce/cart';
import type { PriceDTO } from '@/lib/commerce/types';

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(CartProvider, null, children);

const price = (variantId: string, amountCents: number): PriceDTO => ({
  variantId,
  amountCents,
  currency: 'eur',
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('computeDisplaySubtotalCents (DISPLAY ONLY, never authoritative)', () => {
  it('returns 0 for an empty cart', () => {
    expect(computeDisplaySubtotalCents([], {})).toBe(0);
  });

  it('sums integer cents * quantity and stays an exact integer (no float money)', () => {
    const lines: CartLine[] = [
      { variantId: 'a', quantity: 3 },
      { variantId: 'b', quantity: 2 },
    ];
    const prices = { a: price('a', 2500), b: price('b', 2700) };
    const subtotal = computeDisplaySubtotalCents(lines, prices);
    expect(subtotal).toBe(2500 * 3 + 2700 * 2);
    expect(Number.isInteger(subtotal)).toBe(true);
  });

  it('contributes nothing for a line with no resolved price (never fabricates money)', () => {
    const lines: CartLine[] = [
      { variantId: 'a', quantity: 3 },
      { variantId: 'missing', quantity: 9 },
    ];
    const prices = { a: price('a', 1000) };
    // The unpriced line adds 0: the client never invents an amount.
    expect(computeDisplaySubtotalCents(lines, prices)).toBe(3000);
  });

  it('documents (in source) that the figure is never authoritative', () => {
    const src = readFileSync(path.resolve(__dirname, '../cart.tsx'), 'utf8');
    expect(src).toMatch(/NEVER AUTHORITATIVE/);
    expect(src).toMatch(/order-create/);
  });
});

describe('useCart store', () => {
  it('throws when used outside a CartProvider (fails loudly)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderHook(() => useCart())).toThrow(
      /useCart must be used within a CartProvider/,
    );
  });

  it('adds a line and merges a repeat add of the same variant', () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => result.current.add('var_s_red', 2));
    expect(result.current.lines).toEqual([{ variantId: 'var_s_red', quantity: 2 }]);
    act(() => result.current.add('var_s_red', 3));
    expect(result.current.lines).toEqual([{ variantId: 'var_s_red', quantity: 5 }]);
  });

  it('sets an absolute quantity and removes a line set to zero', () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => result.current.add('v', 2));
    act(() => result.current.setQuantity('v', 4));
    expect(result.current.lines).toEqual([{ variantId: 'v', quantity: 4 }]);
    act(() => result.current.setQuantity('v', 0));
    expect(result.current.lines).toEqual([]);
  });

  it('removes a line and clears the cart', () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.add('a', 1);
      result.current.add('b', 1);
    });
    act(() => result.current.remove('a'));
    expect(result.current.lines).toEqual([{ variantId: 'b', quantity: 1 }]);
    act(() => result.current.clear());
    expect(result.current.lines).toEqual([]);
  });
});

describe('persistence (survives reload)', () => {
  it('persists lines to localStorage and re-hydrates them on a fresh provider', async () => {
    const first = renderHook(() => useCart(), { wrapper });
    act(() => first.result.current.add('var_s_red', 2));

    await waitFor(() => {
      expect(window.localStorage.getItem(CART_STORAGE_KEY)).toContain('var_s_red');
    });
    expect(JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)).toEqual([
      { variantId: 'var_s_red', quantity: 2 },
    ]);

    first.unmount();

    // "Reload": a brand-new provider hydrates from the same localStorage.
    const second = renderHook(() => useCart(), { wrapper });
    await waitFor(() => {
      expect(second.result.current.lines).toEqual([{ variantId: 'var_s_red', quantity: 2 }]);
    });
  });

  it('persists an emptied cart (clear writes [])', async () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => result.current.add('v', 1));
    act(() => result.current.clear());
    await waitFor(() => {
      expect(window.localStorage.getItem(CART_STORAGE_KEY)).toBe('[]');
    });
  });

  it('recovers from corrupt localStorage by starting empty (loud, not silent)', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, '{ this is not json');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => {
      expect(errSpy).toHaveBeenCalled();
    });
    expect(result.current.lines).toEqual([]);
  });
});

describe('no server write (cart interactions are client-only)', () => {
  it('never calls fetch for any add / setQuantity / remove / clear', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({} as Response);
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => {
      result.current.add('v', 1);
      result.current.setQuantity('v', 3);
      result.current.remove('v');
      result.current.clear();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the quantity of a cart line, as the order route can store it', () => {
  it('is the INTEGER ceiling of order_line_item.quantity', () => {
    expect(MAX_LINE_QUANTITY).toBe(2 ** 31 - 1);
  });

  it('reads a number the way a number field gives it: exponents, decimals, a huge value', () => {
    expect(cartLineQuantity('1e3')).toBe(1000);
    expect(cartLineQuantity('2.7')).toBe(2);
    expect(cartLineQuantity('0.5')).toBe(1);
    expect(cartLineQuantity('-3')).toBe(1);
    expect(cartLineQuantity('1e30')).toBe(MAX_LINE_QUANTITY);
    expect(cartLineQuantity('99999999999')).toBe(MAX_LINE_QUANTITY);
    expect(cartLineQuantity(' 4 ')).toBe(4);
  });

  it('is nothing for a blank, a word or an overflow to Infinity, so the caller keeps what it had', () => {
    for (const value of ['', '   ', '-', 'abc', '1e999', Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(cartLineQuantity(value)).toBeNull();
    }
  });

  it('caps an add, a merged add and a set quantity, and stores no NaN', () => {
    const { result } = renderHook(() => useCart(), { wrapper });
    act(() => result.current.add('v', MAX_LINE_QUANTITY - 1));
    act(() => result.current.add('v', 5));
    expect(result.current.lines).toEqual([{ variantId: 'v', quantity: MAX_LINE_QUANTITY }]);
    act(() => result.current.setQuantity('v', 3));
    act(() => result.current.setQuantity('v', 1e20));
    expect(result.current.lines).toEqual([{ variantId: 'v', quantity: MAX_LINE_QUANTITY }]);
    act(() => result.current.setQuantity('v', Number.NaN));
    act(() => result.current.add('w', Number.NaN));
    expect(result.current.lines).toEqual([{ variantId: 'v', quantity: MAX_LINE_QUANTITY }]);
  });

  it('caps a stored line read back from localStorage', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'v', quantity: 1e15 }]));
    const { result } = renderHook(() => useCart(), { wrapper });
    await waitFor(() => expect(result.current.lines).toEqual([{ variantId: 'v', quantity: MAX_LINE_QUANTITY }]));
  });
});
