// A designed checkout in the editor's Preview (HeadlessComponentRenderer): the
// parts are drawn by the Preview's own renderer and run live against the cart,
// a part the tree lacks is drawn from its default, and a press says that orders
// are placed on the published site only, without greying the design.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import ComponentModel from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { CART_STORAGE_KEY, CartProvider, CheckoutUnavailableContext } from '@/lib/commerce/cart';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';
import { buildShopParts, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

function checkoutNode(parts: ShopTreeNode[]) {
  return ComponentModel.create({
    id: 'co',
    type: 'div',
    componentType: 'host',
    props: { 'data-component-kind': 'checkout-button' },
    children: parts as never,
  });
}

function renderPreview(node: ReturnType<typeof checkoutNode>) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_a', quantity: 1 }]));
  return render(
    <CheckoutUnavailableContext.Provider value="Orders cannot be placed in the editor preview.">
      <ShopLocaleContext.Provider value="de">
        <CartProvider>
          <HeadlessComponentRenderer component={node} breakpointId={BP} allBreakpoints={ALL_BP} />
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CheckoutUnavailableContext.Provider>,
  );
}

describe('the checkout in the Preview', () => {
  it('draws the designed parts live and says why no order is placed when pressed', async () => {
    const parts = buildShopParts('checkout-button', 'co', 'de').map(function edit(node): ShopTreeNode {
      const children = node.children?.map(edit);
      return shopPartRoleOf(node.props) === 'checkout.button-label' ? { ...node, children, props: { ...node.props, children: 'Bestellen' } } : { ...node, children };
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { container } = renderPreview(checkoutNode(parts));
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-checkout]');
      expect(found?.disabled).toBe(false);
      return found!;
    });
    expect(button.textContent).toBe('Bestellen');
    // Only one step shows at a time.
    expect(container.querySelector('[data-checkout-payment]')).toBeNull();
    act(() => fireEvent.click(button));
    expect(container.querySelector('[data-checkout-unavailable]')?.textContent).toMatch(/editor preview/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('draws a required part the tree lacks from its default', async () => {
    const parts = buildShopParts('checkout-button', 'co', 'de').filter((node) => shopPartRoleOf(node.props) !== 'checkout.button');
    const { container } = renderPreview(checkoutNode(parts));
    await waitFor(() => expect(container.querySelector('button[data-checkout]')?.textContent).toBe('Zur Kasse'));
    expect(container.querySelectorAll('button[data-checkout]')).toHaveLength(1);
  });
});
