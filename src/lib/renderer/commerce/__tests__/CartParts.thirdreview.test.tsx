// The third review of the designable add to cart and cart (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 2): the quantity field keeps what is typed while it is edited; a remove
// button kept in sight comes out of an `inert` or `aria-hidden` wrapper and the
// wrapper gets its attribute back after; the focus never falls to the page body
// after a removal; each line's remove button and quantity input are described by
// the line's title; and the published island normalises its control once.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import type { ComponentInstance } from '@/models/ComponentModel';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { CART_STORAGE_KEY, CartProvider, useCart } from '@/lib/commerce/cart';
import { ShopLocaleContext, keepInSightForTest } from '@/lib/commerce/shopRuntime';
import * as parts from '@/lib/commerce/parts';
import { normalizeShopControl, shopPartRoleOf, type ShopTreeNode } from '@/lib/commerce/parts';
import type { CommerceDataSource } from '@/lib/commerce/provider';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import CommerceIsland from '@/lib/renderer/server/CommerceIsland';
import CartView from '../CartView';

vi.mock('@/lib/commerce/parts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/commerce/parts')>();
  return { ...actual, normalizeShopControl: vi.fn(actual.normalizeShopControl) };
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.mocked(parts.normalizeShopControl).mockClear();
});

/** The tree with `edit` applied to the part of each role named. */
function designed(tree: ShopTreeNode, edits: Record<string, (props: Record<string, unknown>) => Record<string, unknown>>): ShopTreeNode {
  const role = shopPartRoleOf(tree.props);
  const props = role && edits[role] ? edits[role]({ ...tree.props }) : tree.props;
  return { ...tree, props, children: tree.children?.map((child) => designed(child, edits)) };
}

const cartControl = (): ShopTreeNode => ({ id: 'c', type: 'div', componentType: 'host', props: { 'data-component-kind': 'cart-view' } });

function renderCart(node: ShopTreeNode, lines: { variantId: string; quantity: number }[], options: { ds?: CommerceDataSource; twice?: boolean } = {}) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
  const Probe = () => <span data-testid="lines">{JSON.stringify(useCart().lines)}</span>;
  const cart = (key: string) => <CartView key={key} node={node as unknown as ComponentInstance} scope={createScope()} hostProps={{ 'data-component-kind': 'cart-view', 'data-testid': key }} />;
  return render(
    <CommerceDataSourceContext.Provider value={options.ds ?? new InMemoryCommerceDataSource()}>
      <ShopLocaleContext.Provider value="de">
        <CartProvider>
          {cart('one')}
          {options.twice ? cart('two') : null}
          <Probe />
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>,
  );
}

/** A data source over the in-memory one, with some reads replaced. */
function dataSource(overrides: Partial<CommerceDataSource>): CommerceDataSource {
  const ds = new InMemoryCommerceDataSource();
  const base = Object.fromEntries(
    Object.getOwnPropertyNames(Object.getPrototypeOf(ds))
      .filter((key) => key !== 'constructor')
      .map((key) => [key, ((ds as never)[key] as (...args: unknown[]) => unknown).bind(ds)]),
  );
  return { ...base, subscribe: () => () => {}, ...overrides } as unknown as CommerceDataSource;
}

async function quantityField(container: HTMLElement, id = 'var_s_red') {
  return waitFor(() => {
    const found = container.querySelector<HTMLInputElement>(`input[data-cart-qty="${id}"]`);
    expect(found).not.toBeNull();
    return found!;
  });
}

describe('the quantity field while it is edited', () => {
  it('clearing "2" and typing "5" lands on 5, not 25', async () => {
    const { container, getByTestId } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [{ variantId: 'var_s_red', quantity: 2 }]);
    const qty = await quantityField(container);
    act(() => qty.focus());
    act(() => {
      fireEvent.change(qty, { target: { value: '' } });
    });
    // The field stays blank while the visitor types; the line keeps its quantity.
    expect(qty.value).toBe('');
    expect(getByTestId('lines').textContent).toBe('[{"variantId":"var_s_red","quantity":2}]');
    act(() => {
      fireEvent.change(qty, { target: { value: '5' } });
    });
    await waitFor(() => expect(getByTestId('lines').textContent).toBe('[{"variantId":"var_s_red","quantity":5}]'));
    expect(qty.value).toBe('5');
  });

  it('a blank field left by blur shows the stored quantity again', async () => {
    const { container, getByTestId } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [{ variantId: 'var_s_red', quantity: 2 }]);
    const qty = await quantityField(container);
    act(() => {
      fireEvent.change(qty, { target: { value: '' } });
    });
    expect(qty.value).toBe('');
    act(() => {
      fireEvent.blur(qty);
    });
    expect(qty.value).toBe('2');
    expect(getByTestId('lines').textContent).toBe('[{"variantId":"var_s_red","quantity":2}]');
  });

  it('zero and below give one, and the field shows one after the edit', async () => {
    const { container, getByTestId } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [{ variantId: 'var_s_red', quantity: 3 }]);
    const qty = await quantityField(container);
    for (const typed of ['0', '-4']) {
      act(() => {
        fireEvent.change(qty, { target: { value: '3' } });
      });
      await waitFor(() => expect(getByTestId('lines').textContent).toContain('"quantity":3'));
      act(() => {
        fireEvent.change(qty, { target: { value: typed } });
      });
      await waitFor(() => expect(getByTestId('lines').textContent).toBe('[{"variantId":"var_s_red","quantity":1}]'));
      act(() => {
        fireEvent.blur(qty);
      });
      expect(qty.value).toBe('1');
    }
  });

  it('a quantity changed elsewhere shows in a field that is not being edited', async () => {
    const { container } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [{ variantId: 'var_s_red', quantity: 2 }], { twice: true });
    const one = container.querySelector<HTMLElement>('[data-testid="one"]')!;
    const two = container.querySelector<HTMLElement>('[data-testid="two"]')!;
    const first = await quantityField(one);
    const second = await quantityField(two);
    act(() => {
      fireEvent.change(first, { target: { value: '7' } });
    });
    await waitFor(() => expect(second.value).toBe('7'));
  });
});

describe('a remove button kept in sight inside an inert or aria-hidden wrapper', () => {
  it('lifts both attributes along the chain while it is drawn, and puts them back when it goes', async () => {
    const { container } = render(
      <div data-component-kind="cart-view">
        <div data-testid="outer" aria-hidden="true">
          <div data-testid="inner" inert>
            <button type="button" data-testid="remove">Entfernen</button>
          </div>
        </div>
        <div data-testid="beside" inert aria-hidden="true" />
      </div>,
    );
    const outer = container.querySelector<HTMLElement>('[data-testid="outer"]')!;
    const inner = container.querySelector<HTMLElement>('[data-testid="inner"]')!;
    const beside = container.querySelector<HTMLElement>('[data-testid="beside"]')!;
    const remove = container.querySelector<HTMLElement>('[data-testid="remove"]')!;
    keepInSightForTest(remove);
    expect(outer.hasAttribute('aria-hidden')).toBe(false);
    expect(inner.hasAttribute('inert')).toBe(false);
    // Only the chain up to the control: a sibling keeps its own.
    expect(beside.hasAttribute('inert')).toBe(true);
    expect(beside.getAttribute('aria-hidden')).toBe('true');
    // A second render starts from the design and lifts them again.
    keepInSightForTest(remove);
    expect(outer.hasAttribute('aria-hidden')).toBe(false);
    expect(inner.hasAttribute('inert')).toBe(false);
    const { releaseKeptForTest } = await import('@/lib/commerce/shopRuntime');
    releaseKeptForTest(remove);
    expect(outer.getAttribute('aria-hidden')).toBe('true');
    expect(inner.hasAttribute('inert')).toBe(true);
  });

  it('leaves aria-hidden="false" alone, and a value written again since stands', async () => {
    const { container } = render(
      <div data-component-kind="cart-view">
        <div data-testid="open" aria-hidden="false">
          <div data-testid="hiding" aria-hidden="true">
            <button type="button" data-testid="remove">Entfernen</button>
          </div>
        </div>
      </div>,
    );
    const open = container.querySelector<HTMLElement>('[data-testid="open"]')!;
    const hiding = container.querySelector<HTMLElement>('[data-testid="hiding"]')!;
    const remove = container.querySelector<HTMLElement>('[data-testid="remove"]')!;
    keepInSightForTest(remove);
    expect(open.getAttribute('aria-hidden')).toBe('false');
    expect(hiding.hasAttribute('aria-hidden')).toBe(false);
    hiding.setAttribute('aria-hidden', 'mixed');
    const { releaseKeptForTest } = await import('@/lib/commerce/shopRuntime');
    releaseKeptForTest(remove);
    expect(hiding.getAttribute('aria-hidden')).toBe('mixed');
    expect(open.getAttribute('aria-hidden')).toBe('false');
  });

  it('in the live cart: an inert, aria-hidden line no longer sold lets its remove button be pressed and announced, and the line is removed', async () => {
    const tree = designed(normalizeShopControl(cartControl(), 'de', 'node'), {
      'cart.line': (props) => ({ ...props, inert: true, 'aria-hidden': 'true' }),
    });
    const { container, getByTestId } = renderCart(tree, [
      { variantId: 'var_gone', quantity: 1 },
      { variantId: 'var_s_red', quantity: 1 },
    ]);
    await waitFor(() => expect(container.querySelector('[data-cart-line-unavailable]')).not.toBeNull());
    await waitFor(() => expect(container.querySelector('[data-cart-line-title]')).not.toBeNull());
    const gone = container.querySelector<HTMLElement>('[data-cart-line="var_gone"]')!;
    const sold = container.querySelector<HTMLElement>('[data-cart-line="var_s_red"]')!;
    // The design's attributes reached the page: the test reads the real thing.
    expect(sold.hasAttribute('inert')).toBe(true);
    expect(sold.getAttribute('aria-hidden')).toBe('true');
    expect(gone.hasAttribute('inert')).toBe(false);
    expect(gone.hasAttribute('aria-hidden')).toBe(false);
    act(() => {
      fireEvent.click(container.querySelector('button[data-cart-remove="var_gone"]')!);
    });
    await waitFor(() => expect(getByTestId('lines').textContent).toBe('[{"variantId":"var_s_red","quantity":1}]'));
  });
});

describe('the focus after a line is removed, when no other line has a remove button drawn', () => {
  it('goes to the lines, never to the page body', async () => {
    // The first line settles (no longer sold); the second never loads, so it has no remove button.
    const ds = dataSource({ getVariant: (id: string) => (id === 'var_gone' ? Promise.resolve(null) : new Promise(() => {})) } as Partial<CommerceDataSource>);
    const { container } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [
      { variantId: 'var_gone', quantity: 1 },
      { variantId: 'var_s_red', quantity: 1 },
    ], { ds });
    const remove = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_gone"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(container.querySelector('button[data-cart-remove="var_s_red"]')).toBeNull();
    act(() => remove.focus());
    act(() => {
      fireEvent.click(remove);
    });
    await waitFor(() => expect(container.querySelector('[data-cart-line="var_gone"]')).toBeNull());
    const lines = container.querySelector<HTMLElement>('[data-cart-lines]')!;
    expect(document.activeElement).toBe(lines);
    expect(document.activeElement).not.toBe(document.body);
    // Focusable by the script only: it joins no tab order.
    expect(lines.tabIndex).toBe(-1);
  });
});

describe("a line's remove button and quantity input", () => {
  it("are described by the line's title, with ids unique per line and per control", async () => {
    const { container } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [
      { variantId: 'var_s_red', quantity: 1 },
      { variantId: 'var_s_blue', quantity: 1 },
    ], { twice: true });
    await waitFor(() => expect(container.querySelectorAll('[data-cart-line-title]')).toHaveLength(4));
    const ids: string[] = [];
    for (const line of container.querySelectorAll<HTMLElement>('[data-cart-line]')) {
      const title = line.querySelector<HTMLElement>('[data-cart-line-title]')!;
      expect(title.id).not.toBe('');
      ids.push(title.id);
      for (const control of [line.querySelector('button[data-cart-remove]')!, line.querySelector('input[data-cart-qty]')!]) {
        expect(control.getAttribute('aria-describedby')).toBe(title.id);
        expect(document.getElementById(title.id)?.textContent).toBe(title.textContent);
      }
    }
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    // No id on the page twice.
    const all = [...container.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("a line no longer sold is described by its sentence", async () => {
    const { container } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [{ variantId: 'var_gone', quantity: 1 }]);
    const note = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-cart-line-unavailable]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(container.querySelector('button[data-cart-remove="var_gone"]')!.getAttribute('aria-describedby')).toBe(note.id);
  });
});

describe('the published cart island', () => {
  it('normalises its control once, not again on a cart change or a parent re-render', async () => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify([{ variantId: 'var_s_red', quantity: 1 }]));
    const node = { id: 'c', type: 'div', props: { 'data-component-kind': 'cart-view' } } as unknown as ComponentNode;
    let add: (() => void) | null = null;
    const Adder = () => {
      const cart = useCart();
      add = () => cart.setQuantity('var_s_red', 4);
      return null;
    };
    const Page = ({ tick }: { tick: number }) => (
      <CommerceDataSourceContext.Provider value={new InMemoryCommerceDataSource()}>
        <ShopLocaleContext.Provider value="de">
          <CartProvider>
            <span data-tick={tick} />
            <CommerceIsland kind="cart-view" node={node} scope={createScope()} />
            <Adder />
          </CartProvider>
        </ShopLocaleContext.Provider>
      </CommerceDataSourceContext.Provider>
    );
    const view = render(<Page tick={0} />);
    const qty = await quantityField(view.container);
    const cartCalls = () => vi.mocked(parts.normalizeShopControl).mock.calls.filter(([, , , kind]) => kind === 'cart-view').length;
    const before = cartCalls();
    expect(before).toBeGreaterThan(0);
    act(() => add!());
    await waitFor(() => expect(qty.value).toBe('4'));
    view.rerender(<Page tick={1} />);
    view.rerender(<Page tick={2} />);
    expect(cartCalls()).toBe(before);
  });
});
