// The editor's commerce provider holds a cart, so the add-to-cart, cart and
// checkout blocks render on the canvas (they threw "useCart must be used within
// a CartProvider" and took the whole editor down on a product page). Each
// project keeps its own cart: every project is edited on the same host.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, act, waitFor } from '@testing-library/react';
import { useCart, editorCartStorageKey, CART_STORAGE_KEY } from '@/lib/commerce/cart';

let currentProject: { id: string } | null = { id: 'project-a' };
vi.mock('@/hooks/useStore', () => ({
  useStore: () => ({ editorUI: { currentProject } }),
}));

import EditorCommerceProvider from '../EditorCommerceProvider';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  currentProject = { id: 'project-a' };
});

function CartProbe() {
  const cart = useCart();
  return (
    <div>
      <span data-testid="lines">{cart.lines.map((l) => `${l.variantId}x${l.quantity}`).join(',') || 'empty'}</span>
      <button type="button" onClick={() => cart.add('var_ring', 1)}>
        add
      </button>
    </div>
  );
}

describe('EditorCommerceProvider', () => {
  it('gives the canvas a cart that persists under the project, never under the published-site key', async () => {
    render(
      <EditorCommerceProvider>
        <CartProbe />
      </EditorCommerceProvider>,
    );
    expect(screen.getByTestId('lines').textContent).toBe('empty');
    act(() => screen.getByText('add').click());
    expect(screen.getByTestId('lines').textContent).toBe('var_ringx1');
    expect(JSON.parse(window.localStorage.getItem(editorCartStorageKey('project-a'))!)).toEqual([
      { variantId: 'var_ring', quantity: 1 },
    ]);
    expect(window.localStorage.getItem(CART_STORAGE_KEY)).toBeNull();
  });

  it("does not show one project's cart in another project", async () => {
    window.localStorage.setItem(editorCartStorageKey('project-a'), JSON.stringify([{ variantId: 'var_a', quantity: 2 }]));
    const { rerender } = render(
      <EditorCommerceProvider>
        <CartProbe />
      </EditorCommerceProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('lines').textContent).toBe('var_ax2'));

    currentProject = { id: 'project-b' };
    rerender(
      <EditorCommerceProvider>
        <CartProbe />
      </EditorCommerceProvider>,
    );
    expect(screen.getByTestId('lines').textContent).toBe('empty');
    act(() => screen.getByText('add').click());
    expect(JSON.parse(window.localStorage.getItem(editorCartStorageKey('project-b'))!)).toEqual([
      { variantId: 'var_ring', quantity: 1 },
    ]);
    expect(JSON.parse(window.localStorage.getItem(editorCartStorageKey('project-a'))!)).toEqual([
      { variantId: 'var_a', quantity: 2 },
    ]);
  });
});
