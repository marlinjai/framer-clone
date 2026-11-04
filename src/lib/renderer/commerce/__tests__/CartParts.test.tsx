// The add to cart and the cart as designable parts (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 2): their default parts in the site language, the migration of the old
// label and empty message props and bindings, the designer's text reaching the
// live controls, each cart line reading its own line, and the behaviour the
// parts cannot change.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { CART_STORAGE_KEY, CartProvider, useCart } from '@/lib/commerce/cart';
import { SelectedVariantContext, type SelectionState } from '@/lib/commerce/selection';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';
import { buildShopParts, normalizeShopControl, shopPartRoleOf, shopPartText, type ShopTreeNode } from '@/lib/commerce/parts';
import type { CommerceDataSource } from '@/lib/commerce/provider';
import CartView from '../CartView';
import AddToCartButton from '../AddToCartButton';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function flat(nodes: readonly ShopTreeNode[]): ShopTreeNode[] {
  return nodes.flatMap((node) => [node, ...flat(node.children ?? [])]);
}
const byRole = (nodes: readonly ShopTreeNode[], role: string) => flat(nodes).find((node) => shopPartRoleOf(node.props) === role);

/** The tree with `edit` applied to the part of each role named. */
function designed(tree: ShopTreeNode, edits: Record<string, (props: Record<string, unknown>) => Record<string, unknown>>): ShopTreeNode {
  const role = shopPartRoleOf(tree.props);
  const props = role && edits[role] ? edits[role]({ ...tree.props }) : tree.props;
  return { ...tree, props, children: tree.children?.map((child) => designed(child, edits)) };
}

const asNode = (tree: ShopTreeNode) => tree as unknown as ComponentInstance;

describe('default parts and migration', () => {
  it('builds the parts in the site language', () => {
    expect(byRole(buildShopParts('cart-view', 'c', 'de'), 'cart.empty')?.props?.children).toBe('Ihr Warenkorb ist leer');
    expect(byRole(buildShopParts('cart-view', 'c', 'de'), 'cart.line-remove')?.props?.children).toBe('Entfernen');
    expect(byRole(buildShopParts('add-to-cart', 'a', 'de'), 'addToCart.button-label')?.props?.children).toBe('In den Warenkorb');
    expect(byRole(buildShopParts('add-to-cart', 'a', 'en'), 'addToCart.button-soldout')?.props?.children).toBe('Sold out');
  });

  it("moves the add to cart's old label and its binding onto the label part", () => {
    const binding = { mode: 'read', expression: '{{product.title}}' };
    const legacy: ShopTreeNode = { id: 'a', type: 'div', props: { 'data-component-kind': 'add-to-cart', label: 'Kaufen' }, bindings: { label: binding } };
    const next = normalizeShopControl(legacy, 'de', 'snapshot');
    expect(next.props).not.toHaveProperty('label');
    expect(next.bindings).toEqual({});
    const label = byRole(next.children!, 'addToCart.button-label')!;
    expect(label.props?.children).toBe('Kaufen');
    expect(label.bindings).toEqual({ children: binding });
  });

  it("moves the cart's old empty message onto the empty part", () => {
    const legacy: ShopTreeNode = { id: 'c', type: 'div', props: { 'data-component-kind': 'cart-view', emptyContent: 'Noch nichts drin' } };
    const next = normalizeShopControl(legacy, 'de', 'node');
    expect(next.props).not.toHaveProperty('emptyContent');
    expect(byRole(next.children!, 'cart.empty')?.props?.children).toBe('Noch nichts drin');
  });

  it('keeps the estimate notice fixed and the tokens a line and the subtotal need', () => {
    expect(shopPartText('cart.subtotal-note', 'Final price', 'de')).toBe('Nur eine Schätzung. Die Endsumme wird an der Kasse berechnet.');
    expect(shopPartText('cart.subtotal', 'Summe', 'de')).toBe('Zwischensumme (geschätzt): {subtotal}');
    expect(shopPartText('cart.line-price', 'gratis', 'de')).toBe('{price}');
  });
});

function renderCart(node: ComponentInstance, lines: { variantId: string; quantity: number }[]) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
  const Probe = () => <span data-testid="lines">{JSON.stringify(useCart().lines)}</span>;
  return render(
    <CommerceDataSourceContext.Provider value={new InMemoryCommerceDataSource()}>
      <ShopLocaleContext.Provider value="de">
        <CartProvider>
          <CartView node={node} scope={createScope()} />
          <Probe />
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>,
  );
}

describe('a designed cart, live', () => {
  const tree = designed(normalizeShopControl({ id: 'c', type: 'div', props: { 'data-component-kind': 'cart-view' } }, 'de', 'node'), {
    'cart.empty': (props) => ({ ...props, children: 'Hier ist noch nichts' }),
    'cart.line-remove': (props) => ({ ...props, children: 'Löschen', type: 'submit', style: { color: 'rgb(1, 2, 3)' } }),
    'cart.line-qty-text': (props) => ({ ...props, children: 'Anzahl' }),
    'cart.line-title': (props) => ({ ...props, children: 'Artikel: {title}' }),
  });

  it('shows the designed empty message', () => {
    const { container } = renderCart(asNode(tree), []);
    expect(container.querySelector('[data-cart-empty]')?.textContent).toBe('Hier ist noch nichts');
    expect(container.querySelector('[data-cart-subtotal]')).toBeNull();
  });

  it('draws the line template once per line, each reading its own line, with behaviour the parts cannot change', async () => {
    const { container, getByTestId } = renderCart(asNode(tree), [
      { variantId: 'var_s_red', quantity: 2 },
      { variantId: 'var_s_blue', quantity: 1 },
    ]);
    await waitFor(() => {
      expect(container.querySelector('[data-cart-line="var_s_red"] [data-cart-line-title]')?.textContent).toBe('Artikel: Classic Tee, Small / Red');
      expect(container.querySelector('[data-cart-line="var_s_blue"] [data-cart-line-title]')?.textContent).toBe('Artikel: Classic Tee, Small / Blue');
    });
    const remove = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_s_red"]')!;
    expect(remove.textContent).toBe('Löschen');
    expect(remove.type).toBe('button');
    expect(remove.style.color).toBe('rgb(1, 2, 3)');
    expect(container.querySelector('[data-cart-line="var_s_red"]')?.textContent).toContain('Anzahl');
    expect(container.querySelector('[data-cart-subtotal-note]')?.textContent).toBe('Nur eine Schätzung. Die Endsumme wird an der Kasse berechnet.');

    const qty = container.querySelector<HTMLInputElement>('input[data-cart-qty="var_s_red"]')!;
    expect(qty.type).toBe('number');
    // Named by its label text, and its label points at it.
    const qtyLabel = document.getElementById(qty.getAttribute('aria-labelledby')!)!;
    expect(qtyLabel.textContent).toBe('Anzahl');
    expect(qtyLabel.closest('label')?.htmlFor).toBe(qty.id);
    act(() => {
      fireEvent.change(qty, { target: { value: '3' } });
    });
    await waitFor(() => expect(getByTestId('lines').textContent).toContain('"quantity":3'));
    act(() => {
      fireEvent.click(remove);
    });
    await waitFor(() => expect(container.querySelector('[data-cart-line="var_s_red"]')).toBeNull());
    expect(container.querySelector('[data-cart-line="var_s_blue"]')).not.toBeNull();
  });
});

function availabilityDS(quantity: number): CommerceDataSource {
  const ds = new InMemoryCommerceDataSource();
  return {
    ...Object.fromEntries(Object.getOwnPropertyNames(Object.getPrototypeOf(ds)).filter((key) => key !== 'constructor').map((key) => [key, (ds as never)[key]])),
    getAvailability: async (variantId: string) => ({ variantId, locationId: 'all', availableQuantity: quantity, limited: true, stale: false }),
    subscribe: () => () => {},
  } as unknown as CommerceDataSource;
}

function renderAddToCart(node: ComponentInstance, ds: CommerceDataSource) {
  const selection: SelectionState = {
    selection: {},
    variant: { id: 'var_s_red', productId: 'prod_tee', title: 'Small / Red', optionValues: [] } as never,
    setOptionValue: () => {},
  };
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ShopLocaleContext.Provider value="de">
        <CartProvider>
          <SelectedVariantContext.Provider value={selection}>
            <AddToCartButton node={node} scope={createScope()} />
          </SelectedVariantContext.Provider>
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>,
  );
}

describe('a designed add to cart, live', () => {
  const tree = designed(normalizeShopControl({ id: 'a', type: 'div', props: { 'data-component-kind': 'add-to-cart' } }, 'de', 'node'), {
    'addToCart.button-label': (props) => ({ ...props, children: 'Jetzt in den Korb' }),
    'addToCart.button': (props) => ({ ...props, type: 'submit' }),
  });

  it('shows the designed label and stays a plain button', async () => {
    const { container } = renderAddToCart(asNode(tree), availabilityDS(5));
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]');
      expect(found?.disabled).toBe(false);
      return found!;
    });
    expect(button.textContent).toBe('Jetzt in den Korb');
    expect(button.type).toBe('button');
  });

  it('says sold out in the site language and stays disabled', async () => {
    const { container } = renderAddToCart(asNode(tree), availabilityDS(0));
    await waitFor(() => expect(container.querySelector('button[data-add-to-cart]')?.textContent).toBe('Ausverkauft'));
    expect((container.querySelector('button[data-add-to-cart]') as HTMLButtonElement).disabled).toBe(true);
  });
});
