// Commerce islands on a published page: a sized, aria-busy placeholder in the
// server HTML and until mount (never "nothing", never a premature "cart is
// empty"), the island itself after mount, and a visible, recoverable error when
// an island crashes.

import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createScope } from '@/lib/bindings/resolver/scope';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

let cartShouldThrow = false;
vi.mock('@/lib/renderer/commerce/CartView', () => ({
  default: () => {
    if (cartShouldThrow) throw new Error('cart exploded');
    return <span data-testid="cart-view">cart</span>;
  },
}));

import CommerceIsland, { ISLAND_PENDING_SIZE } from '../CommerceIsland';

const node = (kind: string): ComponentNode =>
  ({ id: 'n1', type: 'div', props: { 'data-component-kind': kind, className: 'fc-r-1', style: { padding: '8px' } } }) as ComponentNode;

afterEach(() => {
  cleanup();
  cartShouldThrow = false;
});

describe('CommerceIsland', () => {
  it('server-renders a sized, busy placeholder in the node host element', () => {
    const html = renderToString(<CommerceIsland kind="cart-view" node={node('cart-view')} scope={createScope()} />);
    expect(html).toContain('data-island-pending="cart-view"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="fc-r-1"');
    expect(html).toContain(`min-height:${ISLAND_PENDING_SIZE['cart-view'].minHeight}px`);
    expect(html).toContain('aria-label="Loading your cart"');
    expect(html).not.toContain('cart</span>');
  });

  it('every kind has a non-zero pending size', () => {
    for (const size of Object.values(ISLAND_PENDING_SIZE)) expect(size.minHeight).toBeGreaterThan(0);
  });

  it('shows the island once mounted', async () => {
    render(<CommerceIsland kind="cart-view" node={node('cart-view')} scope={createScope()} />);
    await waitFor(() => expect(screen.getByTestId('cart-view')).toBeTruthy());
    expect(document.querySelector('[data-island-pending]')).toBeNull();
  });

  it('shows a visible error with a retry when the island crashes, and recovers', async () => {
    cartShouldThrow = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<CommerceIsland kind="cart-view" node={node('cart-view')} scope={createScope()} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This part of the shop could not be loaded.');
    expect(document.querySelector('[data-island-error="cart-view"]')?.getAttribute('class')).toBe('fc-r-1');

    cartShouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('cart-view')).toBeTruthy());
    spy.mockRestore();
  });
});
