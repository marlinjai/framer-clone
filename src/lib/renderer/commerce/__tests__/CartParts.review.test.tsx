// The review findings on the designable cart (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 2): a line no longer sold keeps its remove button in sight whatever the
// design says (G), a legacy binding on a control that already has parts moves to
// its part (J), and a designer's id on a part inside a repeated line goes, so it
// never repeats on the page (K).
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { CART_STORAGE_KEY, CartProvider, useCart } from '@/lib/commerce/cart';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';
import { normalizeShopControl, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';
import CartView from '../CartView';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);

function designed(tree: ShopTreeNode, edits: Record<string, (props: Record<string, unknown>) => Record<string, unknown>>): ShopTreeNode {
  const role = shopPartRoleOf(tree.props);
  const props = role && edits[role] ? edits[role]({ ...tree.props }) : tree.props;
  return { ...tree, props, children: tree.children?.map((child) => designed(child, edits)) };
}

const cart = (): ShopTreeNode => ({ id: 'c', type: 'div', props: { 'data-component-kind': 'cart-view' } });

function renderCart(node: ShopTreeNode, lines: { variantId: string; quantity: number }[]) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
  const Probe = () => <span data-testid="lines">{JSON.stringify(useCart().lines)}</span>;
  return render(
    <CommerceDataSourceContext.Provider value={new InMemoryCommerceDataSource()}>
      <ShopLocaleContext.Provider value="de">
        <CartProvider>
          <CartView node={node as unknown as ComponentInstance} scope={createScope()} />
          <Probe />
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>,
  );
}

describe('G: the remove button of a line no longer sold', () => {
  const hiddenRemove = designed(normalizeShopControl(cart(), 'de', 'node'), {
    'cart.line-remove': (props) => ({ ...props, hidden: true, style: { display: 'none', opacity: 0, visibility: 'hidden' } }),
  });

  it('stays in sight and removes the line, whatever the design says', async () => {
    const { container, getByTestId } = renderCart(hiddenRemove, [{ variantId: 'var_gone', quantity: 1 }]);
    await waitFor(() => expect(container.querySelector('[data-cart-line-unavailable]')).not.toBeNull());
    const remove = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_gone"]')!;
    expect(remove.hidden).toBe(false);
    expect(getComputedStyle(remove).display).not.toBe('none');
    expect(getComputedStyle(remove).visibility).toBe('visible');
    expect(getComputedStyle(remove).opacity).toBe('1');
    act(() => {
      fireEvent.click(remove);
    });
    await waitFor(() => expect(getByTestId('lines').textContent).toBe('[]'));
  });

  it('on a line that is sold, stays as the designer styled it', async () => {
    const { container } = renderCart(hiddenRemove, [{ variantId: 'var_s_red', quantity: 1 }]);
    await waitFor(() => expect(container.querySelector('[data-cart-line="var_s_red"] [data-cart-line-title]')).not.toBeNull());
    const remove = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_s_red"]')!;
    expect(getComputedStyle(remove).display).toBe('none');
  });
});

describe('J: a legacy binding on a control that already has parts', () => {
  const binding = { mode: 'read', expression: '{{site.emptyCart}}' };

  it('moves to its part instead of being dropped', () => {
    const withParts = normalizeShopControl(cart(), 'de', 'node');
    const next = normalizeShopControl({ ...withParts, bindings: { emptyContent: binding } }, 'de', 'node');
    expect(next.bindings).toEqual({});
    expect(byRole(next.children!, 'cart.empty')?.bindings).toEqual({ children: binding });
    // Normalising again changes nothing.
    expect(normalizeShopControl(next, 'de', 'node')).toBe(next);
  });

  it("leaves the part's own binding alone", () => {
    const own = { mode: 'read', expression: '{{site.mine}}' };
    const withParts = normalizeShopControl(cart(), 'de', 'node');
    const bound = { ...withParts, children: withParts.children!.map((child) => (shopPartRoleOf(child.props) === 'cart.empty' ? { ...child, bindings: { children: own } } : child)) };
    const next = normalizeShopControl({ ...bound, bindings: { emptyContent: binding } }, 'de', 'node');
    expect(byRole(next.children!, 'cart.empty')?.bindings).toEqual({ children: own });
    expect(next.bindings).toEqual({});
  });

  it('moves to a required part that comes back in the same pass', () => {
    const withParts = normalizeShopControl(cart(), 'de', 'node');
    const withoutEmpty = { ...withParts, children: withParts.children!.filter((child) => shopPartRoleOf(child.props) !== 'cart.empty') };
    const next = normalizeShopControl({ ...withoutEmpty, bindings: { emptyContent: binding } }, 'de', 'node');
    expect(byRole(next.children!, 'cart.empty')?.bindings).toEqual({ children: binding });
  });
});

describe('K: a designer id on a part inside a repeated line', () => {
  it('goes from the line and every part nested in it, and from nothing outside', () => {
    const tree = designed(normalizeShopControl(cart(), 'de', 'node'), {
      'cart.line': (props) => ({ ...props, id: 'line' }),
      'cart.line-title': (props) => ({ ...props, id: 'title' }),
      'cart.line-qty-input': (props) => ({ ...props, id: 'qty' }),
      'cart.empty': (props) => ({ ...props, id: 'empty' }),
    });
    const next = normalizeShopControl(tree, 'de', 'node');
    for (const role of ['cart.line', 'cart.line-title', 'cart.line-qty-input']) expect(byRole(next.children!, role)?.props).not.toHaveProperty('id');
    expect(byRole(next.children!, 'cart.empty')?.props?.id).toBe('empty');
  });

  it('never repeats on the page across line copies', async () => {
    const tree = designed(normalizeShopControl(cart(), 'de', 'node'), { 'cart.line-title': (props) => ({ ...props, id: 'title' }) });
    const { container } = renderCart(normalizeShopControl(tree, 'de', 'node'), [
      { variantId: 'var_s_red', quantity: 1 },
      { variantId: 'var_s_blue', quantity: 1 },
    ]);
    await waitFor(() => expect(container.querySelectorAll('[data-cart-line-title]').length).toBe(2));
    expect(container.querySelectorAll('#title').length).toBe(0);
  });
});

describe('G: the pinned remove button', () => {
  it('keeps its keyboard focus ring', async () => {
    const { container } = renderCart(normalizeShopControl(cart(), 'de', 'node'), [{ variantId: 'var_gone', quantity: 1 }]);
    await waitFor(() => expect(container.querySelector('[data-cart-line-unavailable]')).not.toBeNull());
    const remove = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_gone"]')!;
    expect(remove.style.getPropertyValue('outline')).toBe('');
    expect(remove.style.getPropertyPriority('visibility')).toBe('important');
  });
});
