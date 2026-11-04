// The re-review of the designable add to cart and cart (docs/plans/2026-11-02-designable-shop-controls.md,
// slice 2): the island owns whether its buttons and inputs can be pressed, typed
// into and reached by the keyboard (stored copies never reach the page, and the
// normaliser drops them); a remove button kept in sight takes the press through
// `pointer-events: none`; controls written before parts still work on a published
// page; a part's text binding reads the product there; the live error, loading
// and no-option states; the quantity input never removes a line; the subtotal
// says when it is partial; and focus after a removal.
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import ComponentModel, { type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { createScope } from '@/lib/bindings/resolver/scope';
import { CommerceDataSourceContext } from '@/lib/commerce/context';
import { InMemoryCommerceDataSource } from '@/lib/commerce/inMemoryCommerceDataSource';
import { CART_STORAGE_KEY, CartProvider, useCart } from '@/lib/commerce/cart';
import { SelectedVariantContext, type SelectionState } from '@/lib/commerce/selection';
import { ShopLocaleContext } from '@/lib/commerce/shopRuntime';
import { normalizeShopControl, shopPartRoleOf, type ShopLocale, type ShopTreeNode } from '@/lib/commerce/parts';
import type { CommerceDataSource } from '@/lib/commerce/provider';
import type { ComponentNode, CommerceServerRepository } from '@/lib/renderer/publish/hydrateBindings';
import type { CmsReadRepository } from '@/server/cms';
import { renderPublishedPage } from '@/lib/renderer/server/renderPublishedPage';
import CartView from '../CartView';
import AddToCartButton from '../AddToCartButton';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
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

const cartControl = (): ShopTreeNode => ({ id: 'c', type: 'div', componentType: 'host', props: { 'data-component-kind': 'cart-view' } });
const addToCartControl = (): ShopTreeNode => ({ id: 'a', type: 'div', componentType: 'host', props: { 'data-component-kind': 'add-to-cart' } });

/** What a designer (or an accident) might store on an interactive part. */
const LOCKED = { disabled: true, tabindex: '-1', tabIndex: -1, 'aria-disabled': 'true' };
const LOCKED_INPUT = { ...LOCKED, readonly: true, readOnly: true, max: 1 };

const SELECTION: SelectionState = {
  selection: {},
  variant: { id: 'var_s_red', productId: 'prod_tee', title: 'Small / Red', optionValues: [] } as never,
  setOptionValue: () => {},
};

const BP = 'bp';
const ALL_BP = [{ id: BP, minWidth: 0, label: 'BP' }];

/** Through the Preview's renderer, which hands the island its children as stored: no normaliser between. */
function renderStored(tree: ShopTreeNode, options: { lines?: { variantId: string; quantity: number }[]; ds?: CommerceDataSource; selection?: SelectionState } = {}) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(options.lines ?? []));
  const Probe = () => <span data-testid="lines">{JSON.stringify(useCart().lines)}</span>;
  const component = ComponentModel.create(tree as never);
  return render(
    <CommerceDataSourceContext.Provider value={options.ds ?? new InMemoryCommerceDataSource()}>
      <ShopLocaleContext.Provider value="de">
        <CartProvider>
          <SelectedVariantContext.Provider value={options.selection ?? SELECTION}>
            <HeadlessComponentRenderer component={component as ComponentInstance} breakpointId={BP} allBreakpoints={ALL_BP} scope={createScope()} />
          </SelectedVariantContext.Provider>
          <Probe />
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>,
  );
}

function renderCart(node: ShopTreeNode, lines: { variantId: string; quantity: number }[], options: { ds?: CommerceDataSource; locale?: ShopLocale } = {}) {
  window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines));
  const Probe = () => <span data-testid="lines">{JSON.stringify(useCart().lines)}</span>;
  return render(
    <CommerceDataSourceContext.Provider value={options.ds ?? new InMemoryCommerceDataSource()}>
      <ShopLocaleContext.Provider value={options.locale ?? 'de'}>
        <CartProvider>
          <CartView node={node as unknown as ComponentInstance} scope={createScope()} hostProps={{ 'data-component-kind': 'cart-view' }} />
          <Probe />
        </CartProvider>
      </ShopLocaleContext.Provider>
    </CommerceDataSourceContext.Provider>,
  );
}

function renderAddToCart(node: ShopTreeNode, ds: CommerceDataSource, selection: SelectionState = SELECTION) {
  const Probe = () => <span data-testid="lines">{JSON.stringify(useCart().lines)}</span>;
  return render(
    <CommerceDataSourceContext.Provider value={ds}>
      <ShopLocaleContext.Provider value="de">
        <CartProvider>
          <SelectedVariantContext.Provider value={selection}>
            <AddToCartButton node={node as unknown as ComponentInstance} scope={createScope()} />
          </SelectedVariantContext.Provider>
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

describe('the island owns what its buttons and inputs do', () => {
  it('a stored disabled or tabindex never reaches the remove button or the quantity input: it removes, types and takes the focus', async () => {
    const tree = designed(normalizeShopControl(cartControl(), 'de', 'snapshot'), {
      'cart.line-remove': (props) => ({ ...props, ...LOCKED }),
      'cart.line-qty-input': (props) => ({ ...props, ...LOCKED_INPUT }),
    });
    const { container, getByTestId } = renderStored(tree, { lines: [{ variantId: 'var_s_red', quantity: 2 }] });
    const qty = await waitFor(() => {
      const found = container.querySelector<HTMLInputElement>('input[data-cart-qty="var_s_red"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(qty.disabled).toBe(false);
    expect(qty.readOnly).toBe(false);
    for (const attribute of ['tabindex', 'aria-disabled', 'max', 'readonly', 'disabled']) expect(qty.hasAttribute(attribute)).toBe(false);
    act(() => qty.focus());
    expect(document.activeElement).toBe(qty);
    act(() => {
      fireEvent.change(qty, { target: { value: '3' } });
    });
    await waitFor(() => expect(getByTestId('lines').textContent).toContain('"quantity":3'));

    const remove = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_s_red"]')!;
    expect(remove.disabled).toBe(false);
    for (const attribute of ['tabindex', 'aria-disabled', 'disabled']) expect(remove.hasAttribute(attribute)).toBe(false);
    act(() => remove.focus());
    expect(document.activeElement).toBe(remove);
    act(() => {
      fireEvent.click(remove);
    });
    await waitFor(() => expect(getByTestId('lines').textContent).toBe('[]'));
  });

  it('a stored disabled or tabindex never reaches the add to cart button: it adds and takes the focus', async () => {
    const tree = designed(normalizeShopControl(addToCartControl(), 'de', 'snapshot'), {
      'addToCart.button': (props) => ({ ...props, ...LOCKED }),
    });
    const { container, getByTestId } = renderStored(tree);
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]');
      expect(found?.disabled).toBe(false);
      return found!;
    });
    for (const attribute of ['tabindex', 'aria-disabled']) expect(button.hasAttribute(attribute)).toBe(false);
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    act(() => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(getByTestId('lines').textContent).toContain('"variantId":"var_s_red"'));
  });

  it('draws no aria-disabled of its own on the add to cart button: native disabled says it', () => {
    const { container } = renderAddToCart(normalizeShopControl(addToCartControl(), 'de', 'node'), dataSource({}), { ...SELECTION, variant: null });
    const button = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')!;
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });

  it('the normaliser drops them from the stored page, and a second pass changes nothing', () => {
    const cart = normalizeShopControl(
      designed(normalizeShopControl(cartControl(), 'de', 'node'), {
        'cart.line-remove': (props) => ({ ...props, ...LOCKED }),
        'cart.line-qty-input': (props) => ({ ...props, ...LOCKED_INPUT }),
      }),
      'de',
      'node',
    );
    for (const role of ['cart.line-remove', 'cart.line-qty-input']) {
      const props = byRole(cart.children!, role)!.props!;
      for (const key of Object.keys(LOCKED_INPUT)) expect(props).not.toHaveProperty(key);
    }
    expect(normalizeShopControl(cart, 'de', 'node')).toBe(cart);
    const addToCart = normalizeShopControl(designed(normalizeShopControl(addToCartControl(), 'de', 'node'), { 'addToCart.button': (props) => ({ ...props, ...LOCKED }) }), 'de', 'node');
    for (const key of Object.keys(LOCKED)) expect(byRole(addToCart.children!, 'addToCart.button')!.props).not.toHaveProperty(key);
  });
});

describe('a remove button kept in sight', () => {
  it('takes the press through pointer-events none on it and on its line, and the line gets its own back after', async () => {
    const tree = designed(normalizeShopControl(cartControl(), 'de', 'node'), {
      'cart.line': (props) => ({ ...props, style: { ...(props.style as object), pointerEvents: 'none' } }),
      'cart.line-remove': (props) => ({ ...props, style: { ...(props.style as object), pointerEvents: 'none' } }),
    });
    const { container, unmount } = renderCart(tree, [{ variantId: 'var_gone', quantity: 1 }]);
    await waitFor(() => expect(container.querySelector('[data-cart-line-unavailable]')).not.toBeNull());
    const remove = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_gone"]')!;
    const line = remove.closest<HTMLElement>('[data-cart-line]')!;
    for (const element of [remove, line]) {
      expect(element.style.getPropertyValue('pointer-events')).toBe('auto');
      expect(element.style.getPropertyPriority('pointer-events')).toBe('important');
    }
    // A wrapper that never stopped presses is left alone.
    expect(line.parentElement!.style.getPropertyValue('pointer-events')).toBe('');
    unmount();
    // The design's own value comes back when the part lets go.
    expect(line.style.getPropertyValue('pointer-events')).toBe('none');
    expect(line.style.getPropertyPriority('pointer-events')).toBe('');
  });

  it('pins nothing on a line that is still sold', async () => {
    const tree = designed(normalizeShopControl(cartControl(), 'de', 'node'), {
      'cart.line-remove': (props) => ({ ...props, style: { ...(props.style as object), pointerEvents: 'none' } }),
    });
    const { container } = renderCart(tree, [{ variantId: 'var_s_red', quantity: 1 }]);
    await waitFor(() => expect(container.querySelector('[data-cart-line-title]')).not.toBeNull());
    const remove = container.querySelector<HTMLButtonElement>('button[data-cart-remove="var_s_red"]')!;
    expect(remove.style.getPropertyPriority('pointer-events')).toBe('');
  });
});

describe('controls written before parts, live with no normalised tree', () => {
  it("the cart's old empty message shows", () => {
    const { container } = renderCart({ id: 'c', type: 'div', props: { 'data-component-kind': 'cart-view', emptyContent: 'X' } }, []);
    expect(container.querySelector('[data-cart-empty]')?.textContent).toBe('X');
    expect(container.querySelector('[data-cart-subtotal]')).toBeNull();
  });

  it("the add to cart's old label shows and the button adds", async () => {
    const legacy = { id: 'a', type: 'div', props: { 'data-component-kind': 'add-to-cart', label: 'Kaufen' } };
    const { container, getByTestId } = renderAddToCart(legacy, dataSource({}));
    const button = await waitFor(() => {
      const found = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]');
      expect(found?.disabled).toBe(false);
      return found!;
    });
    expect(button.textContent).toBe('Kaufen');
    act(() => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(getByTestId('lines').textContent).toContain('"variantId":"var_s_red"'));
  });
});

describe('normalising the add to cart', () => {
  it('twice gives what once gives, for the whole tree with legacy label and bindings', () => {
    const binding = { mode: 'read', expression: '{{product.title}}' };
    const legacy: ShopTreeNode = { id: 'a', type: 'div', props: { 'data-component-kind': 'add-to-cart', label: 'Kaufen' }, bindings: { label: binding } };
    for (const shape of ['node', 'snapshot'] as const) {
      const once = normalizeShopControl(legacy, 'de', shape);
      expect(normalizeShopControl(once, 'de', shape)).toBe(once);
      expect(JSON.parse(JSON.stringify(normalizeShopControl(JSON.parse(JSON.stringify(once)), 'de', shape)))).toEqual(JSON.parse(JSON.stringify(once)));
      // A legacy binding written onto a control that has parts already moves once, then settles.
      const rebound = normalizeShopControl({ ...once, bindings: { label: { mode: 'read', expression: '{{product.handle}}' } } }, 'de', shape);
      expect(normalizeShopControl(rebound, 'de', shape)).toBe(rebound);
    }
  });
});

// A published page with a product detail around the controls: a part's text binding reads that product.
const TEE = { id: 'prod_tee', handle: 'classic-tee', title: 'Classic Tee', description: null, taxClass: null };
const repos = {
  cmsRepo: { listRows: async () => ({ rows: [], total: 0 }), getRow: async () => null } as unknown as CmsReadRepository,
  commerceRepo: {
    listProducts: async () => ({ products: [TEE], total: 1 }),
    getProductByHandle: async (handle: string) => (handle === 'classic-tee' ? TEE : null),
    listVariants: async () => [{ id: 'var_s_red', productId: 'prod_tee', title: 'Small / Red', sku: 'TEE-S-RED', optionValues: [] }],
    getPrices: async () => [{ variantId: 'var_s_red', amountCents: 2500, currency: 'eur' }],
    getAvailability: async () => ({ variantId: 'var_s_red', locationId: 'all', availableQuantity: 5, limited: true, stale: false }),
  } as unknown as CommerceServerRepository,
};

describe('a part bound to the product, published', () => {
  const bound = { mode: 'read', expression: '{{product.title}}' };

  async function publishWithin(control: ShopTreeNode) {
    const detail = {
      id: 'detail',
      type: 'div',
      props: { 'data-component-kind': 'product-detail' },
      bindings: { product: { mode: 'read', expression: 'product' } },
      children: [control],
    };
    const { body } = await renderPublishedPage({ root: { type: 'div', id: 'root', children: [detail] } as ComponentNode, pageParams: { handle: 'classic-tee' }, ...repos, consent: { language: 'de' } });
    return render(<>{body}</>);
  }

  it("the add to cart's label reads it", async () => {
    const tree = designed(normalizeShopControl(addToCartControl(), 'de', 'node'), {});
    const label = byRole(tree.children!, 'addToCart.button-label')!;
    label.bindings = { children: bound };
    const { container } = await publishWithin(tree);
    await waitFor(() => expect(container.querySelector('button[data-add-to-cart]')?.textContent).toBe('Classic Tee'));
  });

  it("the checkout's label reads it", async () => {
    const tree = normalizeShopControl({ id: 'co', type: 'div', props: { 'data-component-kind': 'checkout-button' } } as ShopTreeNode, 'de', 'node');
    byRole(tree.children!, 'checkout.button-label')!.bindings = { children: bound };
    const { container } = await publishWithin(tree);
    await waitFor(() => expect(container.querySelector('button[data-checkout]')?.textContent).toBe('Classic Tee'));
  });
});

describe('the live states', () => {
  it('a line that failed to load says so in plain words, keeps its remove button and logs the reason', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ds = dataSource({ getVariant: async () => Promise.reject(new Error('database is down')) });
    const { container } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [{ variantId: 'var_s_red', quantity: 1 }], { ds });
    const error = await waitFor(() => {
      const found = container.querySelector('[data-cart-line-error]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(error.textContent).toBe('Dieser Artikel kann gerade nicht geladen werden.');
    // Announced through the status region around it, which was on the page before it (not on the part, so not twice).
    expect(error.parentElement?.getAttribute('role')).toBe('status');
    expect(error.getAttribute('role')).toBeNull();
    expect(container.textContent).not.toContain('database is down');
    expect(container.querySelector('button[data-cart-remove="var_s_red"]')).not.toBeNull();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not be loaded'), expect.any(Error));
  });

  it('the add to cart with no option chosen is disabled, with its label and no error', () => {
    const { container } = renderAddToCart(normalizeShopControl(addToCartControl(), 'de', 'node'), dataSource({}), { ...SELECTION, variant: null });
    const button = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('In den Warenkorb');
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(container.querySelector('[data-add-to-cart-error]')).toBeNull();
  });

  it('the add to cart while checking is disabled and busy', async () => {
    const ds = dataSource({ getAvailability: () => new Promise(() => {}) });
    const { container } = renderAddToCart(normalizeShopControl(addToCartControl(), 'de', 'node'), ds);
    await waitFor(() => expect(container.querySelector('button[data-add-to-cart]')?.getAttribute('aria-busy')).toBe('true'));
    expect((container.querySelector('button[data-add-to-cart]') as HTMLButtonElement).disabled).toBe(true);
    expect(container.querySelector('[data-add-to-cart-error]')).toBeNull();
  });

  it('the add to cart after a failed check is disabled and says so in plain words', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ds = dataSource({ getAvailability: async () => Promise.reject(new Error('timeout')) });
    const { container } = renderAddToCart(normalizeShopControl(addToCartControl(), 'de', 'node'), ds);
    await waitFor(() =>
      expect(container.querySelector('[data-add-to-cart-error]')?.textContent).toBe('Die Verfügbarkeit kann gerade nicht geprüft werden. Bitte versuchen Sie es später erneut.'),
    );
    expect(container.textContent).not.toContain('timeout');
    const button = container.querySelector<HTMLButtonElement>('button[data-add-to-cart]')!;
    expect(button.disabled).toBe(true);
    expect(button.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('the quantity input', () => {
  it('never removes a line: zero and below are one, a blank keeps the quantity', async () => {
    const { container, getByTestId } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), [{ variantId: 'var_s_red', quantity: 2 }]);
    const qty = await waitFor(() => {
      const found = container.querySelector<HTMLInputElement>('input[data-cart-qty="var_s_red"]');
      expect(found).not.toBeNull();
      return found!;
    });
    act(() => {
      fireEvent.change(qty, { target: { value: '' } });
    });
    expect(getByTestId('lines').textContent).toBe('[{"variantId":"var_s_red","quantity":2}]');
    // The field stays blank while edited (CartParts.thirdreview.test.tsx); leaving it shows the quantity.
    act(() => {
      fireEvent.blur(qty);
    });
    expect(qty.value).toBe('2');
    for (const typed of ['0', '-2']) {
      act(() => {
        fireEvent.change(qty, { target: { value: '5' } });
      });
      await waitFor(() => expect(getByTestId('lines').textContent).toContain('"quantity":5'));
      act(() => {
        fireEvent.change(qty, { target: { value: typed } });
      });
      await waitFor(() => expect(getByTestId('lines').textContent).toBe('[{"variantId":"var_s_red","quantity":1}]'));
    }
    expect(container.querySelector('[data-cart-line="var_s_red"]')).not.toBeNull();
  });
});

describe('the subtotal', () => {
  const notes = {
    de: { estimate: 'Nur eine Schätzung. Die Endsumme wird an der Kasse berechnet.', partial: 'Noch ladende oder nicht verfügbare Artikel sind nicht eingerechnet.', label: 'Zwischensumme (geschätzt): ' },
    en: { estimate: 'Estimate only. The final total is calculated at checkout.', partial: 'Items still loading or not available are not counted.', label: 'Estimated subtotal: ' },
  } as const;

  for (const locale of ['de', 'en'] as const) {
    it(`shows a placeholder, never a bare 0.00, before any price is known, and says it is partial (${locale})`, () => {
      const ds = dataSource({ getVariant: () => new Promise(() => {}) });
      const { container } = renderCart(normalizeShopControl(cartControl(), locale, 'node'), [{ variantId: 'var_s_red', quantity: 1 }], { ds, locale });
      expect(container.querySelector('[data-cart-subtotal]')?.textContent).toBe(`${notes[locale].label}-`);
      expect(container.querySelector('[data-cart-subtotal]')?.hasAttribute('data-cart-subtotal-partial')).toBe(true);
      expect(container.querySelector('[data-cart-subtotal-note]')?.textContent).toBe(`${notes[locale].estimate} ${notes[locale].partial}`);
    });

    it(`says it is partial while a line is not counted, and only then (${locale})`, async () => {
      const { container } = renderCart(normalizeShopControl(cartControl(), locale, 'node'), [
        { variantId: 'var_s_red', quantity: 1 },
        { variantId: 'var_gone', quantity: 1 },
      ], { locale });
      await waitFor(() => expect(container.querySelector('[data-cart-line-unavailable]')).not.toBeNull());
      await waitFor(() => expect(container.querySelector('[data-cart-subtotal]')?.textContent).toMatch(/25/));
      expect(container.querySelector('[data-cart-subtotal-note]')?.textContent).toBe(`${notes[locale].estimate} ${notes[locale].partial}`);
      act(() => {
        fireEvent.click(container.querySelector('button[data-cart-remove="var_gone"]')!);
      });
      await waitFor(() => expect(container.querySelector('[data-cart-subtotal-note]')?.textContent).toBe(notes[locale].estimate));
      expect(container.querySelector('[data-cart-subtotal]')?.hasAttribute('data-cart-subtotal-partial')).toBe(false);
    });
  }
});

describe('the focus after a line is removed', () => {
  const three = [
    { variantId: 'var_s_red', quantity: 1 },
    { variantId: 'var_s_blue', quantity: 1 },
    { variantId: 'var_m_red', quantity: 1 },
  ];
  const removeOf = (container: HTMLElement, id: string) => container.querySelector<HTMLButtonElement>(`button[data-cart-remove="${id}"]`)!;

  it("goes to the next line's remove button, else the previous one's, else the empty message", async () => {
    const { container } = renderCart(normalizeShopControl(cartControl(), 'de', 'node'), three);
    await waitFor(() => expect(container.querySelectorAll('[data-cart-line-title]')).toHaveLength(3));
    act(() => {
      fireEvent.click(removeOf(container, 'var_s_red'));
    });
    await waitFor(() => expect(container.querySelector('[data-cart-line="var_s_red"]')).toBeNull());
    expect(document.activeElement).toBe(removeOf(container, 'var_s_blue'));
    // The last line: the previous one's.
    act(() => {
      fireEvent.click(removeOf(container, 'var_m_red'));
    });
    await waitFor(() => expect(container.querySelector('[data-cart-line="var_m_red"]')).toBeNull());
    expect(document.activeElement).toBe(removeOf(container, 'var_s_blue'));
    act(() => {
      fireEvent.click(removeOf(container, 'var_s_blue'));
    });
    const empty = await waitFor(() => {
      const found = container.querySelector<HTMLElement>('[data-cart-empty]');
      expect(found).not.toBeNull();
      return found!;
    });
    await waitFor(() => expect(document.activeElement).toBe(empty));
    // Focusable by the script only: it joins no tab order.
    expect(empty.tabIndex).toBe(-1);
  });
});
